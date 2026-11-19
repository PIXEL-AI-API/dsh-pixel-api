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
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'

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

export const Config = z.object({
  username: z.string().default('').volatile(),
  // Context window (tokens) declared to the Harness for PIXEL models.
  contextWindow: z.natural().default(DEFAULT_CONTEXT_WINDOW).volatile(),
  // Per-model context windows keyed by an exact model id or a `prefix*`
  // pattern (case-insensitive; exact beats prefix, longer prefix wins).
  contextWindows: z.dict(z.natural()).default({}).volatile(),
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
})

const SITE = 'https://api.ai-pixel.online'
// Every request to the site refuses redirects: a 307/308 would re-send the
// Authorization header (and a login body, password included) to whatever host
// the redirect names.
const siteFetch = (url, init) => fetch(url, { redirect: 'error', ...init })
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

// Failed password logins back off exponentially: 1m, 2m, 4m … capped at 30m.
const LOGIN_BACKOFF_BASE_MS = 60_000
const LOGIN_BACKOFF_MAX_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Wire serialization (OpenAI chat-completions shape plus the playground
// `group` field the site's controller routes on).
// ---------------------------------------------------------------------------

// Join one block list's text blocks (user/system/tool-result content).
function flattenText(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

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

// OpenAI chat-completions content parts for one block list. Text-only content
// stays a plain string (smaller payload, accepted by every upstream model);
// image blocks become `image_url` data URLs, which the site's relay forwards
// verbatim to the upstream model.
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
      parts.push({ type: 'text', text: '[image omitted to fit the request limits]' })
      continue
    }
    const version = await images.read(block.attachment)
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
    })
  }
  // An image-only turn must still carry a text part: some upstream models
  // reject a content array without one.
  if (!parts.some((part) => part.type === 'text')) parts.unshift({ type: 'text', text: '' })
  return parts
}

function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))

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
  }
}

async function serializeMessages(messages, images) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pixel-api: a system message cannot carry an image', 'UNSUPPORTED_CONTENT')
      }
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness vocabulary,
    // but the wire wants them as standalone role:'tool' messages.
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const content = await serializeContent(message.content, images)
    const hasContent = typeof content === 'string' ? content.length > 0 : true
    if (hasContent || toolResults.length === 0) {
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

async function serializeRequest(options, group, images) {
  const messages = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessages(options.messages, images))

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
// success).
// ---------------------------------------------------------------------------

async function* parseSse(stream, onComment) {
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
    throw new LlmError('pixel-api: SSE stream ended without [DONE]', 'STREAM_CLOSED')
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

function mapFinishReason(reason) {
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
      return { kind: 'error', failure: { message: `unknown finish_reason "${reason}"`, code: 'UNKNOWN_FINISH_REASON' } }
  }
}

function mapUsage(usage) {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    cacheReadTokens: usage.prompt_cache_hit_tokens ?? 0,
    cacheWriteTokens: usage.prompt_cache_miss_tokens ?? 0,
  }
}

async function* translate(payloads) {
  let nextIndex = 0
  let reasoningBlock
  let textBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage

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

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      // A content-filter stop is a refusal, not a completed answer: report the
      // billed usage above, then fail the attempt the way the Harness's own
      // DeepSeek adapter fails a `refusal` stop.
      if (pendingFinish === REFUSED) {
        throw new LlmError(
          'pixel-api: the upstream model refused to answer under its content policy (finish_reason content_filter)',
          CONTENT_REFUSED_CODE,
        )
      }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new LlmError(`pixel-api: malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

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

      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  throw new LlmError('pixel-api: SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

// ---------------------------------------------------------------------------
// Provider error mapping.
// ---------------------------------------------------------------------------

function providerErrorCode(status, error) {
  // Classify on code, type and message together, as the runtime's classifiers
  // expect. The site tags a context overflow with code context_length_exceeded
  // but may pass the upstream's own wording through as the message (Claude
  // "prompt is too long: …", Gemini "The input token count …"), which a
  // message-only check misses — and overflow recovery keys on this code.
  const code = typeof error?.code === 'string' ? error.code : ''
  const detail = [code, error?.type, error?.message]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (REFUSAL_ERROR_CODES.has(code.toLowerCase())) return CONTENT_REFUSED_CODE
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'PROVIDER_ERROR'
  return 'BAD_REQUEST'
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
    const payload = JSON.stringify(await serializeRequest(options, group, this.deps.images()))
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
      throw new LlmError(message, providerErrorCode(response.status, providerError), { status: response.status })
    }
    if (!response.body) {
      throw new LlmError('pixel-api: site returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translate(parseSse(response.body, onComment))
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
  ctx.effect(() => () => { disposed = true; trace('fiber disposed') }, 'pixel-api: teardown')

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
  // so a changed window applies to the next request without a fiber restart.
  const contextWindowOf = (model) => {
    const cfg = config ?? ctx.config ?? {}
    return contextWindowFor(model, Number(cell(cfg.contextWindow)), cell(cfg.contextWindows))
  }

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
    // Work started from apply() (inside a reload) or from loader/volatile-update
    // (inside a settings commit) inherits the HMR service's `executing`
    // AsyncLocalStorage, and configEditor.edit → hmr.runExclusive then rejects
    // with "HMR transactions cannot be nested". Leave that async context —
    // the same escape HMR uses for its own config watcher. The edit is then
    // queued behind the running transaction; nothing awaits it, so it cannot
    // deadlock the transaction.
    const hmrExec = ctx.get('hmr')?.executing
    const outside = (fn) => (hmrExec && typeof hmrExec.exit === 'function' && hmrExec.getStore?.()
      ? hmrExec.exit(fn)
      : fn())
    outside(() => editor.edit(entry, (raw) => ({ ...(raw ?? {}), auth: next }))).then(
      () => trace('writeAuth edit ok'),
      (err) => {
        trace('writeAuth edit FAILED', String(err?.message ?? err))
        ctx.logger.warn('pixel-api: status write failed:', err)
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
    const res = await siteFetch(`${SITE}${path}`, {
      ...init,
      headers: { ...attributionHeaders(), ...init?.headers },
    })
    const body = await res.json().catch(() => null)
    return { res, body }
  }

  // Login backoff: a failed password login blocks further automatic attempts
  // for the SAME username+password (compared by hash, never stored in clear)
  // with exponential delay. Changing the password or username resets it.
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
      loginGuard.failures++
      const delay = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (loginGuard.failures - 1), LOGIN_BACKOFF_MAX_MS)
      loginGuard.until = Date.now() + delay
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
      throw new Error(body?.message ?? `session refresh failed (HTTP ${res.status})`)
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
        throw new Error(body?.message ?? `group list failed (HTTP ${res.status})`)
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
  }

  const teardown = async (message, { revoke = false } = {}) => {
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
        writeAuth({ state: 'error', message: String(error?.message ?? error), user: username, groups: [] })
      }
      return
    }

    if (refreshToken) {
      try {
        await refreshSession(refreshToken)
      } catch {
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
      try {
        writeAuth({ state: 'error', message: String(error?.message ?? error), user: '', groups: [] })
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
              res.status === 401 ? 'AUTH' : 'PROVIDER_ERROR',
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
  ctx.on('loader/volatile-update', () => reconcile())
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
}
