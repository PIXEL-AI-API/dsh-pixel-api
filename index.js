// PIXEL API — DeepSeek Harness plugin (host half).
//
// Logs in to the Pixel main site (https://api.ai-pixel.online) with the user's
// account, then mirrors the site playground's group picker as DSH provider
// routes: each site group becomes one `pixel/<group>` route whose models come
// from /api/user/models?group=<key>. Requests stream through the session-only
// /pg/chat/completions endpoint — the site bills the login user's wallet, no
// API key is ever created or sent.
//
// Credential layout (provider-managed credentials, never logged or written to
// settings):
//   PIXEL_API_PASSWORD — account password, stored so a restart can re-login
//   PIXEL_API_REFRESH  — the `new_api_refresh` cookie value; the session's
//                        durable secret, rotated by /api/user/auth/refresh
//   PIXEL_API_2FA      — one-shot TOTP code consumed while a login challenge
//                        is pending; unset immediately after use
// Settings namespace `pixel-api` holds only non-secret state: the username and
// a small `auth` status object the client settings page renders.

// The host runtime's @deepseek-ai/* packages live inside the app's asar
// archive. NTFS junctions are kernel-level reparse points and cannot
// traverse into an archive file, so a node_modules junction cannot reach
// them — but the Electron fs patch resolves archive-internal paths passed
// directly to fs. Import the real module instances by absolute path derived
// from process.execPath (the spawned host child runs the app binary in
// ELECTRON_RUN_AS_NODE mode, so execPath = <install>/DeepSeek Harness.exe).
// Same archive path = same module cache entry = identical class instances,
// so instanceof checks (LlmError etc.) hold against the host's own copies.
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'

// Opt-in local diagnostic trail (~/.dsh/pixel-api/debug.log), enabled by the
// `debug` config field or PIXEL_API_DEBUG=1. Records control flow and HTTP
// status codes only — never tokens, cookies, passwords or bodies.
let DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.PIXEL_API_DEBUG ?? '')
const DEBUG_DIR = join(homedir(), '.dsh', 'pixel-api')
const DEBUG_LOG = join(DEBUG_DIR, 'debug.log')
function trace(...parts) {
  if (!DEBUG_ENABLED) return
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    try {
      if (statSync(DEBUG_LOG).size > 512 * 1024) renameSync(DEBUG_LOG, DEBUG_LOG + '.1')
    } catch {
      // first write
    }
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break the plugin
  }
}

// The runtime's @deepseek-ai/* packages resolve by bare specifier when the
// profile provides them (dsh CLI / npm installs). A Desktop install keeps them
// inside app.asar, which a profile-level node_modules junction cannot reach, so
// fall back to the archive path derived from the running binary.
const HOST_MODULES = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules')
// Archive path first (Desktop layout, always present when the binary is the
// Desktop app), then the bare specifier for runtimes whose own resolution
// reaches the dsh install (CLI / npm layouts).
const hostImport = async (id, file) => {
  const attempts = [pathToFileURL(join(HOST_MODULES, id, file)).href, id]
  const failures = []
  for (const target of attempts) {
    try {
      return await import(target)
    } catch (error) {
      failures.push(`${target}: ${error?.message ?? error}`)
    }
  }
  throw new Error(`pixel-api: cannot load "${id}" from this Harness install — ${failures.join(' | ')}`)
}

const {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
} = await hostImport('@deepseek-ai/dsh-llm', 'lib/index.js')
const { idleWatchdog, timeoutOf } = await hostImport('@deepseek-ai/dsh-timeout', 'lib/index.js')
const { default: z } = await hostImport('@deepseek-ai/schemastery', 'lib/index.mjs')

// `@deepseek-ai/dsh-attachment` is optional: a runtime that predates it still
// loads this plugin (image input then reports a clear error at send time
// instead of failing the whole module at import).
const attachment = await hostImport('@deepseek-ai/dsh-attachment', 'lib/index.js')
  .catch(() => undefined)
const requestImageDimensions = attachment?.requestImageDimensions

// Local mirror of the runtime's aspect-preserving scale, used when an older
// runtime does not export it. Kept byte-for-byte equivalent to
// dsh-attachment's requestImageDimensions so both paths agree exactly.
function fallbackImageDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

export const name = 'pixel-api'
export const inject = ['llm']

// Runtime 0.2.2: a plugin's settings namespace IS its composition entry id
// (this plugin's `id: pixel-api` in cordis.patch.yml). Only schema fields
// marked `.volatile()` are editable through settings.mutate — volatile edits
// commit into live config cells in place without a fiber restart.
// Account summary shown on the settings page. Amounts are pre-formatted with
// the site's own display settings (/api/status), so the page never guesses a
// currency or quota unit.
const EMPTY_PROFILE = { id: 0, name: '', group: '', balance: '', used: '', requests: 0, updatedAt: 0 }
const Profile = z.object({
  id: z.number().default(0),
  name: z.string().default(''),
  group: z.string().default(''),
  balance: z.string().default(''),
  used: z.string().default(''),
  requests: z.number().default(0),
  updatedAt: z.number().default(0),
}).default({ ...EMPTY_PROFILE })

// Context capacity declared for every PIXEL model unless an override names it.
// The site publishes no per-model limit, so this is an assumption the user can
// tune on the settings page. Harness compaction needs a declared capacity: a
// route without one cannot be switched to mid-session
// (MODEL_SWITCH_COMPACTION_FAILED) and never compacts automatically.
const DEFAULT_CONTEXT_WINDOW = 272_000

// ---------------------------------------------------------------------------
// Self-update: stable release tags (vMAJOR.MINOR.PATCH) on the repository this
// copy was installed from, applied through the Harness plugin manager — the
// same replacement its Discover page performs for a Git-installed bundle.
// ---------------------------------------------------------------------------

const PACKAGE_NAME = 'dsh-pixel-api'
// Where the check reads tags when this copy did not come from Git: a local
// link or an npm copy cannot be updated from here, but the page still shows
// the newest release. PIXEL_API_UPDATE_REPO points it elsewhere (a fork, or a
// local repository in tests).
const CANONICAL_REPOSITORY = process.env.PIXEL_API_UPDATE_REPO || 'https://github.com/PIXEL-AI-API/dsh-pixel-api'
const UPDATE_CHECK_TIMEOUT_MS = 20_000
const EMPTY_UPDATE = {
  state: 'idle', message: '', current: '', latest: '', target: '', spec: '',
  checkedAt: 0, servedCheckAt: 0, servedApplyAt: 0,
}

// The running copy's manifest version — the one updateBundle replaces.
const OWN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '')
  } catch {
    return ''
  }
})()

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const FULL_COMMIT = /^[0-9a-f]{40}$/i
const RELEASE_TAG = /^refs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/

// Whether stable `candidate` is newer than `current` (which may be a prerelease).
function newerRelease(candidate, current) {
  const a = SEMVER.exec(candidate ?? '')
  const b = SEMVER.exec(current ?? '')
  if (!a || !b || a[4] !== undefined) return false
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i])
  }
  return b[4] !== undefined
}

// The newest stable release among tag refs ([sha, ref] pairs). An annotated
// tag lists its tag object and, as `^{}`, the commit it points to; a
// lightweight tag lists the commit itself.
function newestRelease(refs) {
  const tags = new Map()
  for (const [sha, ref] of refs) {
    const match = RELEASE_TAG.exec(ref)
    if (!match || !FULL_COMMIT.test(sha)) continue
    const entry = tags.get(match[1]) ?? {}
    entry[match[2] ? 'peeled' : 'direct'] = sha.toLowerCase()
    tags.set(match[1], entry)
  }
  let newest
  for (const [version, entry] of tags) {
    if (newest === undefined || newerRelease(version, newest.version)) {
      newest = { version, commit: entry.peeled ?? entry.direct }
    }
  }
  return newest
}

// The repository a saved Git spec installs from, in a form `git ls-remote`
// reads without credentials: host shortcuts and scp-like SSH become HTTPS.
function repositoryOf(source) {
  if (typeof source !== 'string') return undefined
  const base = source.split('#')[0].trim()
  const shortcut = /^(github|gitlab|bitbucket):(.+)$/i.exec(base)
  if (shortcut) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[shortcut[1].toLowerCase()]
    return `https://${host}/${shortcut[2].replace(/\.git$/i, '')}`
  }
  const url = base.replace(/^git\+/i, '')
  const scp = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i.exec(url)
  if (scp) return `https://${scp[1]}/${scp[2].replace(/\.git$/i, '')}`
  if (/^https?:\/\//i.test(url)) return url.replace(/\.git$/i, '')
  if (/^file:\/\//i.test(url)) return url
  return undefined
}

// The update target: the installed copy's own saved spec with only the commit
// replaced. The plugin manager accepts a Git update only for the same
// repository and `path:` directory, and compares the repository path
// case-sensitively, so the URL is never rebuilt.
function retargetGitSpec(source, commit) {
  const hash = source.indexOf('#')
  if (hash === -1 || !FULL_COMMIT.test(commit)) return undefined
  const paths = source.slice(hash + 1).split('&').filter((part) => part.startsWith('path:'))
  return `${source.slice(0, hash)}#${[commit, ...paths].join('&')}`
}

// Tag refs through git, which carries the user's Git proxy and network
// settings — the same path pnpm takes to fetch the update itself.
function gitTagRefs(repository) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', 'ls-remote', '--tags', '--', repository], {
      timeout: UPDATE_CHECK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(String(stdout).split(/\r?\n/).map((line) => line.split('\t')).filter((parts) => parts.length === 2))
    })
  })
}

// The same ref advertisement over git's smart HTTP, for when git cannot run.
async function httpTagRefs(repository) {
  const res = await fetch(`${repository.replace(/\/+$/, '')}.git/info/refs?service=git-upload-pack`, {
    headers: { 'user-agent': 'git/2.0 dsh-pixel-api' },
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const refs = []
  for (let pos = 0; pos + 4 <= buf.length;) {
    const length = Number.parseInt(buf.toString('ascii', pos, pos + 4), 16)
    if (!Number.isFinite(length)) break
    if (length < 4) {
      pos += 4 // flush / delimiter packet
      continue
    }
    const line = buf.toString('utf8', pos + 4, pos + length).replace(/\n$/, '')
    pos += length
    if (line.startsWith('#') || line.length < 42) continue
    refs.push([line.slice(0, 40), line.slice(41).split('\0')[0]])
  }
  return refs
}

// One short line for the settings page; no URL user information can appear:
// the plugin manager strips it from saved specs.
function describeFailure(error) {
  if (error?.code === 'ENOENT') return '找不到 git 命令'
  if (error?.killed || error?.name === 'TimeoutError') return '连接超时'
  const lines = String(error?.stderr || error?.message || error).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return (lines.at(-1) ?? '未知原因').slice(0, 200)
}

async function remoteTagRefs(repository) {
  try {
    return await gitTagRefs(repository)
  } catch (gitError) {
    if (!/^https:\/\//i.test(repository)) throw gitError
    try {
      return await httpTagRefs(repository)
    } catch (httpError) {
      throw new Error(`git：${describeFailure(gitError)}；https：${describeFailure(httpError)}`)
    }
  }
}

export const Config = z.object({
  username: z.string().default('').volatile(),
  // Context window (tokens) declared to the Harness for PIXEL models.
  contextWindow: z.natural().default(DEFAULT_CONTEXT_WINDOW).volatile(),
  // Per-model context windows keyed by an exact model id or a `prefix*`
  // pattern (case-insensitive; exact beats prefix, longer prefix wins).
  contextWindows: z.dict(z.natural()).default({}).volatile(),
  // Sends GPT's encrypted reasoning back with each later step. Off by default:
  // the site accepts it only from the upstream account that produced it, so a
  // group that spreads requests over several accounts fails them.
  openaiReasoningReplay: z.boolean().default(false).volatile(),
  // Settings page "刷新" bumps this; the host refetches profile + groups.
  refreshAt: z.number().default(0).volatile(),
  // Settings page "退出登录" bumps this; the host revokes the site session.
  signOutAt: z.number().default(0).volatile(),
  // Writes ~/.dsh/pixel-api/debug.log (no secrets) for troubleshooting.
  debug: z.boolean().default(false).volatile(),
  auth: z.object({
    state: z.string().default('none'),
    message: z.string().default(''),
    user: z.string().default(''),
    // Legacy field (group display names); no longer written.
    groups: z.array(z.string()).default([]),
    groupCount: z.number().default(0),
    models: z.number().default(-1),
    // Highest signOutAt request already served; kept so an ordinary reload
    // never replays a sign-out whose revoke already happened.
    signOutAt: z.number().default(0),
    profile: Profile,
  }).default({ state: 'none', message: '', user: '', groups: [], groupCount: 0, models: -1, signOutAt: 0, profile: { ...EMPTY_PROFILE } }).volatile(),
  // Settings page "检查更新" / "更新" bump these; the host serves each newer
  // value once and records the served value in `update`.
  updateCheckAt: z.number().default(0).volatile(),
  updateApplyAt: z.number().default(0).volatile(),
  // Host-written update status the settings page renders. The served stamps
  // persist so a restart — including the one an update causes — never
  // repeats a check or an update.
  update: z.object({
    state: z.string().default('idle'),
    message: z.string().default(''),
    current: z.string().default(''),
    latest: z.string().default(''),
    target: z.string().default(''),
    spec: z.string().default(''),
    checkedAt: z.number().default(0),
    servedCheckAt: z.number().default(0),
    servedApplyAt: z.number().default(0),
  }).default({ ...EMPTY_UPDATE }).volatile(),
})

const SITE = 'https://api.ai-pixel.online'
// Every request to the site refuses redirects: a 307/308 would re-send the
// Authorization header (and a login body, password included) to whatever host
// the redirect names.
const siteFetch = (url, init) => fetch(url, { redirect: 'error', ...init })
// A site call that did not succeed; `status` is 0 when the site could not be
// reached at all. Only a 4xx other than 408, 409 and 429 is the site refusing
// outright. Anything else may pass on its own, and taking a passing failure
// for a refusal signs the user out, so it counts as retryable.
class SiteError extends Error {
  constructor(message, status, options) {
    super(message, options)
    this.name = 'SiteError'
    this.status = status
    this.retryable = !(status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429)
  }
}
const isRetryableSiteError = (error) => error instanceof SiteError && error.retryable
// The site could not be reached, or stopped answering mid-call: status 0.
// describeFailure turns a TimeoutError into 连接超时.
const siteUnreachable = (reason, cause) =>
  new SiteError(`连不上 PIXEL 主站：${describeFailure(reason)}`, 0, { cause })
const NS = 'pixel-api'
const ROUTE_PREFIX = 'pixel/'
const REFRESH_COOKIE = 'new_api_refresh'
// Separator between a group name and its billing ratio in the provider name;
// client.js splits on the same mark.
const RATIO_MARK = '×'

// Site ratios arrive as numbers (or "auto" for the pseudo-group); render a
// compact multiplier, dropping float noise like 0.30000000000000004.
function formatRatio(ratio) {
  if (ratio === 'auto') return '自动'
  const n = typeof ratio === 'string' ? Number(ratio) : ratio
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return ''
  return String(Number(n.toFixed(4)))
}

const isContextWindow = (value) => Number.isSafeInteger(value) && value > 0

// Capacity declared for one model id: an exact override, else the longest
// matching `prefix*` override, else the configured default. Unusable entries
// are skipped rather than reported — resolveModel runs before every request,
// and an invalid capacity would fail each one with INVALID_MODEL_CONTEXT.
function contextWindowFor(model, defaultWindow, overrides) {
  const id = String(model).toLowerCase()
  let prefixWindow
  let prefixLength = 0
  for (const [pattern, value] of Object.entries(overrides ?? {})) {
    if (!isContextWindow(value)) continue
    const key = pattern.trim().toLowerCase()
    if (!key.endsWith('*')) {
      if (key === id) return value
      continue
    }
    // A bare `*` is not a pattern: the default already covers every model.
    const prefix = key.slice(0, -1)
    if (prefix.length > prefixLength && id.startsWith(prefix)) {
      prefixWindow = value
      prefixLength = prefix.length
    }
  }
  if (prefixWindow !== undefined) return prefixWindow
  return isContextWindow(defaultWindow) ? defaultWindow : DEFAULT_CONTEXT_WINDOW
}

const REFS = {
  password: 'PIXEL_API_PASSWORD',
  refresh: 'PIXEL_API_REFRESH',
  otp: 'PIXEL_API_2FA',
}
const OWN_REFS = new Set(Object.values(REFS))

const STREAM_IDLE_TIMEOUT_MS = 300_000
const STREAM_IDLE_TIMEOUT_CODE = 'pixel-stream-idle'
// Re-resolve the session this long before access_expires_at so an in-flight
// stream never hands out a token that dies mid-response.
const ACCESS_REFRESH_MARGIN_MS = 60_000
const DONE = '[DONE]'
// Bound each per-group model lookup so one slow group cannot stall the picker.
const GROUP_MODELS_TIMEOUT_MS = 15_000
// Bound every other site API call (body read included): undici's default
// 300 s waits would let one stuck call hold the serial reconcile queue for minutes.
const SITE_API_TIMEOUT_MS = 20_000
// A failed per-group lookup is not retried until this cooldown elapses.
const GROUP_FAILURE_COOLDOWN_MS = 3 * 60_000
// Without the pricing catalog, per-group lookups are allowed only when the
// account has at most this many groups; larger accounts retry the single
// /api/pricing call (at most once per cooldown) instead of fanning out.
const FALLBACK_MAX_GROUPS = 20
const CATALOG_RETRY_MS = 5 * 60_000
// Balance/profile cache lifetime, and the floor between failed refetches.
const PROFILE_TTL_MS = 5 * 60_000
const PROFILE_RETRY_MS = 60_000
// Floor between two full (groups + pricing) reloads triggered by the settings
// page; a refresh inside this window only refetches the profile.
const FULL_REFRESH_MIN_INTERVAL_MS = 30_000
// new-api defaults when /api/status is unreachable.
const DEFAULT_DISPLAY = { perUnit: 500_000, type: 'USD', usdRate: 1, symbol: '¤', customRate: 1 }

// Mirror of the site's renderQuota: quota → display string per quota_display_type.
function formatQuota(quota, display) {
  const q = Number(quota) || 0
  if (display.type === 'TOKENS') return q.toLocaleString('en-US')
  const units = q / display.perUnit
  if (display.type === 'CNY') return '¥' + (units * display.usdRate).toFixed(2)
  if (display.type === 'CUSTOM') return display.symbol + (units * display.customRate).toFixed(2)
  return '$' + units.toFixed(2)
}

// Password logins the site answered with a failure back off exponentially:
// 1m, 2m, 4m … capped at 30m (an unreachable site is not counted, see loginFlow).
const LOGIN_BACKOFF_BASE_MS = 60_000
const LOGIN_BACKOFF_MAX_MS = 30 * 60_000
// After a passing site failure, reconcile retries on a delay that doubles from
// 15 s to at most 5 min: an outage costs no sign-in, and a long one no flood.
const SITE_RETRY_BASE_MS = 15_000
const SITE_RETRY_MAX_MS = 5 * 60_000
// Fixed text: every status write re-runs reconcile, so a message carrying the
// failure's changing reason would loop. The reason goes to the log instead.
const SITE_RETRY_MESSAGE = '暂时连不上 PIXEL 主站，登录状态已保留，稍后自动重试'

// ---------------------------------------------------------------------------
// Wire serialization (OpenAI chat-completions shape plus the playground
// `group` field the site's controller routes on).
// ---------------------------------------------------------------------------

// Join one block list's text blocks (user/system/tool content).
function flattenText(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

// Stands in for an image the Harness offloaded to fit the request limits, so
// the model still learns an image was there.
const OFFLOADED_IMAGE_TEXT = '[image omitted to fit the request limits]'
// OpenAI tool messages carry text only: a run of tool results is followed by
// one user message holding their images under this label, the same layout and
// wording the shipped pi-ai adapter sends.
const TOOL_RESULT_IMAGES_LABEL = 'Attached image(s) from tool result:'

// Request-image budget: the attachment store takes a target size and a byte
// bound, not a pixel budget. Width/height come from the source aspect ratio
// scaled to fit IMAGE_MAX_PIXELS, which is what the shipped pi-ai adapter does.
const IMAGE_MAX_PIXELS = 1_048_576
const IMAGE_MAX_BYTES = 1_500_000
const IMAGE_FALLBACK_EDGE = 1024

function imageTarget(ref) {
  const width = Number(ref?.width)
  const height = Number(ref?.height)
  // A source without usable intrinsic dimensions (older attachment) still needs
  // a positive size: fall back to a square target and let the store scale.
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { width: IMAGE_FALLBACK_EDGE, height: IMAGE_FALLBACK_EDGE, maxBytes: IMAGE_MAX_BYTES }
  }
  const scale = requestImageDimensions ?? fallbackImageDimensions
  return { ...scale(width, height, IMAGE_MAX_PIXELS), maxBytes: IMAGE_MAX_BYTES }
}

// One retained image as an OpenAI `image_url` part. A data URL, because the
// site's relay forwards it verbatim to the upstream model.
async function imageUrlPart(block, images) {
  const version = await images.read(block.attachment)
  return {
    type: 'image_url',
    image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
  }
}

// OpenAI chat-completions content parts for one block list. Text-only content
// stays a plain string (smaller payload, accepted by every upstream model);
// image blocks become `image_url` parts.
async function serializeContent(blocks, images) {
  if (!contentHasImage(blocks)) return flattenText(blocks)
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    if (block.offloaded === true) {
      parts.push({ type: 'text', text: OFFLOADED_IMAGE_TEXT })
      continue
    }
    parts.push(await imageUrlPart(block, images))
  }
  // An image-only turn must still carry a text part: some upstream models
  // reject a content array without one.
  if (!parts.some((part) => part.type === 'text')) parts.unshift({ type: 'text', text: '' })
  return parts
}

// One tool result as an OpenAI `tool` message plus the image parts it leaves
// for the user message after the run of results (tool content is text only).
// An offloaded image keeps its placeholder where it stood. A failed result
// (isError) is sent as is: OpenAI has no field for it, and the text already
// says what went wrong.
async function serializeToolResult(toolCallId, blocks, images) {
  const text = flattenText(blocks.map((block) => (block.type === 'image' && block.offloaded === true
    ? { type: 'text', text: OFFLOADED_IMAGE_TEXT }
    : block)))
  const attached = []
  for (const block of blocks) {
    if (block.type === 'image' && block.offloaded !== true) attached.push(await imageUrlPart(block, images))
  }
  // Never empty: a blank tool message reads like a lost result to the model.
  const content = text.length > 0 ? text : attached.length > 0 ? '(see attached image)' : '(no output)'
  return { message: { role: 'tool', tool_call_id: toolCallId, content }, attached }
}

// ---------------------------------------------------------------------------
// Replay: per-response data the site hands out for later requests — Gemini
// thought signatures and its replay token, GPT encrypted reasoning — kept on
// the turn's finish chunk as replayState and sent back with that turn. The
// stored content stays the authoritative record: replay data that no longer
// fits the turn is left out and the turn goes as ordinary history, the rule
// the shipped pi-ai adapter follows.
// ---------------------------------------------------------------------------

// The response half of the replay envelope this plugin writes; DSH stores the
// envelope on the assistant message as source.replayState.
const REPLAY_KIND = 'pixel-api'
const REPLAY_VERSION = 1

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0

// What replay data was issued for: the turn's text and its tool calls, the
// content the site checks a token against. The stream's closed blocks and a
// stored message both go through here, so the two sides hash the same thing.
function replayDigest(blocks) {
  const calls = blocks
    .filter((block) => block.type === 'tool-call')
    .map((block) => [String(block.id), block.name, block.arguments])
  return createHash('sha256').update(JSON.stringify([flattenText(blocks), calls])).digest('hex')
}

// The finish chunk's replay envelope for one response: `blocks` are its
// closed content blocks, the rest the replay data its stream carried;
// undefined when it carried none. No per-block half: DSH then keeps the
// envelope whole, and the digest ties it to the turn's content instead.
function replayEnvelope(blocks, { openai, gemini, signatures }) {
  const signed = Object.keys(signatures).length > 0
  if (openai === undefined && gemini === undefined && !signed) return undefined
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      digest: replayDigest(blocks),
      ...(openai === undefined ? {} : { openai }),
      ...(gemini === undefined ? {} : { gemini }),
      ...(signed ? { signatures } : {}),
    },
  }
}

// Whether `value` is a response half this plugin version wrote. Another
// adapter's state, another version or a damaged value is not used.
function isReplayResponse(value) {
  if (!isRecord(value) || value.kind !== REPLAY_KIND || value.version !== REPLAY_VERSION) return false
  if (typeof value.digest !== 'string') return false
  if (value.openai !== undefined && typeof value.openai !== 'string') return false
  if (value.gemini !== undefined && typeof value.gemini !== 'string') return false
  return value.signatures === undefined
    || (isRecord(value.signatures) && Object.values(value.signatures).every((signature) => typeof signature === 'string'))
}

// The replay data stored on one assistant turn, when it may go back with a
// request to `target`: the turn came from the same route and model, and it
// still holds the text and tool calls the data was issued for. The runtime
// hands this adapter the replay state of every route it serves, so the route
// check is the plugin's own: another group may sit on another upstream account.
function storedReplay(message, target) {
  const source = message.source
  if (source.provider !== target.provider || source.model !== target.model) return undefined
  const response = source.replayState?.response
  if (!isReplayResponse(response) || response.digest !== replayDigest(message.content)) return undefined
  return response
}

// `target` is where this request goes (storedReplay).
function serializeAssistant(message, target) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  const replay = storedReplay(message, target)
  const signatures = replay?.signatures ?? {}
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
      // A Gemini thought signature goes back on the call it signed.
      ...(Object.hasOwn(signatures, block.id)
        ? { extra_content: { google: { thought_signature: signatures[block.id] } } }
        : {}),
    }))
  // Turn-level replay data. GPT's encrypted reasoning goes only with the
  // switch on: the site accepts it from the upstream account that produced it.
  const extra = {
    ...(replay?.gemini === undefined ? {} : { google: { new_api_gemini_replay: replay.gemini } }),
    ...(replay?.openai !== undefined && target.openaiReasoningReplay
      ? { openai: { new_api_openai_replay: replay.openai } }
      : {}),
  }

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null: pure tool-call turns replay
    // message.content verbatim, and reasoning-only turns with null content
    // are rejected by the live API, bricking every later turn of the session.
    content: text,
    // thinking-mode passback: reasoning_content returns on tool-call turns;
    // it is ignored on plain turns, so we drop it there to save tokens.
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(Object.keys(extra).length > 0 ? { extra_content: extra } : {}),
  }
}

async function serializeMessages(messages, images, target) {
  const wire = []
  // Images of the current run of tool results. They go out together after
  // the run: a user message between two tool messages would cut the answers
  // to one assistant turn apart.
  let toolImages = []
  const flushToolImages = () => {
    if (toolImages.length === 0) return
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGES_LABEL }, ...toolImages] })
    toolImages = []
  }
  const pushToolResult = async (toolCallId, blocks) => {
    const { message, attached } = await serializeToolResult(toolCallId, blocks, images)
    wire.push(message)
    toolImages.push(...attached)
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      await pushToolResult(message.toolCallId, message.content)
      continue
    }
    flushToolImages()
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pixel-api: a system message cannot carry an image', 'UNSUPPORTED_CONTENT')
      }
      // Empty content is the Harness's record of "no system prompt", not a
      // prompt to send.
      const text = flattenText(message.content)
      if (text.length > 0) wire.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message, target))
      continue
    }
    // Older runtimes carry tool results as `tool-result` blocks inside a user
    // message. The wire wants each answer right after the assistant turn that
    // called it, so the results go out first and the rest of the user message
    // follows.
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    for (const result of toolResults) await pushToolResult(result.toolCallId, result.content)
    flushToolImages()
    const content = await serializeContent(message.content.filter((block) => block.type !== 'tool-result'), images)
    const hasContent = typeof content === 'string' ? content.length > 0 : true
    if (hasContent || toolResults.length === 0) {
      wire.push({ role: 'user', content })
    }
  }
  flushToolImages()
  return wire
}

// ---------------------------------------------------------------------------
// Claude prompt caching. The site's chat→Claude conversion keeps cache_control
// on a text part of system / user / assistant content and on a tool message's
// array content, but drops it from tool definitions. So the plugin marks two
// breakpoints — the system prompt and the last conversation message — exactly
// as the shipped pi-ai openai-completions adapter does for anthropic upstreams,
// and leaves tools unmarked. Only claude routes are touched.
// ---------------------------------------------------------------------------

const CACHE_CONTROL = { type: 'ephemeral' }

// Add one cache breakpoint to a wire message in place. A non-empty string body
// becomes a single text part carrying it; an array body takes it on its last
// text part with non-empty text. Returns whether anything was marked — an
// empty string or an array with no non-empty text (an image-only turn) marks
// nothing, so the caller keeps looking.
function markCacheBreakpoint(message) {
  const content = message.content
  if (typeof content === 'string') {
    if (content.length === 0) return false
    message.content = [{ type: 'text', text: content, cache_control: CACHE_CONTROL }]
    return true
  }
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part.type === 'text' && part.text.length > 0) {
      content[i] = { ...part, cache_control: CACHE_CONTROL }
      return true
    }
  }
  return false
}

// Mark the first system message and the last user / assistant / tool message,
// the two the Claude conversion keeps. Tools stay unmarked. Mutates `messages`.
function markClaudeCache(messages) {
  const system = messages.find((message) => message.role === 'system')
  if (system !== undefined) markCacheBreakpoint(system)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue
    if (markCacheBreakpoint(message)) break
  }
}

// `openaiReasoningReplay` is the settings switch for GPT's encrypted reasoning.
async function serializeRequest(options, group, images, openaiReasoningReplay) {
  const messages = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  const target = { provider: options.provider, model: options.model, openaiReasoningReplay }
  messages.push(...await serializeMessages(options.messages, images, target))
  // Claude routes get cache breakpoints; every other model's body is unchanged.
  if (/claude/i.test(options.model)) markClaudeCache(messages)

  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))

  return {
    model: options.model,
    group,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    // Sent only when the user picked a level: the site converts this field to
    // each upstream format (Claude output_config, Gemini thinkingConfig) and a
    // model without thinking support answers its own error, surfaced verbatim.
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
    // The session id as the upstream's prompt cache key, GPT models only — the
    // site passes it through to the Responses/Codex upstream. Clamped to 64
    // code points, the same bound the shipped pi-ai adapter's
    // clampOpenAIPromptCacheKey uses. It is an opaque id, no conversation text.
    ...(/^gpt-/i.test(options.model) && options.sessionId !== undefined
      ? { prompt_cache_key: Array.from(String(options.sessionId)).slice(0, 64).join('') }
      : {}),
  }
}

// Reasoning ladder the site accepts (relaykit ParseEffort): none … max. Every
// route declares the same set because the model behind a group is chosen
// server-side; the site maps or ignores a level per upstream model.
const REASONING_EFFORTS = [
  { id: 'minimal', name: 'Minimal' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Xhigh' },
  { id: 'max', name: 'Max' },
]
// No defaultEffort: an unpicked level sends no field, so the upstream uses its
// own default instead of being forced to one rung of the ladder. Every list and
// resolve site spreads this same ladder, so the picker agrees with the call.

// ---------------------------------------------------------------------------
// SSE — minimal self-contained parser over the response body. Yields each
// `data:` payload; returns after yielding the `[DONE]` sentinel, throws
// STREAM_CLOSED if the body ends without it (truncation must not look like
// success). `facts` are the response's provider facts (its request id), which
// every failure of that response carries.
// ---------------------------------------------------------------------------

async function* parseSse(stream, onComment, facts) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const drainEvent = function* (raw) {
    const dataLines = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith(':') && onComment !== undefined) onComment(line.slice(1).trim())
    }
    if (dataLines.length === 0) return
    yield dataLines.join('\n')
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      if (buffer.startsWith('﻿')) buffer = buffer.slice(1)
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const data of drainEvent(raw)) {
          yield data
          if (data === DONE) return
        }
      }
    }
    // EOF: flush any trailing unterminated event — some providers close the
    // body right after `data: [DONE]\n` without the final blank line.
    buffer += decoder.decode().replace(/\r\n/g, '\n')
    for (const data of drainEvent(buffer)) {
      yield data
      if (data === DONE) return
    }
    throw new LlmError('pixel-api: SSE stream ended without [DONE]', 'STREAM_CLOSED', facts)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The lock is already released when the reader was cancelled mid-flight.
    }
  }
}

// ---------------------------------------------------------------------------
// Chunk translation — wire deltas to DSH StreamChunks, keeping block ordering.
// ---------------------------------------------------------------------------

// Provider refusal code. Harness 0.2.2-rc.4 registered CONTENT_REFUSED for
// content-safety stops (its DeepSeek adapter's `refusal`); earlier runtimes
// carry the same string as an ordinary provider code.
const CONTENT_REFUSED_CODE = 'CONTENT_REFUSED'
// OpenAI error codes the site's content-policy category returns.
const REFUSAL_ERROR_CODES = new Set(['content_policy_violation', 'content_filter', 'invalid_prompt', 'cyber_policy'])
// Sentinel finish: the stream is ended as a CONTENT_REFUSED failure at [DONE].
const REFUSED = Symbol('pixel-api refused')

function mapFinishReason(reason, facts) {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'content_filter':
      return REFUSED
    default:
      return { kind: 'error', failure: { message: `unknown finish_reason "${reason}"`, code: 'UNKNOWN_FINISH_REASON', ...facts } }
  }
}

// Wire usage → Harness TokenUsage. The site answers OpenAI-shaped usage for
// every upstream: prompt_tokens counts the whole prompt INCLUDING cache reads
// and writes, and prompt_tokens_details splits the cache out — cached_tokens
// for reads; cache_write_tokens / cached_creation_tokens /
// cache_creation_input_tokens for writes (one count under several names, so
// the largest wins). DeepSeek-type channels may carry prompt_cache_hit_tokens
// instead. usage_semantic 'anthropic' marks a prompt_tokens that already
// excludes the cache.
// The Harness wants disjoint buckets — inputTokens is the uncached remainder —
// whose sum equals totalTokens - outputTokens; turn usage that breaks that
// identity is discarded, so the split is clamped to the prompt and an
// inconsistent provider total is left for the runtime to derive.
function mapUsage(usage) {
  const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)
  const details = usage.prompt_tokens_details ?? {}
  const output = count(usage.completion_tokens)
  let read = count(details.cached_tokens) || count(usage.prompt_cache_hit_tokens)
  let write = Math.max(
    count(details.cache_write_tokens),
    count(details.cached_creation_tokens),
    count(details.cache_creation_input_tokens),
  )
  const reported = count(usage.prompt_tokens)
  const prompt = usage.usage_semantic === 'anthropic' ? reported + read + write : reported
  read = Math.min(read, prompt)
  write = Math.min(write, prompt - read)
  const total = count(usage.total_tokens)
  return {
    inputTokens: prompt - read - write,
    outputTokens: output,
    ...(total === prompt + output ? { totalTokens: total } : {}),
    cacheReadTokens: read,
    cacheWriteTokens: write,
  }
}

// `facts` are the response's provider facts (its request id), which every
// failure of that response carries.
async function* translate(payloads, facts) {
  let nextIndex = 0
  let reasoningBlock
  let textBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  // Turn-level replay data of this response (Replay above); thought
  // signatures sit on their tool blocks.
  let openaiReplay
  let geminiReplay

  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  const closeBlock = (block) => (block.kind === 'tool-call'
    ? {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
    : { type: block.kind, text: block.text })
  // Ahead of any terminal outcome, a failure included: end the open blocks and
  // report the usage, so streamed output and billed usage are kept.
  const settle = function* () {
    for (const block of order) {
      yield { type: 'block-end', index: block.index, block: closeBlock(block) }
    }
    if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  }
  // Built from the blocks exactly as they were closed, so the digest matches
  // the turn DSH stores from them.
  const replayOf = () => {
    const blocks = order.map(closeBlock)
    const signatures = Object.fromEntries(order.flatMap((block, position) =>
      (block.signature === undefined ? [] : [[blocks[position].id, block.signature]])))
    return replayEnvelope(blocks, { openai: openaiReplay, gemini: geminiReplay, signatures })
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      yield* settle()
      // A content-filter stop is a refusal, not a completed answer: report the
      // billed usage above, then fail the attempt the way the Harness's own
      // DeepSeek adapter fails a `refusal` stop.
      if (pendingFinish === REFUSED) {
        throw new LlmError(
          'pixel-api: the upstream model refused to answer under its content policy (finish_reason content_filter)',
          CONTENT_REFUSED_CODE,
          facts,
        )
      }
      const pending = pendingFinish ?? { kind: 'stop' }
      const reason = pending.kind === 'stop' && order.length === 0
        ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE, ...facts } }
        : pending
      // Only a response that finished is kept for replay.
      const replayState = reason.kind === 'error' ? undefined : replayOf()
      yield { type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new LlmError(`pixel-api: malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE', facts)
    }

    // The site ends a stream that failed after the response began with an
    // `error` frame (an OpenAI error object, or a bare message string), with
    // or without [DONE] after it. That frame is the attempt's outcome,
    // classified like the HTTP error it stands for — not a truncated stream,
    // an empty answer, or, after some text, a finished one. Only an object or
    // a non-empty string counts: a falsy `error` field reports nothing.
    if ((typeof chunk.error === 'object' && chunk.error !== null)
      || (typeof chunk.error === 'string' && chunk.error.length > 0)) {
      yield* settle()
      const error = typeof chunk.error === 'string' ? { message: chunk.error } : chunk.error
      const message = typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'pixel-api: the site reported a stream error'
      throw new LlmError(message, providerErrorCode(undefined, error), facts)
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // GPT's encrypted reasoning comes in a chunk of its own, the Gemini
      // token with the finish reason; either is taken wherever it appears.
      const openaiToken = delta?.extra_content?.openai?.new_api_openai_replay
      if (isNonEmptyString(openaiToken)) openaiReplay = openaiToken
      const geminiToken = delta?.extra_content?.google?.new_api_gemini_replay
      if (isNonEmptyString(geminiToken)) geminiReplay = geminiToken

      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const signature = call.extra_content?.google?.thought_signature
        if (isNonEmptyString(signature)) block.signature = signature
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason, facts)
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  throw new LlmError('pixel-api: SSE payload stream ended without [DONE]', 'STREAM_CLOSED', facts)
}

// ---------------------------------------------------------------------------
// Provider error mapping: one classification for HTTP errors and stream error
// frames, in the Harness's own codes, so its retry policy repeats only what a
// repeat can fix (EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT).
// ---------------------------------------------------------------------------

// The group's ratio or the model's price went up; not retried: every attempt fails until the user confirms it on the site.
const PRICE_CONFIRMATION_REQUIRED_CODE = 'PRICE_CONFIRMATION_REQUIRED'
// The upstream blocked this conversation; not retried: the same session fails every time, only a new one gets through.
const SESSION_BLOCKED_CODE = 'SESSION_BLOCKED'
// The site denies this account the group (blocked, outside its open hours …); not retried: a repeat is denied the same way.
const ACCESS_DENIED_CODE = 'ACCESS_DENIED'
// Site codes that decide the class whatever the status: a member limit answers
// 429, yet no wait short of its reset lifts it.
const QUOTA_ERROR_CODES = new Set(['insufficient_user_quota', 'pre_consume_token_quota_failed', 'room_member_limit_exceeded'])
const PRICE_CHANGED_ERROR_CODES = new Set(['group_ratio_changed', 'model_price_changed'])

// `status` is undefined for a stream error frame (that response was a 200).
function providerErrorCode(status, error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const key = code.toLowerCase()
  if (QUOTA_ERROR_CODES.has(key)) return QUOTA_EXCEEDED_CODE
  if (PRICE_CHANGED_ERROR_CODES.has(key)) return PRICE_CONFIRMATION_REQUIRED_CODE
  if (key === 'session_blocked') return SESSION_BLOCKED_CODE
  if (key === 'access_denied') return ACCESS_DENIED_CODE
  // Classify on code, type and message together, as the runtime's classifiers
  // expect. The site tags a context overflow with code context_length_exceeded
  // but may pass the upstream's own wording through as the message (Claude
  // "prompt is too long: …", Gemini "The input token count …"), which a
  // message-only check misses — and overflow recovery keys on this code.
  const detail = [code, error?.type, error?.message]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (REFUSAL_ERROR_CODES.has(key)) return CONTENT_REFUSED_CODE
  if (status === undefined) {
    // The frame's type is all that tells a passing failure from a request the
    // site would refuse again.
    if (error?.type === 'rate_limit_error') return 'RATE_LIMIT'
    if (error?.type === 'invalid_request_error') return 'INVALID_REQUEST'
    return 'SERVER'
  }
  if (status === 401) return 'AUTH'
  // The chat surface blanks an AUTH failure's text, so only a dead login may
  // claim it; any other 403 is the site refusing this account something.
  if (status === 403) return ACCESS_DENIED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

// A Retry-After header as the delay the site asks for: delay-seconds, or an
// HTTP date still ahead. Anything else asks for nothing, leaving the
// Harness's own backoff in charge.
function retryAfterMs(header) {
  if (header === null) return undefined
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

class PixelAdapter extends LlmAdapter {
  constructor(deps) {
    super()
    this.deps = deps
  }

  providerInfo(provider) {
    const route = this.deps.routes().get(provider)
    return { id: provider, name: route?.name ?? provider }
  }

  async listModels(provider) {
    const route = this.deps.routes().get(provider)
    if (!route) return []
    // Account rooms (kind "account") narrow the provider registry through
    // their AllowedModels whitelist, which /api/pricing does not apply — the
    // authoritative list must be fetched per group. These fetches serialize
    // through deps.groupQueue so a catalog sweep stays under ~4 in-flight.
    if (route.account) return this.deps.groupModels(route.group, provider).catch(() => [])
    const catalog = this.deps.catalog()
    if (catalog) {
      const ids = [...(catalog.byGroup.get(route.group) ?? [])]
      return ids.map((id) => ({
        provider,
        id,
        name: id,
        inputModalities: ['text', 'image'],
        reasoning: { efforts: REASONING_EFFORTS.map((effort) => ({ ...effort })) },
        ...(catalog.meta.has(id) ? { description: catalog.meta.get(id) } : {}),
      }))
    }
    return this.deps.fallbackModels(route.group, provider).catch(() => [])
  }

  async resolveModel(provider, model) {
    // The site routes each request to whatever upstream model the group
    // offers; vision-capable ones accept image parts in the same OpenAI
    // content array. Declaring image input keeps the composer's attach button
    // usable — a text-only upstream answers its own error, surfaced verbatim.
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      reasoning: { efforts: REASONING_EFFORTS.map((effort) => ({ ...effort })) },
      // compaction-basic prices switches and step pressure against this
      // capacity. No defaultMaxTokens: the runtime would materialize it as
      // max_tokens on every request, and the site leaves the cap upstream.
      context: { contextWindow: this.deps.contextWindow(model) },
    }
  }

  async *stream(options) {
    const route = this.deps.routes().get(options.provider)
    if (!route) {
      throw new LlmError(`pixel-api: provider "${options.provider}" is not routed`, 'NO_ADAPTER')
    }
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, route.group, watchdog.signal, () => watchdog.pulse())[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError('pixel-api: stream idle timeout', 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pixel-api: request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`pixel-api: stream to ${SITE} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('pixel-api stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  async *request(options, group, signal, onComment) {
    const payload = JSON.stringify(await serializeRequest(options, group, this.deps.images(), this.deps.openaiReasoningReplay()))
    let response
    // A stale access token answers 401 once: invalidate it, re-resolve the
    // session (refresh or re-login), and retry the identical payload.
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.deps.ensureAccess()
      try {
        response = await siteFetch(`${SITE}/pg/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...attributionHeaders(),
          },
          body: payload,
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new LlmError(`pixel-api: request to ${SITE} failed`, 'TRANSPORT', { cause: error })
      }
      if (response.status === 401 && attempt === 0) {
        this.deps.invalidateAccess()
        continue
      }
      break
    }

    // Every failure of this response names the site's request id, the key to
    // the matching entry in the site's logs.
    const requestId = response.headers.get('x-oneapi-request-id')
    const facts = requestId ? { requestId } : {}
    if (!response.ok) {
      let message = `pixel-api: site error (HTTP ${response.status})`
      let providerError
      try {
        const parsed = await response.json()
        providerError = parsed?.error ?? parsed
        if (providerError?.message) message = providerError.message
        else if (parsed?.message) message = parsed.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the failure.
      }
      const delay = retryAfterMs(response.headers.get('retry-after'))
      throw new LlmError(message, providerErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...facts,
      })
    }
    if (!response.body) {
      throw new LlmError('pixel-api: site returned no response body', 'EMPTY_RESPONSE', facts)
    }
    try {
      yield* translate(parseSse(response.body, onComment, facts), facts)
    } catch (error) {
      // A body read that dies mid-stream is a transport failure of this
      // response, so it keeps the request id. Aborts pass through untouched:
      // stream() tells a timeout from a cancel by the signals.
      if (error instanceof LlmError || signal.aborted) throw error
      throw new LlmError(`pixel-api: stream to ${SITE} failed`, 'TRANSPORT', { cause: error, ...facts })
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin: settings wiring, session lifecycle, route mirroring.
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  let disposed = false
  // `debug` is volatile, so read it through the live cell rather than the
  // snapshot handed to apply.
  const debugCell = config?.debug
  const debugOn = debugCell && typeof debugCell.get === 'function' ? debugCell.get() : debugCell
  if (debugOn === true) DEBUG_ENABLED = true
  trace('apply start')
  // The pending reconcile retry after a passing site failure (scheduleRetry).
  let retryTimer
  ctx.effect(() => () => {
    disposed = true
    clearTimeout(retryTimer)
    trace('fiber disposed')
  }, 'pixel-api: teardown')

  const state = {
    accessToken: '',
    accessExpiresAt: 0,
    sid: '',
    user: '',
    challenge: null,
    routes: new Map(),
    appliedKey: '',
    catalog: null,
    catalogFailedAt: 0,
    profile: { ...EMPTY_PROFILE },
    profileTriedAt: 0,
    // Last settings-page refresh request (config refreshAt) already served.
    handledRefreshAt: 0,
    // Last settings-page sign-out request (config signOutAt) already served;
    // mirrored into the status so a reload does not replay the revoke.
    statusSignOutAt: 0,    // When the group list + pricing catalog were last refetched from the site.
    lastFullRefreshAt: 0,
    groupModels: new Map(),
    // group key -> timestamp before which a failed lookup is not retried
    groupFailures: new Map(),
  }
  const accessFresh = () =>
    state.accessToken !== '' && state.accessExpiresAt - ACCESS_REFRESH_MARGIN_MS > Date.now()

  const creds = () => ctx.get('credentials')
  const resolveCred = async (ref) => {
    const c = creds()
    if (!c) return undefined
    const hit = await c.resolve(ref)
    const value = hit?.value?.trim()
    return value || undefined
  }
  const setCred = async (ref, value) => creds()?.set(ref, value)
  const unsetCred = async (ref) => creds()?.unset(ref)

  // Volatile config cells commit in place; unwrap the shared reference to read.
  const cell = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
  const sectionOf = () => {
    const cfg = config ?? ctx.config ?? {}
    return {
      username: cell(cfg.username) ?? '',
      refreshAt: Number(cell(cfg.refreshAt) ?? 0) || 0,
      signOutAt: Number(cell(cfg.signOutAt) ?? 0) || 0,
      auth: cell(cfg.auth) ?? {},
    }
  }
  // Read per call: the settings page commits these volatile cells in place,
  // so a changed window or replay switch applies to the next request without
  // a fiber restart.
  const contextWindowOf = (model) => {
    const cfg = config ?? ctx.config ?? {}
    return contextWindowFor(model, Number(cell(cfg.contextWindow)), cell(cfg.contextWindows))
  }
  const openaiReasoningReplayOf = () => cell((config ?? ctx.config ?? {}).openaiReasoningReplay) === true

  // Canonical auth shape: fixed key order so the dedupe compare below is a
  // plain string compare, and nothing unbounded (no group-name list) is
  // persisted into the profile patch.
  const normProfile = (p) => ({
    id: Number(p?.id ?? 0) || 0,
    name: String(p?.name ?? ''),
    group: String(p?.group ?? ''),
    balance: String(p?.balance ?? ''),
    used: String(p?.used ?? ''),
    requests: Number(p?.requests ?? 0) || 0,
    updatedAt: Number(p?.updatedAt ?? 0) || 0,
  })
  const normAuth = (a) => ({
    state: String(a?.state ?? 'none'),
    message: String(a?.message ?? ''),
    user: String(a?.user ?? ''),
    groups: [],
    groupCount: Number(a?.groupCount ?? 0) || 0,
    models: typeof a?.models === 'number' ? a.models : -1,
    signOutAt: Number(a?.signOutAt ?? 0) || 0,
    profile: normProfile(a?.profile),
  })

  // Work started from apply() (inside a reload) or from loader/volatile-update
  // (inside a settings commit) inherits the HMR service's `executing`
  // AsyncLocalStorage, and anything that opens an HMR transaction — a
  // configEditor edit, a plugin-manager update — then rejects with "HMR
  // transactions cannot be nested". Leave that async context, the same escape
  // HMR uses for its own config watcher; the operation is queued behind the
  // running transaction. Nothing that transaction waits on awaits the result,
  // so it cannot deadlock.
  const outsideHmr = (fn) => {
    const hmrExec = ctx.get('hmr')?.executing
    return hmrExec && typeof hmrExec.exit === 'function' && hmrExec.getStore?.()
      ? hmrExec.exit(fn)
      : fn()
  }

  // Host→config status writes go through the config editor seam: it validates,
  // persists to the profile patch, and commits volatile cells in place.
  // Identical status is never rewritten: each write fires volatile-update →
  // reconcile, so an unconditional write would loop.
  const writeAuth = (patch) => {
    const next = normAuth({ ...patch, signOutAt: Math.max(Number(patch?.signOutAt ?? 0) || 0, state.statusSignOutAt) })
    if (JSON.stringify(next) === JSON.stringify(normAuth(sectionOf().auth))) {
      trace('writeAuth skip (unchanged)', next.state)
      return
    }
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) {
      trace('writeAuth NO EDITOR', { editor: editor !== undefined, entry: entry !== undefined })
      ctx.logger.warn('pixel-api: configEditor unavailable — auth status not persisted')
      return
    }
    trace('writeAuth edit', { state: next.state, groupCount: next.groupCount, models: next.models,
      hasBalance: next.profile.balance !== '', profileAt: next.profile.updatedAt })
    outsideHmr(() => editor.edit(entry, (raw) => ({ ...(raw ?? {}), auth: next }))).then(
      () => trace('writeAuth edit ok'),
      (err) => {
        trace('writeAuth edit FAILED', String(err?.message ?? err))
        ctx.logger.warn('pixel-api: status write failed:', err)
      })
  }

  // ---- self-update ------------------------------------------------------
  // The settings page bumps updateCheckAt / updateApplyAt; this fiber serves
  // each newer value once and records it in `update`. Nothing here touches the
  // network unless the user asked for a check.
  const normUpdate = (u) => ({
    state: String(u?.state ?? 'idle'),
    message: String(u?.message ?? ''),
    current: String(u?.current ?? ''),
    latest: String(u?.latest ?? ''),
    target: String(u?.target ?? ''),
    spec: String(u?.spec ?? ''),
    checkedAt: Number(u?.checkedAt ?? 0) || 0,
    servedCheckAt: Number(u?.servedCheckAt ?? 0) || 0,
    servedApplyAt: Number(u?.servedApplyAt ?? 0) || 0,
  })
  const updateSection = () => {
    const cfg = config ?? ctx.config ?? {}
    return {
      status: normUpdate(cell(cfg.update)),
      checkAt: Number(cell(cfg.updateCheckAt) ?? 0) || 0,
      applyAt: Number(cell(cfg.updateApplyAt) ?? 0) || 0,
    }
  }
  // Same seam as writeAuth, but resolves to whether the status was persisted:
  // an update must not start unless its record survives the removal of this
  // copy, because the version that starts next reads it.
  const writeUpdate = (patch) => {
    const current = updateSection().status
    const next = normUpdate({ ...current, ...patch, current: OWN_VERSION })
    if (JSON.stringify(next) === JSON.stringify(current)) return Promise.resolve(true)
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (editor === undefined || entry === undefined) return Promise.resolve(false)
    trace('writeUpdate', { state: next.state, latest: next.latest, target: next.target })
    return outsideHmr(() => editor.edit(entry, (raw) => ({ ...(raw ?? {}), update: next }))).then(
      () => true,
      (err) => {
        ctx.logger.warn('pixel-api: update status write failed:', err)
        return false
      })
  }

  const unsupportedReason = (manager, bundle) => {
    if (manager === undefined) return '这个 Harness 没有插件管理服务，请手动更新'
    if (bundle === undefined) return '插件管理里找不到 dsh-pixel-api'
    if (bundle.update === 'registry') return '这份插件是从 npm 安装的，请在 插件 → 已安装 里更新'
    if (typeof bundle.source === 'string' && /^(?:link|file):/i.test(bundle.source)) {
      return '这份插件是从本地目录安装的，请在本地仓库更新代码'
    }
    return '安装来源没有固定到具体提交，请在 插件 页移除后，用 GitHub 地址重新添加'
  }

  const checkForUpdate = async () => {
    const empty = { latest: '', target: '', spec: '' }
    if (!SEMVER.test(OWN_VERSION)) return { ...empty, state: 'error', message: '读不到插件自己的版本号' }
    const manager = ctx.get('pluginManager')
    let bundle
    if (manager !== undefined && typeof manager.listBundles === 'function') {
      try {
        bundle = (await outsideHmr(() => manager.listBundles())).find((item) => item?.name === PACKAGE_NAME)
      } catch (error) {
        trace('update listBundles FAILED', String(error?.message ?? error).slice(0, 200))
      }
    }
    const fromGit = bundle?.update === 'git' && typeof bundle.source === 'string'
    const repository = (fromGit ? repositoryOf(bundle.source) : undefined) ?? CANONICAL_REPOSITORY
    let newest
    try {
      newest = newestRelease(await remoteTagRefs(repository))
    } catch (error) {
      return { ...empty, state: 'error', message: `读取 ${repository} 的版本失败：${describeFailure(error)}` }
    }
    // Up to date — including a build newer than every release tag.
    if (newest === undefined || !newerRelease(newest.version, OWN_VERSION)) {
      return { ...empty, state: 'latest', message: '', latest: OWN_VERSION }
    }
    const spec = fromGit ? retargetGitSpec(bundle.source, newest.commit) : undefined
    if (spec === undefined) {
      return { ...empty, state: 'unsupported', message: unsupportedReason(manager, bundle), latest: newest.version }
    }
    return { state: 'available', message: '', latest: newest.version, target: newest.version, spec }
  }

  const updateFailure = (outcome) => {
    if (outcome?.error !== undefined) return describeFailure(outcome.error)
    const result = outcome?.result
    const reason = result?.error?.diagnostic || result?.error?.code || result?.packageResult?.kind || '未知原因'
    return `${String(reason).slice(0, 200)}${outcome?.restore !== undefined ? '（已恢复原版本）' : ''}`
  }

  let updateRunning = false
  const applyUpdate = async (status, applyAt) => {
    const manager = ctx.get('pluginManager')
    if (status.state !== 'available' || status.spec === '' || !newerRelease(status.target, OWN_VERSION)
      || manager === undefined || typeof manager.updateBundle !== 'function') {
      await writeUpdate({ state: 'error', message: '没有可以安装的新版本，请先检查更新', servedApplyAt: applyAt })
      return
    }
    // Durable before anything is removed: the copy that starts next — the new
    // version, or this one restored after a failure — settles the status.
    const persisted = await writeUpdate({ state: 'updating', message: '', servedApplyAt: applyAt })
    if (!persisted || disposed) return
    updateRunning = true
    let outcome
    try {
      outcome = await outsideHmr(() => manager.updateBundle(PACKAGE_NAME, status.target, {
        spec: status.spec,
        requestId: randomUUID(),
      }))
    } catch (error) {
      outcome = { error }
    } finally {
      updateRunning = false
    }
    trace('update outcome', { step: outcome?.step, application: outcome?.result?.application, error: !!outcome?.error })
    // With HMR the update removed this copy; the next start settles the status.
    if (disposed) return
    const application = outcome?.result?.application
    if (application === 'restart-required') {
      await writeUpdate({ state: 'restart', message: '' })
    } else if (outcome?.error !== undefined || application === 'failed' || application === 'cancelled') {
      await writeUpdate({ state: 'failed', message: updateFailure(outcome) })
    }
  }

  const serveUpdate = async () => {
    if (disposed) return
    const { status, checkAt, applyAt } = updateSection()
    // Settle what an earlier start left behind.
    if (status.state === 'updating' && !updateRunning) {
      await writeUpdate(status.target !== '' && status.target === OWN_VERSION
        ? { state: 'updated', message: '', latest: OWN_VERSION, target: '', spec: '' }
        : { state: 'failed', message: `更新没有完成，当前仍是 v${OWN_VERSION}，可以在 插件 页查看安装日志后重试` })
    } else if (status.state === 'restart' && status.target === OWN_VERSION) {
      await writeUpdate({ state: 'updated', message: '', latest: OWN_VERSION, target: '', spec: '' })
    } else if (status.state === 'checking') {
      await writeUpdate({ state: 'idle', message: '' })
    } else if (status.state === 'available' && !newerRelease(status.latest, OWN_VERSION)) {
      await writeUpdate({ state: 'latest', message: '', target: '', spec: '' })
    } else if (status.current !== OWN_VERSION) {
      await writeUpdate({})
    }
    if (checkAt > status.servedCheckAt) {
      await writeUpdate({ state: 'checking', message: '', servedCheckAt: checkAt })
      const result = await checkForUpdate()
      if (disposed) return
      await writeUpdate({ ...result, checkedAt: Date.now(), servedCheckAt: checkAt })
    }
    const now = updateSection().status
    if (applyAt > now.servedApplyAt) await applyUpdate(now, applyAt)
  }

  let updateChain = Promise.resolve()
  const reconcileUpdate = () => {
    const run = updateChain.then(serveUpdate, serveUpdate)
    updateChain = run.then(() => undefined, () => undefined)
    run.catch((error) => {
      trace('update FAILED', String(error?.message ?? error).slice(0, 300))
      ctx.logger.warn('pixel-api: update handling failed:', error)
    })
  }

  let registration
  const applyRoutes = (routes) => {
    const prev = [...state.routes.keys()].join('')
    const next = [...routes.keys()].join('')
    state.routes = routes
    if (prev === next) return
    const ids = [...routes.keys()]
    if (registration === undefined) {
      if (ids.length === 0) return
      registration = ctx.llm.registerAdapter(ids, adapter)
    } else {
      registration.replace(ids)
    }
  }

  const readRefreshCookie = (res) => {
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';')
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      if (pair.slice(0, eq).trim() === REFRESH_COOKIE) return pair.slice(eq + 1).trim()
    }
    return undefined
  }

  const adoptBundle = (data, res) => {
    state.accessToken = data.access_token
    const exp = Number(data.access_expires_at ?? 0)
    state.accessExpiresAt = exp > 1e13 ? exp : exp * 1000
    state.sid = data.session?.sid ?? ''
    state.user = data.user?.username ?? ''
    state.challenge = null
    const refresh = readRefreshCookie(res)
    if (refresh) {
      setCred(REFS.refresh, refresh).catch((err) =>
        ctx.logger.warn('pixel-api: refresh credential write failed:', err))
    }
  }

  const apiJson = async (path, init) => {
    // One timer bounds the whole call, body read included. A caller's own
    // signal is merged in, never silently replaced by the timer.
    const timeout = AbortSignal.timeout(SITE_API_TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    let res
    try {
      res = await siteFetch(`${SITE}${path}`, {
        ...init,
        headers: { ...attributionHeaders(), ...init?.headers },
        signal,
      })
    } catch (error) {
      // undici reports every network failure as "fetch failed" and keeps the
      // reason (DNS, refused, reset, TLS) in `cause`; a timeout rejects with
      // the signal's own TimeoutError.
      throw siteUnreachable(error?.cause ?? error, error)
    }
    let body = null
    try {
      body = await res.json()
    } catch (error) {
      // A body that is not JSON (a gateway's HTML page) stays null for the
      // caller to report with the status. One the timer cut off is the site
      // not answering — the same failure as a timed-out connect, never a
      // misleading "HTTP 200" or a refusal.
      if (timeout.aborted) throw siteUnreachable(timeout.reason, error)
    }
    return { res, body }
  }

  // Login backoff: a password login the site answered with a failure (a
  // refusal, a non-JSON 5xx page) blocks further automatic attempts for the
  // SAME username+password (compared by hash, never stored in clear) with
  // exponential delay. A site that could not be reached (SiteError status 0,
  // a timeout included) is not counted: it says nothing about the password.
  // Changing the password or username resets it.
  const loginGuard = { key: '', failures: 0, until: 0 }
  const loginKey = (username, password) =>
    createHash('sha256').update(`${username}\u0000${password}`).digest('hex')
  const loginFlow = async (username, password) => {
    const key = loginKey(username, password)
    if (loginGuard.key !== key) {
      loginGuard.key = key
      loginGuard.failures = 0
      loginGuard.until = 0
    }
    if (loginGuard.until > Date.now()) {
      // Stable text (absolute time, not a countdown): this message lands in
      // the auth status, and a changing string would re-fire the
      // write → volatile-update → reconcile loop.
      const at = new Date(loginGuard.until).toLocaleTimeString('zh-CN', { hour12: false })
      throw new Error(`登录连续失败，${at} 之前暂停自动重试；如密码有误请重新输入`)
    }
    try {
      await loginOnce(username, password)
      loginGuard.failures = 0
      loginGuard.until = 0
    } catch (error) {
      if (!(error instanceof SiteError && error.status === 0)) {
        loginGuard.failures++
        const delay = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (loginGuard.failures - 1), LOGIN_BACKOFF_MAX_MS)
        loginGuard.until = Date.now() + delay
      }
      throw error
    } finally {
      // The password is consumed by exactly one sign-in and never kept: the
      // refresh cookie issued by the site is the durable secret. Leaving it in
      // the credential store would park a plaintext account password on disk.
      await unsetCred(REFS.password)
    }
  }

  const loginOnce = async (username, password) => {
    const { res, body } = await apiJson('/api/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!body?.success) {
      throw new Error(body?.message ?? `login failed (HTTP ${res.status})`)
    }
    const data = body.data ?? {}
    if (data.require_verification) {
      state.challenge = { flowToken: data.flow_token }
      writeAuth({ state: '2fa', message: '该账号启用了两步验证，请输入 TOTP 验证码', user: username, groups: [] })
      return
    }
    adoptBundle(data, res)
  }

  const completeChallenge = async (code) => {
    const { res, body } = await apiJson('/api/user/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow_token: state.challenge.flowToken, method: '2fa', code }),
    })
    if (!body?.success) {
      throw new Error(body?.message ?? `verification failed (HTTP ${res.status})`)
    }
    adoptBundle(body.data ?? {}, res)
  }

  const refreshSession = async (refreshToken) => {
    const { res, body } = await apiJson('/api/user/auth/refresh', {
      method: 'POST',
      headers: {
        cookie: `${REFRESH_COOKIE}=${refreshToken}`,
        origin: SITE,
        referer: `${SITE}/`,
        ...(state.sid ? { 'x-auth-session': state.sid } : {}),
      },
    })
    if (!body?.success) {
      throw new SiteError(body?.message ?? `session refresh failed (HTTP ${res.status})`, res.status)
    }
    adoptBundle(body.data ?? {}, res)
  }

  const serverLogout = async () => {
    const refresh = await resolveCred(REFS.refresh)
    if (!state.accessToken && !refresh) return
    await siteFetch(`${SITE}/api/user/auth/logout`, {
      method: 'POST',
      headers: {
        ...(state.accessToken ? { authorization: `Bearer ${state.accessToken}` } : {}),
        ...(refresh ? { cookie: `${REFRESH_COOKIE}=${refresh}` } : {}),
        ...(state.sid ? { 'x-auth-session': state.sid } : {}),
        origin: SITE,
        referer: `${SITE}/`,
        ...attributionHeaders(),
      },
      signal: AbortSignal.timeout(SITE_API_TIMEOUT_MS),
    }).then(
      (res) => trace('serverLogout', { http: res.status }),
      (error) => trace('serverLogout FAILED', String(error?.message ?? error).slice(0, 200)),
    ).catch(() => {})
  }

  // The model picker enumerates EVERY registered route's listModels in one
  // Promise.all (session/modelCatalog). Per-group fetches across ~380 routes
  // burst past the site's request limiter, so the catalog is inverted from a
  // single /api/pricing call: each model's enable_groups already covers
  // ability-table models and account-room registry/custom models alike.
  // `null` means the pricing surface is unavailable (module disabled) and
  // listModels falls back to the site's lazy per-group endpoint.
  const fetchCatalog = async () => {
    const { res, body } = await apiJson('/api/pricing', {
      headers: { authorization: `Bearer ${state.accessToken}` },
    })
    if (!body?.success) return null
    const items = Array.isArray(body.data) ? body.data : []
    const meta = new Map()
    const byGroup = new Map()
    const attach = (group, id) => {
      let set = byGroup.get(group)
      if (!set) byGroup.set(group, (set = new Set()))
      set.add(id)
    }
    for (const item of items) {
      const id = item?.model_name
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof item.description === 'string' && item.description.length > 0) {
        meta.set(id, item.description)
      }
      const enabled = Array.isArray(item.enable_groups) ? item.enable_groups : []
      if (enabled.includes('all')) {
        for (const route of state.routes.values()) attach(route.group, id)
        continue
      }
      for (const group of enabled) attach(group, id)
    }
    // `auto` is a pseudo-group resolved server-side over a configured pool;
    // the response carries that pool in auto_groups.
    if (state.routes.has(`${ROUTE_PREFIX}auto`)) {
      for (const pool of Array.isArray(body.auto_groups) ? body.auto_groups : []) {
        for (const id of byGroup.get(pool) ?? []) attach('auto', id)
      }
    }
    return { byGroup, meta, total: items.length }
  }

  // Site amount display settings (quota unit, currency, rate). Cached per fiber
  // once fetched; a failed fetch falls back to defaults without caching.
  let displayConfig
  const loadDisplay = async () => {
    if (displayConfig) return displayConfig
    const { body } = await apiJson('/api/status')
    if (!body?.success) return DEFAULT_DISPLAY
    const d = body.data ?? {}
    displayConfig = {
      perUnit: Number(d.quota_per_unit) || DEFAULT_DISPLAY.perUnit,
      type: d.quota_display_type || (d.display_in_currency === false ? 'TOKENS' : 'USD'),
      usdRate: Number(d.usd_exchange_rate) || 1,
      symbol: d.custom_currency_symbol || '¤',
      customRate: Number(d.custom_currency_exchange_rate) || 1,
    }
    return displayConfig
  }

  const fetchProfile = async () => {
    state.profileTriedAt = Date.now()
    const display = await loadDisplay().catch(() => DEFAULT_DISPLAY)
    const { res, body } = await apiJson('/api/user/self', {
      headers: { authorization: `Bearer ${state.accessToken}` },
    })
    if (!body?.success) {
      trace('profile FAILED', { http: res.status, message: String(body?.message ?? '').slice(0, 200) })
      throw new Error(body?.message ?? `profile failed (HTTP ${res.status})`)
    }
    const u = body.data ?? {}
    trace('profile ok', { http: res.status, display: display.type, hasQuota: typeof u.quota === 'number' })
    state.profile = normProfile({
      id: u.id,
      name: u.display_name || u.username || state.user,
      group: u.group,
      balance: formatQuota(u.quota, display),
      used: formatQuota(u.used_quota, display),
      requests: u.request_count,
      updatedAt: Date.now(),
    })
  }

  // At most one pending retry; each consecutive passing failure doubles the
  // delay. A successful group load or a teardown ends the series.
  let retryRound = 0
  const scheduleRetry = () => {
    if (retryTimer !== undefined || disposed) return
    const delay = Math.min(SITE_RETRY_BASE_MS * 2 ** retryRound, SITE_RETRY_MAX_MS)
    retryRound++
    trace('reconcile retry scheduled', { delayS: delay / 1000 })
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      reconcile()
    }, delay)
    // A pending retry must not keep the host process alive.
    retryTimer.unref?.()
  }
  const cancelRetry = () => {
    clearTimeout(retryTimer)
    retryTimer = undefined
    retryRound = 0
  }

  const applyGroups = async (username, force = false) => {
    const key = `${state.sid}::${username}`
    // Full reloads (groups + pricing catalog) are the expensive ones on the
    // site: /api/user/self/groups runs room listings with recommendation,
    // review and supply aggregation. A settings-page refresh more often than
    // FULL_REFRESH_MIN_INTERVAL_MS therefore refreshes only the profile.
    const reload = force && Date.now() - state.lastFullRefreshAt >= FULL_REFRESH_MIN_INTERVAL_MS
    const fresh = state.appliedKey !== key || reload
    trace('applyGroups', { fresh, force, reload, profileAgeS: Math.round((Date.now() - state.profile.updatedAt) / 1000) })
    if (fresh) {
      if (reload) {
        state.lastFullRefreshAt = Date.now()
        state.groupModels = new Map()
        state.groupFailures = new Map()
      }
      const { res, body } = await apiJson('/api/user/self/groups', {
        headers: { authorization: `Bearer ${state.accessToken}` },
      })
      if (!body?.success) {
        throw new SiteError(body?.message ?? `group list failed (HTTP ${res.status})`, res.status)
      }
      const routes = new Map()
      for (const [key, info] of Object.entries(body.data ?? {})) {
        const base = info?.is_room ? (info.room_name || key) : key
        // The billing ratio rides the provider display name (`名称 ×0.5`) so
        // every picker shows it; the client splits it back out for styling.
        const ratio = formatRatio(info?.ratio)
        const label = ratio ? `${base} ${RATIO_MARK}${ratio}` : base
        // Account rooms serve a provider-registry model set narrowed by an
        // AllowedModels whitelist — the one surface pricing does not reflect.
        routes.set(`${ROUTE_PREFIX}${key}`, {
          group: key,
          name: label,
          account: info?.is_room === true && info?.kind === 'account',
        })
      }
      applyRoutes(routes)
      state.catalog = await fetchCatalog().catch(() => null)
      state.catalogFailedAt = state.catalog ? 0 : Date.now()
      state.appliedKey = key
    }
    // Profile (balance etc.): on login, on explicit refresh, and when the
    // cached copy is older than PROFILE_TTL_MS. Failures keep the previous
    // copy and are retried at most once a minute unless forced.
    const now = Date.now()
    if (
      fresh
      || force
      || (now - state.profile.updatedAt > PROFILE_TTL_MS && now - state.profileTriedAt > PROFILE_RETRY_MS)
    ) {
      await fetchProfile().catch((error) => ctx.logger.warn('pixel-api: profile refresh failed:', error))
    }
    writeAuth({
      state: 'ok',
      message: '',
      user: state.user || username,
      groupCount: state.routes.size,
      models: state.catalog?.total ?? -1,
      profile: state.profile,
    })
    cancelRetry()
  }

  const teardown = async (message, { revoke = false } = {}) => {
    cancelRetry()
    if (revoke) await serverLogout()
    await unsetCred(REFS.refresh)
    state.accessToken = ''
    state.accessExpiresAt = 0
    state.sid = ''
    state.user = ''
    state.challenge = null
    state.appliedKey = ''
    state.catalog = null
    state.catalogFailedAt = 0
    state.groupModels = new Map()
    state.groupFailures = new Map()
    state.profile = { ...EMPTY_PROFILE }
    state.profileTriedAt = 0
    applyRoutes(new Map())
    writeAuth({ state: 'none', message: message ?? '', user: '', groups: [], models: -1 })
  }

  // All session mutations serialize on one chain: a settings write landing
  // while a refresh is in flight observes a settled state, never a half-adopted
  // bundle.
  let chain = Promise.resolve()
  const enqueue = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  const reconcile = () => {
    void enqueue(async () => {
    if (disposed) return
    const section = sectionOf()
    const username = (section.username ?? '').trim()
    const auth = section.auth ?? {}
    // A newer refreshAt from the settings page forces a full refetch once.
    const force = section.refreshAt > state.handledRefreshAt
    if (force) state.handledRefreshAt = section.refreshAt
    // A newer signOutAt from the settings page is an explicit sign-out: revoke
    // the site session instead of only forgetting it locally. The served value
    // is stamped into every status write, so a reload never replays it.
    state.statusSignOutAt = Math.max(state.statusSignOutAt, Number(auth.signOutAt ?? 0) || 0)
    const signOut = section.signOutAt > state.statusSignOutAt
    if (signOut) state.statusSignOutAt = section.signOutAt
    trace('reconcile', { user: !!username, force, signOut, accessFresh: accessFresh(), challenge: !!state.challenge })

    const otp = await resolveCred(REFS.otp)
    const refreshToken = await resolveCred(REFS.refresh)
    const password = await resolveCred(REFS.password)

    // A stored password with a live refresh cookie is a leftover from an older
    // build: the session alone is enough, and a plaintext password must not sit
    // on disk. Drop it before any branch can use it.
    if (password && refreshToken) await unsetCred(REFS.password)

    // Explicit sign-out: revoke first (serverLogout needs the live access token
    // and the refresh cookie), then drop every credential this plugin owns and
    // tear the routes down. Runs before the ordinary branches so a sign-out that
    // also cleared the username cannot be mistaken for "nothing configured".
    if (signOut) {
      await teardown('', { revoke: true })
      for (const ref of OWN_REFS) await unsetCred(ref)
      return
    }

    if (state.challenge) {
      if (!otp) {
        if (auth.state !== '2fa') {
          writeAuth({ state: '2fa', message: '该账号启用了两步验证，请输入 TOTP 验证码', user: username, groups: [] })
        }
        return
      }
      try {
        await completeChallenge(otp)
      } catch (error) {
        await unsetCred(REFS.otp)
        state.challenge = null
        writeAuth({ state: 'error', message: String(error?.message ?? error), user: username, groups: [] })
        return
      }
      await unsetCred(REFS.otp)
      await applyGroups(username)
      return
    }

    if (!username && !refreshToken) {
      if (auth.state !== 'none' || state.routes.size > 0) await teardown('')
      return
    }

    if (accessFresh()) {
      try {
        await applyGroups(username, force)
      } catch (error) {
        // A passing failure goes to the outer handler, which retries.
        if (isRetryableSiteError(error)) throw error
        writeAuth({ state: 'error', message: String(error?.message ?? error), user: username, groups: [] })
      }
      return
    }

    if (refreshToken) {
      try {
        await refreshSession(refreshToken)
      } catch (error) {
        // No answer, a 5xx or a refresh race says nothing about the session:
        // keep the cookie and leave the retry to the outer handler. Only a
        // refusal from the site ends the session here.
        if (isRetryableSiteError(error)) throw error
        await unsetCred(REFS.refresh)
        if (username && password) {
          try {
            await loginFlow(username, password)
          } catch (error) {
            writeAuth({ state: 'error', message: String(error?.message ?? error), user: username, groups: [] })
            return
          }
          if (state.challenge) return
        } else {
          await teardown('登录会话已过期，请重新登录', { revoke: false })
          return
        }
      }
      await applyGroups(username, force)
      return
    }

    if (username && password) {
      try {
        await loginFlow(username, password)
      } catch (error) {
        writeAuth({ state: 'error', message: String(error?.message ?? error), user: username, groups: [] })
        return
      }
      if (state.challenge) return
      await applyGroups(username)
      return
    }

    if (username) {
      // Keep a login failure visible: overwriting it with "enter password"
      // would hide the reason the session is not connected.
      if (auth.state !== 'error') {
        writeAuth({ state: 'none', message: '请输入密码', user: username, groups: [] })
      }
    }
    }).catch((error) => {
      trace('reconcile FAILED', String(error?.message ?? error).slice(0, 300))
      ctx.logger.warn('pixel-api: reconcile failed:', error)
      // A passing site failure keeps the login and tries again later, under a
      // fixed status text (SITE_RETRY_MESSAGE); the reason is logged above.
      const retryable = isRetryableSiteError(error)
      if (retryable) scheduleRetry()
      try {
        writeAuth(retryable
          ? { state: 'error', message: SITE_RETRY_MESSAGE, user: (sectionOf().username ?? '').trim(), groups: [] }
          : { state: 'error', message: String(error?.message ?? error), user: '', groups: [] })
      } catch {
        // Status write itself failed — nothing more this fiber can do.
      }
    })
  }

  const ensureAccess = () => enqueue(async () => {
    if (accessFresh()) return state.accessToken
    const refreshToken = await resolveCred(REFS.refresh)
    if (refreshToken) {
      try {
        await refreshSession(refreshToken)
      } catch (error) {
        // A passing failure keeps the session: report it in a code the Harness
        // retries. AUTH is never retried, and the chat swaps its text for a
        // generic notice.
        if (isRetryableSiteError(error)) {
          const code = error.status === 0 ? 'TRANSPORT' : error.status === 429 ? 'RATE_LIMIT' : 'SERVER'
          throw new LlmError(`pixel-api: session refresh failed: ${error.message}`, code, {
            ...(error.status >= 400 ? { status: error.status } : {}),
            cause: error,
          })
        }
        throw new LlmError(`pixel-api: session refresh failed: ${error?.message ?? error}`, 'AUTH', { cause: error })
      }
      return state.accessToken
    }
    const section = sectionOf()
    const username = (section.username ?? '').trim()
    const password = await resolveCred(REFS.password)
    if (username && password) {
      await loginFlow(username, password)
      if (state.challenge) {
        throw new LlmError('pixel-api: 两步验证未完成，请先在设置 → PIXEL API 输入验证码', 'AUTH')
      }
      if (!accessFresh()) throw new LlmError('pixel-api: login did not produce a session', 'AUTH')
      return state.accessToken
    }
    throw new LlmError('pixel-api: not logged in — open 设置 → PIXEL API to sign in', 'MISSING_CREDENTIAL')
  })

  // Per-group model lookups (account rooms and the pricing-unavailable
  // fallback) serialize through a small pool so a catalog enumeration stays
  // polite against the site's request limiter.
  let inflight = 0
  const queue = []
  const pump = () => {
    while (inflight < 4 && queue.length > 0) {
      const job = queue.shift()
      inflight++
      job().finally(() => { inflight--; pump() })
    }
  }
  // Every enqueue must kick the pump — otherwise the job sits in the queue
  // forever and the picker's Promise.all over listModels never settles.
  const schedule = (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject))
      pump()
    })

  // Concurrent picker sweeps share one in-flight lookup per group.
  const groupPending = new Map()
  const groupModels = async (group, provider) => {
    let ids = state.groupModels.get(group)
    if (ids === undefined) {
      // Negative cache: a recently failed group answers empty without a
      // request until its cooldown elapses.
      const blockedUntil = state.groupFailures.get(group) ?? 0
      if (blockedUntil > Date.now()) return []
      let pending = groupPending.get(group)
      if (pending === undefined) {
        const failures = state.groupFailures
        pending = schedule(async () => {
          const token = await ensureAccess()
          const res = await siteFetch(`${SITE}/api/user/models?group=${encodeURIComponent(group)}`, {
            headers: { authorization: `Bearer ${token}`, ...attributionHeaders() },
            signal: AbortSignal.timeout(GROUP_MODELS_TIMEOUT_MS),
          })
          const body = await res.json().catch(() => null)
          if (!body?.success) {
            throw new LlmError(
              `pixel-api: model list for group "${group}" failed: ${body?.message ?? `HTTP ${res.status}`}`,
              res.status === 401 ? 'AUTH' : 'SERVER',
            )
          }
          const list = Array.isArray(body.data) ? body.data : []
          state.groupModels.set(group, list)
          failures.delete(group)
          return list
        }).catch((error) => {
          // Only record against the same session generation (teardown swaps the map).
          failures.set(group, Date.now() + GROUP_FAILURE_COOLDOWN_MS)
          throw error
        }).finally(() => groupPending.delete(group))
        groupPending.set(group, pending)
      }
      ids = await pending
    }
    return ids.map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text', 'image'],
      reasoning: { efforts: REASONING_EFFORTS.map((effort) => ({ ...effort })) },
    }))
  }

  // Pricing catalog unavailable: retry the single /api/pricing call at most
  // once per CATALOG_RETRY_MS; fan out per group only for small accounts.
  let catalogRetry
  const fallbackModels = async (group, provider) => {
    if (!state.catalog && Date.now() - state.catalogFailedAt >= CATALOG_RETRY_MS && state.accessToken) {
      catalogRetry ??= fetchCatalog()
        .catch(() => null)
        .then((catalog) => {
          state.catalog = catalog
          state.catalogFailedAt = catalog ? 0 : Date.now()
        })
        .finally(() => { catalogRetry = undefined })
      await catalogRetry
    }
    const catalog = state.catalog
    if (catalog) {
      return [...(catalog.byGroup.get(group) ?? [])].map((id) => ({
        provider,
        id,
        name: id,
        inputModalities: ['text', 'image'],
        reasoning: { efforts: REASONING_EFFORTS.map((effort) => ({ ...effort })) },
        ...(catalog.meta.has(id) ? { description: catalog.meta.get(id) } : {}),
      }))
    }
    if (state.routes.size > FALLBACK_MAX_GROUPS) return []
    return groupModels(group, provider)
  }

  // Request images come from the durable attachment service the same way the
  // shipped pi-ai adapter reads them: one bounded normalized version per
  // retained image, base64 inlined into the data URL.
  const images = () => {
    const store = ctx.get('attachments')
    if (store === undefined || typeof store.readImageRequest !== 'function') {
      throw new LlmError(
        'pixel-api: image input needs the attachment service, which this profile does not mount',
        'UNSUPPORTED_CONTENT',
      )
    }
    const cache = new Map()
    return {
      async read(ref) {
        const key = ref.attachmentId
        let pending = cache.get(key)
        if (pending === undefined) {
          const target = imageTarget(ref)
          trace('image target', { size: `${target.width}x${target.height}`, maxBytes: target.maxBytes,
            source: `${ref?.width ?? '?'}x${ref?.height ?? '?'}`, mediaType: ref?.mediaType })
          pending = store.readImageRequest(ref, target).catch((error) => {
            cache.delete(key)
            trace('image FAILED', String(error?.message ?? error).slice(0, 200))
            throw new LlmError(
              `pixel-api: cannot prepare image ${String(key).slice(0, 16)}: ${error?.message ?? error}`,
              'UNSUPPORTED_CONTENT',
              { cause: error },
            )
          })
          cache.set(key, pending)
        }
        return pending
      },
    }
  }

  const adapter = new PixelAdapter({
    routes: () => state.routes,
    catalog: () => state.catalog,
    contextWindow: contextWindowOf,
    openaiReasoningReplay: openaiReasoningReplayOf,
    groupModels,
    fallbackModels,
    images,
    ensureAccess,
    invalidateAccess: () => {
      state.accessToken = ''
      state.accessExpiresAt = 0
    },
  })

  // Suppress the auto-generated form — the settings.section slot renders its own UI.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // Volatile commits fire loader/volatile-update on this fiber; credential
  // writes fire reference/record events. Both drive the same reconcile.
  ctx.on('loader/volatile-update', () => {
    reconcile()
    reconcileUpdate()
  })
  ctx.on('credentials/reference-updated', (ref) => {
    // An explicit password (re)entry from the settings page is a deliberate
    // user retry — lift the automatic-login backoff for it.
    if (ref === REFS.password) {
      loginGuard.key = ''
      loginGuard.failures = 0
      loginGuard.until = 0
    }
    if (OWN_REFS.has(ref)) reconcile()
  })
  ctx.on('credentials/record-updated', () => reconcile())

  reconcile()
  reconcileUpdate()
}
