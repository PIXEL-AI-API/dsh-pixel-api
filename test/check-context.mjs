// Host-half check: declared context capacity, error classification (HTTP
// errors and stream error frames), usage mapping, session refresh failures,
// site call timeouts, the wire shape of tool results, and the site's replay
// data (capture, send-back rules, and a round trip through the agent loop's
// own assembly); then the sign-in lifecycle: going back from the 2FA step, a
// rotated refresh cookie the credential store cannot keep, route names that
// follow the site, a profile without the attachment service, and a chat 401
// landing while a reconcile is in flight.
// Boots the real plugin module against the real LlmRuntime with a fake ctx and
// a mocked PIXEL site — no network, no credentials, nothing billed.
//
//   Desktop runtime (modules inside app.asar):
//     ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/check-context.mjs [out-file]
//   Any runtime whose @deepseek-ai/* packages resolve from the plugin directory:
//     node test/check-context.mjs [out-file]
//
// Exits 1 when a check fails.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const lines = []
let failures = 0
const log = (line) => { lines.push(line); console.log(line) }
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
}
const finish = () => {
  log(failures === 0 ? 'ALL OK' : `${failures} FAILED`)
  if (process.argv[2]) writeFileSync(process.argv[2], lines.join('\n'))
  process.exit(failures === 0 ? 0 : 1)
}
process.on('unhandledRejection', (error) => {
  log(`  FAIL unhandled rejection :: ${error?.stack ?? error}`)
  failures += 1
})

// Same resolution order as index.js: the Desktop archive, then bare specifiers.
const runtimeRoot = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules')
const runtimeImport = async (id, file) => {
  try {
    return await import(pathToFileURL(join(runtimeRoot, id, file)).href)
  } catch {
    return import(id)
  }
}

const { Context } = await runtimeImport('@deepseek-ai/cordis', 'lib/index.js')
const { AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, LlmRuntime } = await runtimeImport('@deepseek-ai/dsh-llm', 'lib/index.js')
const { isJsonValue } = await runtimeImport('@deepseek-ai/dsh-util-values', 'lib/index.js')
const plugin = await import(pathToFileURL(join(here, '..', 'index.js')).href)
const WRITE = Symbol.for('cosmokit.volatile.write')
const read = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)

// ---------------------------------------------------------------------------
log('Config')
const defaults = plugin.Config({})
check('default contextWindow is 272000', read(defaults.contextWindow) === 272000, read(defaults.contextWindow))
check('default contextWindows is empty', JSON.stringify(read(defaults.contextWindows)) === '{}', read(defaults.contextWindows))
check('default openaiReasoningReplay is false', read(defaults.openaiReasoningReplay) === false, read(defaults.openaiReasoningReplay))
const rejects = (input) => { try { plugin.Config(input); return false } catch { return true } }
check('rejects a non-numeric contextWindow', rejects({ contextWindow: '272k' }))
check('rejects a fractional contextWindow', rejects({ contextWindow: 1.5 }))
check('rejects a negative per-model window', rejects({ contextWindows: { x: -5 } }))
check('rejects a non-boolean openaiReasoningReplay', rejects({ openaiReasoningReplay: 'yes' }))
// The window floor is applied where the window is declared, never by the
// schema: a profile already holding a smaller window must keep loading.
check('still accepts a window under the floor (a profile holding one loads)',
  !rejects({ contextWindow: 100 }) && !rejects({ contextWindows: { x: 1000 } }))
check('default cancelChallengeAt is 0, a live cell', read(defaults.cancelChallengeAt) === 0
  && typeof defaults.cancelChallengeAt?.[WRITE] === 'function', read(defaults.cancelChallengeAt))

// ---------------------------------------------------------------------------
// Mocked site. Every request must refuse redirects (index.js siteFetch).
const SITE = 'https://api.ai-pixel.online'
const chatBodies = []
let chat = () => { throw new Error('no chat responder') }
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const sse = (events, headers = {}) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder()
    for (const event of events) {
      controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`))
    }
    controller.close()
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
// The site's session bundle: what a refresh, a login and a 2FA check return.
// Each one carries a token of its own, as the site's do.
let bundlesIssued = 0
const sessionBundle = () => ({
  access_token: `mock-access-token-${++bundlesIssued}`,
  access_expires_at: Math.floor(Date.now() / 1000) + 3600,
  session: { sid: 'sid-1' },
  user: { username: 'tester' },
})
// The same bundle with the refresh cookie the site rotates on every session it
// issues (new-api-main service/auth_session.go: WriteRefreshCookie).
let cookiesRotated = 0
const rotatedBundle = () => json({ success: true, data: sessionBundle() }, 200,
  { 'set-cookie': `new_api_refresh=rotated-${++cookiesRotated}; Path=/; HttpOnly; SameSite=Strict` })
// A site that stops answering, the way undici reports it: the request (or,
// once its headers arrived, the body read) fails with the reason of the signal
// the caller passed, when that signal fires. A request without a signal would
// hang for good, so it fails after 2 s with NO_SIGNAL instead: the check that
// expects a timeout reports it, and the run still ends. How each one ended is
// recorded in stuckRequests.
const NO_SIGNAL = 'mock site: the request carried no abort signal'
const stuckRequests = []
const whenStuck = (path, init, fail) => {
  const record = { path, ended: '' }
  stuckRequests.push(record)
  const end = (reason) => {
    record.ended = reason?.name === 'TimeoutError' ? 'timeout' : String(reason?.message ?? reason)
    fail(reason)
  }
  const { signal } = init
  if (!(signal instanceof AbortSignal)) {
    // 2 s is under the 10 s threshold of the timer hold further down.
    setTimeout(() => end(new Error(NO_SIGNAL)), 2_000)
  } else if (signal.aborted) {
    end(signal.reason)
  } else {
    signal.addEventListener('abort', () => end(signal.reason), { once: true })
  }
}
const hang = (path, init) => new Promise((_, reject) => whenStuck(path, init, reject))
const stalledBody = (path, init) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"success":true,"data":{'))
    whenStuck(path, init, (reason) => controller.error(reason))
  },
}), { status: 200, headers: { 'content-type': 'application/json' } })
// Session refresh outcome, switched per case. The failures are the site's own
// shapes (new-api-main controller/auth_session.go writeAuthSessionError) and
// what undici throws when the site cannot be reached; 'hang' never answers,
// 'stall' sends its headers and part of the body, then nothing more.
let refreshMode = 'ok'
const refreshReply = (init) => {
  switch (refreshMode) {
    case 'network':
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.ai-pixel.online'), { code: 'ENOTFOUND' }),
      })
    case 'hang':
      return hang('/api/user/auth/refresh', init)
    case 'stall':
      return stalledBody('/api/user/auth/refresh', init)
    case '500':
      return json({ success: false, code: 'AUTH_INTERNAL_ERROR', message: 'Internal Server Error' }, 500)
    case '502':
      return new Response('<html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>',
        { status: 502, headers: { 'content-type': 'text/html' } })
    case '401':
      return json({ success: false, code: 'AUTH_SESSION_REVOKED', message: 'Unauthorized' }, 401)
    case 'rotate':
      return rotatedBundle()
    default:
      return json({ success: true, data: sessionBundle() })
  }
}
// Sign-in outcomes, switched per case. A login answers a session (with or
// without the rotated cookie), a 2FA challenge or a refusal (HTTP 200 with
// success:false, as new-api answers a wrong password), or hangs; the 2FA check
// answers a session (with or without the cookie) or hangs; the logout answers
// or hangs.
let loginMode = 'ok'
let verifyMode = 'ok'
let logoutMode = 'ok'
let challengesIssued = 0
const loginReply = (init) => {
  switch (loginMode) {
    case 'hang':
      return hang('/api/user/login', init)
    case 'reject':
      return json({ success: false, message: '用户名或密码错误，或用户已被封禁' })
    case '2fa':
      return json({ success: true, data: { require_verification: true, flow_token: `flow-${++challengesIssued}` } })
    case 'rotate':
      return rotatedBundle()
    default:
      return json({ success: true, data: sessionBundle() })
  }
}
const verifyReply = (init) => {
  switch (verifyMode) {
    case 'hang':
      return hang('/api/user/login/verify', init)
    case 'rotate':
      return rotatedBundle()
    default:
      return json({ success: true, data: sessionBundle() })
  }
}
// The group list, switched per case; a set gate holds its answer until opened.
const DEFAULT_GROUPS = { 'room-1024': { is_room: true, room_name: 'Room 1024', ratio: 0.5, kind: 'pool' }, default: { ratio: 1 } }
let siteGroups = DEFAULT_GROUPS
let groupsGate
let redirectViolations = 0
// Every /api/* request, whether it carried an abort signal (index.js bounds
// each site call; /pg/chat/completions has its idle watchdog instead), and the
// Authorization it sent.
const apiCalls = []
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.origin !== SITE) throw new Error(`unexpected host ${target.origin}`)
  if (init.redirect !== 'error') redirectViolations += 1
  if (target.pathname.startsWith('/api/')) {
    apiCalls.push({
      path: target.pathname,
      signalled: init.signal instanceof AbortSignal,
      authorization: new Headers(init.headers ?? {}).get('authorization'),
    })
  }
  switch (target.pathname) {
    case '/api/user/auth/refresh':
      return refreshReply(init)
    case '/api/user/login':
      return loginReply(init)
    case '/api/user/login/verify':
      return verifyReply(init)
    case '/api/user/auth/logout':
      return logoutMode === 'hang' ? hang(target.pathname, init) : json({ success: true })
    case '/api/user/self/groups':
      if (groupsGate !== undefined) await groupsGate
      return json({ success: true, data: siteGroups })
    case '/api/pricing':
      return json({
        success: true,
        data: [
          { model_name: 'gemini-4-hydrogen', enable_groups: ['room-1024'] },
          { model_name: 'claude-opus-5-5', enable_groups: ['default', 'room-1024'] },
          { model_name: 'gpt-6.2-sol', enable_groups: ['default'] },
        ],
      })
    case '/api/status':
      return json({ success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } })
    case '/api/user/self':
      return json({ success: true, data: { id: 7, username: 'tester', quota: 500000, used_quota: 1000, request_count: 3, group: 'default' } })
    case '/pg/chat/completions': {
      const body = JSON.parse(init.body)
      chatBodies.push(body)
      return chat(body, init)
    }
    default:
      return json({ success: false, message: `unexpected ${target.pathname}` }, 404)
  }
}

// Real LlmRuntime in a bare Cordis app; the plugin gets a fake ctx around it.
const app = new Context()
await app.plugin(LlmRuntime)
const llm = app.get('llm')
const registered = []
const credentials = new Map([['PIXEL_API_REFRESH', 'seed-refresh']])
const warnings = []
// Image bytes per case. The default refuses, so a case that must not read an
// image fails its request when it does.
const noImages = async () => { throw new Error('no images in this check') }
let readImageRequest = noImages
// Each refused credential write names another temp file, as the local store's
// writeFileAtomic does (dsh-atomic-write: `<file>.<random>.tmp`).
let refusedWrites = 0
// A fake ctx around one real LlmRuntime; `edit` receives the status writes.
// Given `listeners`, the event handlers the plugin registers are kept there so
// a check can fire them the way the host's events do. `attachments: false`
// mounts no attachment service; a ref in `failingWrites` makes the credential
// store refuse to set it.
const fakeCtxFor = ({ runtime, credentials, warnings, registered, edit = async () => {}, listeners, attachments = true, failingWrites }) => ({
  logger: { warn: (...parts) => warnings.push(parts.map(String).join(' ')), info() {}, debug() {}, error() {} },
  effect(fn) { fn(); return () => {} },
  on(name, listener) {
    listeners?.set(name, [...(listeners.get(name) ?? []), listener])
    return () => {}
  },
  inject() {},
  get(name) {
    if (name === 'credentials') {
      return {
        resolve: async (ref) => (credentials.has(ref) ? { value: credentials.get(ref) } : undefined),
        set: async (ref, value) => {
          if (failingWrites?.has(ref)) {
            throw new Error(`EPERM: operation not permitted, open 'credentials.env.${++refusedWrites}.tmp'`)
          }
          credentials.set(ref, value)
        },
        unset: async (ref) => { credentials.delete(ref) },
      }
    }
    if (name === 'configEditor') return { edit }
    if (name === 'attachments') {
      return attachments ? { readImageRequest: (ref, target) => readImageRequest(ref, target) } : undefined
    }
    return undefined
  },
  fiber: { entry: { id: 'pixel-api' } },
  llm: {
    registerAdapter(ids, adapter) {
      registered.push(ids)
      return runtime.registerAdapter(ids, adapter)
    },
  },
})
const fakeCtx = fakeCtxFor({ runtime: llm, credentials, warnings, registered })

const config = plugin.Config({
  username: 'tester',
  contextWindows: {
    'gemini-*': 1048576,
    'gemini-4-*': 2000000,
    'Claude-Opus-5-5': 1000000,
    '*': 99999999,
    bad: 0,
  },
})
plugin.apply(fakeCtx, config)
for (let i = 0; i < 100 && registered.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
check('routes registered through the real LlmRuntime', registered.length > 0, warnings)
if (registered.length === 0) finish()
check('route ids', JSON.stringify(registered[0]) === JSON.stringify(['pixel/room-1024', 'pixel/default']), registered[0])

// ---------------------------------------------------------------------------
log('Declared capacity (real LlmRuntime.resolveModelInfo)')
const capacity = async (provider, model) => {
  const info = await llm.resolveModelInfo(provider, model)
  return info.context?.contextWindow
}
const expectWindow = async (label, provider, model, expected) => {
  try {
    const got = await capacity(provider, model)
    check(`${label}: ${provider}/${model} -> ${expected}`, got === expected, got)
  } catch (error) {
    check(`${label}: ${provider}/${model}`, false, `${error?.code}: ${error?.message}`)
  }
}
await expectWindow('longest prefix wins', 'pixel/room-1024', 'gemini-4-hydrogen', 2000000)
await expectWindow('shorter prefix', 'pixel/room-1024', 'gemini-3-pro', 1048576)
await expectWindow('exact id, case-insensitive', 'pixel/default', 'claude-opus-5-5', 1000000)
await expectWindow('bare * ignored, default applies', 'pixel/default', 'gpt-6.2-sol', 272000)
await expectWindow('unusable override skipped', 'pixel/default', 'bad', 272000)
const info = await llm.resolveModelInfo('pixel/room-1024', 'gemini-4-hydrogen')
check('no defaultMaxTokens declared (no max_tokens materialized)', info.defaultMaxTokens === undefined, info.defaultMaxTokens)
check('image input and reasoning ladder still declared',
  JSON.stringify(info.inputModalities) === '["text","image"]' && info.reasoning?.efforts?.length === 6, info)

// Live volatile edits, as the settings page commits them. (Optional calls keep
// a baseline run against an older index.js reporting instead of crashing.)
config.contextWindow?.[WRITE]?.(300000)
config.contextWindows?.[WRITE]?.({})
await expectWindow('live default edit', 'pixel/default', 'gpt-6.2-sol', 300000)
await expectWindow('live override removal', 'pixel/room-1024', 'gemini-4-hydrogen', 300000)
config.contextWindow?.[WRITE]?.(0)
await expectWindow('invalid default falls back', 'pixel/room-1024', 'gemini-4-hydrogen', 272000)
// A positive window under the settings page's minimum (65537), as a direct
// config edit leaves it, is declared at that minimum — per model too, where it
// still wins over the default; one at the minimum is kept.
config.contextWindow?.[WRITE]?.(100)
await expectWindow('default under the floor is raised to 65537', 'pixel/default', 'gpt-6.2-sol', 65537)
config.contextWindow?.[WRITE]?.(65536)
await expectWindow('default of 65536 (compaction headroom) is raised to 65537', 'pixel/default', 'gpt-6.2-sol', 65537)
config.contextWindow?.[WRITE]?.(272000)
config.contextWindows?.[WRITE]?.({ 'tiny-model': 1000, 'floor-*': 65537 })
await expectWindow('exact override under the floor is raised, not skipped', 'pixel/default', 'tiny-model', 65537)
await expectWindow('prefix override at the floor is kept', 'pixel/default', 'floor-1', 65537)
config.contextWindows?.[WRITE]?.({})
config.contextWindow?.[WRITE]?.(272000)

// ---------------------------------------------------------------------------
// Mirror of compaction-basic's model-switch admission (src/index.ts
// compactPressure + src/config.ts resolveCompactSpec, default policy): the
// target needs a declared capacity, and window - reserved output - headroom
// must stay positive. PIXEL requests reserve no output (no maxTokens).
log('compaction-basic switch admission (mirrored formula, default policy)')
const spec = (window, reserved = 0, headroom = 65536, thresholdRatio = 0.8, retainRatio = 0.16) => {
  const message = window - reserved
  const pressure = message - headroom
  if (message <= 0 || pressure <= 0) return { ok: false }
  const threshold = Math.floor(Math.min(window * thresholdRatio, pressure))
  const retain = Math.floor(message * retainRatio)
  return { ok: retain < threshold, threshold, retain }
}
const switchInfo = await llm.resolveModelInfo('pixel/room-1024', 'gemini-4-hydrogen')
check('switch target declares context (was: "no context capacity")', switchInfo.context !== undefined)
const s272 = spec(272000)
check('272000 window leaves a pressure budget', s272.ok, s272)
log(`        threshold ${s272.threshold} tokens, retained tail ${s272.retain} tokens`)
check('65536 window would still be refused (settings page minimum is 65537)', spec(65536).ok === false)

// ---------------------------------------------------------------------------
log('Streams through the real LlmRuntime')
const run = async (responder, messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]) => {
  chat = responder
  const chunks = []
  for await (const chunk of llm.stream({
    provider: 'pixel/room-1024',
    model: 'gemini-4-hydrogen',
    messages,
  })) chunks.push(chunk)
  return chunks
}
const finishOf = (chunks) => chunks.findLast((c) => c.type === 'finish')?.reason
const choice = (delta, finishReason = null) => ({ choices: [{ index: 0, delta, finish_reason: finishReason }] })
const usage = { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, choices: [] }

let chunks = await run(() => sse([choice({ content: 'hello' }), choice({}, 'stop'), usage, '[DONE]']))
check('plain answer finishes stop', finishOf(chunks)?.kind === 'stop', finishOf(chunks))
check('request carries no max_tokens', !('max_tokens' in chatBodies.at(-1)), Object.keys(chatBodies.at(-1)))

chunks = await run(() => sse([
  choice({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p":1}' } }] }),
  choice({}, 'tool_calls'), usage, '[DONE]',
]))
check('tool call finishes tool-calls', finishOf(chunks)?.kind === 'tool-calls', finishOf(chunks))

chunks = await run(() => sse([choice({ content: 'partial' }), choice({}, 'content_filter'), usage, '[DONE]']))
check('content_filter fails CONTENT_REFUSED', finishOf(chunks)?.kind === 'error' && finishOf(chunks)?.failure?.code === 'CONTENT_REFUSED', finishOf(chunks))
check('usage reported before the refusal', chunks.some((c) => c.type === 'usage'))

const httpError = (status, error, headers) => () => json({ error }, status, headers)
chunks = await run(httpError(400, { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum (request id: r1)' }))
check('passed-through Claude overflow -> CONTEXT_WINDOW_EXCEEDED', finishOf(chunks)?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). (request id: r2)' }))
check('passed-through Gemini overflow -> CONTEXT_WINDOW_EXCEEDED', finishOf(chunks)?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'context_length_exceeded', type: 'invalid_request_error', message: "The input exceeds the model's context window. Please shorten the input and try again. (request id: r3)" }))
check('site-normalized overflow -> CONTEXT_WINDOW_EXCEEDED', finishOf(chunks)?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'content_policy_violation', type: 'invalid_request_error', message: 'The request was rejected by the content policy. (request id: r4)' }))
check('content policy rejection -> CONTENT_REFUSED', finishOf(chunks)?.failure?.code === 'CONTENT_REFUSED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'invalid_request', type: 'invalid_request_error', message: 'bad parameter (request id: r5)' }))
check('ordinary 400 -> INVALID_REQUEST', finishOf(chunks)?.failure?.code === 'INVALID_REQUEST', finishOf(chunks))

// ---------------------------------------------------------------------------
// The Harness retries only EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT and
// TRANSPORT by default, and its chat blanks the text of an AUTH failure: each
// site error must land on the code that says whether to wait or what to fix.
log('Error classification: HTTP errors')
const REQUEST_ID = '2026112011520347100389412'
const withRequestId = { 'x-oneapi-request-id': REQUEST_ID }
// Every key of `expected` must match the failure (undefined: must be absent).
const failureMatches = (failure, expected) => failure !== undefined
  && Object.entries(expected).every(([key, value]) => failure[key] === value)
const siteError = (code, type, message) => ({ message, type, code, param: '' })
const rateLimited = siteError('rate_limit_exceeded', 'rate_limit_error', '上游服务繁忙，请稍后重试。')
const httpCases = [
  ['503 service_unavailable -> SERVER, with its status and request id', 503,
    siteError('service_unavailable', 'server_error', '服务暂时不可用，请稍后重试。'),
    { code: 'SERVER', status: 503, requestId: REQUEST_ID }, withRequestId],
  ['502 -> SERVER (no request id header, none reported)', 502,
    siteError('server_error', 'server_error', '上游服务异常，请稍后重试。'), { code: 'SERVER', status: 502, requestId: undefined }],
  ['503 session_blocked -> SESSION_BLOCKED', 503,
    siteError('session_blocked', 'server_error', '该会话已被上游限制，请新建会话后再发起请求，不要在原来的会话上重试。'),
    { code: 'SESSION_BLOCKED', status: 503 }],
  ['429 rate_limit_exceeded + Retry-After: 7 -> RATE_LIMIT after 7000 ms', 429, rateLimited,
    { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 7000 }, { 'retry-after': '7' }],
  ['429 room_member_limit_exceeded -> QUOTA, not a rate limit', 429,
    siteError('room_member_limit_exceeded', 'new_api_error', '你在该分组今日的额度已用完'), { code: 'QUOTA', status: 429 }],
  ['403 insufficient_user_quota -> QUOTA', 403,
    siteError('insufficient_user_quota', 'new_api_error', '用户额度不足, 剩余额度: ¥0.01'), { code: 'QUOTA', status: 403 }],
  ['403 group_ratio_changed -> PRICE_CONFIRMATION_REQUIRED', 403,
    siteError('group_ratio_changed', 'new_api_error', '分组倍率已上调，请到主站确认后继续使用'), { code: 'PRICE_CONFIRMATION_REQUIRED' }],
  ['403 model_price_changed -> PRICE_CONFIRMATION_REQUIRED', 403,
    siteError('model_price_changed', 'new_api_error', '模型价格已上调，请到主站确认后继续使用'), { code: 'PRICE_CONFIRMATION_REQUIRED' }],
  ['403 access_denied -> ACCESS_DENIED, not AUTH', 403,
    siteError('access_denied', 'new_api_error', '该分组暂未开放'), { code: 'ACCESS_DENIED', status: 403 }],
]
for (const [label, status, error, expected, headers] of httpCases) {
  const failure = finishOf(await run(httpError(status, error, headers)))?.failure
  check(label, failureMatches(failure, { message: error.message, ...expected }), failure)
}
const sentBefore401 = chatBodies.length
const failure401 = finishOf(await run(httpError(401, siteError('', 'new_api_error', '未登录或登录已过期'))))?.failure
check('401 again after the session refresh -> AUTH', failureMatches(failure401, { code: 'AUTH', status: 401 })
  && chatBodies.length - sentBefore401 === 2, { failure401, requests: chatBodies.length - sentBefore401 })

const retryAfterOf = async (header) => finishOf(await run(httpError(429, rateLimited, { 'retry-after': header })))?.failure
const ahead = await retryAfterOf(new Date(Date.now() + 60_000).toUTCString())
check('Retry-After as a future HTTP date -> the delay until then',
  ahead?.providerRetryAfterMs > 50_000 && ahead?.providerRetryAfterMs <= 60_000, ahead)
for (const [label, header] of [['a past HTTP date', new Date(Date.now() - 60_000).toUTCString()], ['0', '0'], ['not a delay', 'soon']]) {
  const failure = await retryAfterOf(header)
  check(`Retry-After ${label} asks for no delay`, failureMatches(failure, { code: 'RATE_LIMIT', providerRetryAfterMs: undefined }), failure)
}

// ---------------------------------------------------------------------------
// After the response began, the site reports a failure as an `error` frame in
// the stream, with or without [DONE] after it (new-api-main
// relay/helper/stream_failure.go EndStreamWithError).
log('Error classification: stream error frames')
const serverFrame = { error: siteError('server_error', 'server_error', '上游服务异常，请稍后重试。') }
const streamCases = [
  ['text, then a server_error frame without [DONE] -> SERVER, site text kept',
    [choice({ content: 'partial' }), serverFrame], { code: 'SERVER', message: serverFrame.error.message, status: undefined }],
  ['the same with [DONE] after the frame -> SERVER, not a finished answer',
    [choice({ content: 'partial' }), serverFrame, '[DONE]'], { code: 'SERVER' }],
  ['rate_limit_error frame before any text, then [DONE] -> RATE_LIMIT, not EMPTY_RESPONSE',
    [{ error: rateLimited }, '[DONE]'], { code: 'RATE_LIMIT' }],
  ['context_length_exceeded frame -> CONTEXT_WINDOW_EXCEEDED',
    [{ error: siteError('context_length_exceeded', 'invalid_request_error', "The input exceeds the model's context window. Please shorten the input and try again.") }, '[DONE]'],
    { code: 'CONTEXT_WINDOW_EXCEEDED' }],
  ['insufficient_user_quota frame -> QUOTA',
    [{ error: siteError('insufficient_user_quota', 'new_api_error', '用户额度不足, 剩余额度: ¥0.00') }], { code: 'QUOTA' }],
  ['a bare string error -> SERVER with that text', [{ error: 'upstream stream aborted' }],
    { code: 'SERVER', message: 'upstream stream aborted' }],
  ['an error without text -> SERVER with a fallback text', [{ error: { type: 'server_error' } }],
    { code: 'SERVER', message: 'pixel-api: the site reported a stream error' }],
]
for (const [label, events, expected] of streamCases) {
  const failure = finishOf(await run(() => sse(events)))?.failure
  check(label, failureMatches(failure, expected), failure)
}
chunks = await run(() => sse([choice({ content: 'partial' }), usage, serverFrame]))
check('usage that arrived before the error frame is still reported',
  chunks.some((c) => c.type === 'usage' && c.usage.inputTokens === 12) && finishOf(chunks)?.failure?.code === 'SERVER', chunks)
check('text streamed before the error frame is closed, not dropped',
  chunks.some((c) => c.type === 'block-end' && c.block.text === 'partial'), chunks)
chunks = await run(() => sse([{ ...choice({ content: 'fine' }), error: false }, choice({}, 'stop'), '[DONE]']))
check('a falsy error field is not an error frame', finishOf(chunks)?.kind === 'stop', finishOf(chunks))

// Every failure of one response names the site's request id.
const requestIdCases = [
  ['stream error frame', () => sse([serverFrame], withRequestId), 'SERVER'],
  ['truncated stream without an error frame', () => sse([choice({ content: 'cut off' })], withRequestId), 'STREAM_CLOSED'],
  ['malformed payload', () => sse(['{"choices": [', '[DONE]'], withRequestId), 'MALFORMED_RESPONSE'],
  ['completed with no content', () => sse([choice({}, 'stop'), '[DONE]'], withRequestId), 'EMPTY_RESPONSE'],
  ['unknown finish_reason', () => sse([choice({ content: 'x' }, 'eaten'), '[DONE]'], withRequestId), 'UNKNOWN_FINISH_REASON'],
  ['content_filter stop', () => sse([choice({ content: 'x' }, 'content_filter'), '[DONE]'], withRequestId), 'CONTENT_REFUSED'],
  ['no response body', () => new Response(null, { status: 200, headers: withRequestId }), 'EMPTY_RESPONSE'],
  ['body read dying mid-stream', () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('terminated')) },
  }), { status: 200, headers: { 'content-type': 'text/event-stream', ...withRequestId } }), 'TRANSPORT'],
]
for (const [label, responder, code] of requestIdCases) {
  const failure = finishOf(await run(responder))?.failure
  check(`${label} -> ${code} with the request id`, failureMatches(failure, { code, requestId: REQUEST_ID }), failure)
}

// ---------------------------------------------------------------------------
// Usage: the site's OpenAI-shaped usage per upstream family (new-api-main
// relaykit: claude_messages/to_oai_chat_resp.go buildOpenAIStyleUsageFromClaudeUsage,
// gemini_chat/to_oai_chat_resp.go, OpenAI passthrough, DeepSeek-type hit/miss).
log('Usage mapping (cache buckets the client turns into a hit rate)')
// Mirror of dsh-token-meter src/turn-usage.ts normalizeUsage (lines 85-113):
// usage that fails it is dropped from turn usage. reasoningTokens is the part
// of outputTokens spent reasoning, never more.
const keptByTurnUsage = (u) => {
  const isCount = (v) => Number.isSafeInteger(v) && v >= 0
  if (!isCount(u.inputTokens) || !isCount(u.outputTokens)) return false
  if (u.cacheReadTokens !== undefined && !isCount(u.cacheReadTokens)) return false
  if (u.cacheWriteTokens !== undefined && !isCount(u.cacheWriteTokens)) return false
  if (u.reasoningTokens !== undefined && (!isCount(u.reasoningTokens) || u.reasoningTokens > u.outputTokens)) return false
  const known = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  if (u.totalTokens === undefined) return u.cacheReadTokens !== undefined && u.cacheWriteTokens !== undefined
  const exact = u.totalTokens - u.outputTokens
  if (!isCount(exact) || exact < known) return false
  return u.cacheReadTokens === undefined || u.cacheWriteTokens === undefined || exact === known
}
// dsh-client-ui-chat StatsPills.tsx billedInputTokens / cacheHitPercent.
const sessionHit = (u) => (100 * u.cacheReadTokens) / (u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)
const usageCase = async (label, wire, expected) => {
  const got = (await run(() => sse([choice({ content: 'ok' }), choice({}, 'stop'), { choices: [], usage: wire }, '[DONE]'])))
    .find((c) => c.type === 'usage')?.usage
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  const same = got !== undefined && fields.every((k) => got[k] === expected[k])
  check(`${label}`, same && keptByTurnUsage(got), { got, expected })
  return got
}
const viaClaude = await usageCase('Claude via site: reads/writes split out of prompt_tokens', {
  prompt_tokens: 21210, completion_tokens: 103, total_tokens: 21313,
  prompt_tokens_details: { cached_tokens: 20000, cached_creation_tokens: 1000, cache_write_tokens: 1000, text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
  usage_semantic: 'openai', usage_source: 'anthropic',
}, { inputTokens: 210, outputTokens: 103, totalTokens: 21313, cacheReadTokens: 20000, cacheWriteTokens: 1000 })
if (viaClaude) log(`        client session hit rate: ${sessionHit(viaClaude).toFixed(1)}% (was 0%)`)
await usageCase('OpenAI passthrough: cached_tokens', {
  prompt_tokens: 11118, completion_tokens: 172, total_tokens: 11290, prompt_tokens_details: { cached_tokens: 10880 },
}, { inputTokens: 238, outputTokens: 172, totalTokens: 11290, cacheReadTokens: 10880, cacheWriteTokens: 0 })
await usageCase('Gemini via site: cached content tokens', {
  prompt_tokens: 5000, completion_tokens: 50, total_tokens: 5050, prompt_tokens_details: { cached_tokens: 4096 },
}, { inputTokens: 904, outputTokens: 50, totalTokens: 5050, cacheReadTokens: 4096, cacheWriteTokens: 0 })
await usageCase('Gemini total that disagrees is left to the runtime', {
  prompt_tokens: 5000, completion_tokens: 50, total_tokens: 5123, prompt_tokens_details: { cached_tokens: 4096 },
}, { inputTokens: 904, outputTokens: 50, totalTokens: undefined, cacheReadTokens: 4096, cacheWriteTokens: 0 })
await usageCase('DeepSeek-type hit/miss: miss is uncached input, not a write', {
  prompt_tokens: 3000, completion_tokens: 20, total_tokens: 3020, prompt_cache_hit_tokens: 2560, prompt_cache_miss_tokens: 440,
}, { inputTokens: 440, outputTokens: 20, totalTokens: 3020, cacheReadTokens: 2560, cacheWriteTokens: 0 })
await usageCase('anthropic semantic: prompt_tokens already excludes the cache', {
  prompt_tokens: 210, completion_tokens: 103, total_tokens: 313,
  prompt_tokens_details: { cached_tokens: 20000, cached_creation_tokens: 1000 }, usage_semantic: 'anthropic',
}, { inputTokens: 210, outputTokens: 103, totalTokens: undefined, cacheReadTokens: 20000, cacheWriteTokens: 1000 })
await usageCase('no cache reported', {
  prompt_tokens: 12, completion_tokens: 3, total_tokens: 15,
}, { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 })
await usageCase('cache split larger than the prompt is clamped', {
  prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 150 },
}, { inputTokens: 0, outputTokens: 5, totalTokens: 105, cacheReadTokens: 100, cacheWriteTokens: 0 })
await usageCase('missing total is derived by the runtime', {
  prompt_tokens: 40, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 30 },
}, { inputTokens: 10, outputTokens: 2, totalTokens: undefined, cacheReadTokens: 30, cacheWriteTokens: 0 })
// Reasoning: completion_tokens already counts it (relaykit gemini_chat
// to_oai_chat_resp.go adds ThoughtsTokenCount in), and the site always sends
// completion_tokens_details, with reasoning_tokens 0 when the upstream does not
// break it out (Claude).
await usageCase('Gemini thinking via site: thoughts as reasoningTokens, inside an unchanged output', {
  prompt_tokens: 5000, completion_tokens: 350, total_tokens: 5350, prompt_tokens_details: { cached_tokens: 4096 },
  completion_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0, reasoning_tokens: 300 },
}, { inputTokens: 904, outputTokens: 350, totalTokens: 5350, cacheReadTokens: 4096, cacheWriteTokens: 0, reasoningTokens: 300 })
await usageCase('reasoning_tokens 0 (not broken out upstream): no reasoningTokens', {
  prompt_tokens: 12, completion_tokens: 3, total_tokens: 15,
  completion_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0, reasoning_tokens: 0 },
}, { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 })
await usageCase('reasoning above the output is left out, the rest of the usage kept', {
  prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 9 },
}, { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 })

// ---------------------------------------------------------------------------
// Harness 0.2.2-rc.3 history: each tool result is its own role:'tool' message.
// The wire must answer each call with an OpenAI tool message, and carry a
// result's images in one user message after the run (pi-ai's layout).
log('Tool results on the wire')
const ROUTE = { provider: 'pixel/room-1024', model: 'gemini-4-hydrogen' }
const textBlock = (text) => ({ type: 'text', text })
const imageBlock = (attachmentId, offloaded = false) => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', width: 64, height: 32 },
  ...(offloaded ? { offloaded: true } : {}),
})
const userSays = (text) => ({ role: 'user', content: [textBlock(text)] })
const systemSays = (text) => ({ role: 'system', source: { kind: 'system-prompt' }, content: text === '' ? [] : [textBlock(text)] })
const assistantSays = (text) => ({ role: 'assistant', source: { kind: 'model', ...ROUTE }, content: [textBlock(text)] })
const callsTools = (...ids) => ({
  role: 'assistant',
  source: { kind: 'model', ...ROUTE },
  content: ids.map((id) => ({ type: 'tool-call', id, name: 'read', arguments: `{"id":"${id}"}` })),
})
const toolAnswers = (id, content, isError = false) => ({ role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, isError, content })
const wireCalls = (...ids) => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'read', arguments: `{"id":"${id}"}` } })),
})
const wireTool = (id, content) => ({ role: 'tool', tool_call_id: id, content })
// The image reader below returns each attachment id's bytes, so a data URL
// names the image it came from.
const wireImage = (attachmentId) => ({
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${Buffer.from(attachmentId).toString('base64')}` },
})
const wireToolImages = (...ids) => ({
  role: 'user',
  content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...ids.map(wireImage)],
})
// One history through the real runtime; `wire` is what reached the site
// (empty when the request failed before sending).
const send = async (messages) => {
  const sent = chatBodies.length
  const chunks = await run(() => sse([choice({ content: 'ok' }), choice({}, 'stop'), usage, '[DONE]']), messages)
  return { wire: chatBodies.length > sent ? chatBodies.at(-1).messages : [], finish: finishOf(chunks) }
}

let sent = await send([userSays('read a'), callsTools('call_a'), toolAnswers('call_a', [textBlock('contents of a')])])
check('result is a role:tool message right after the calling turn', isDeepStrictEqual(sent.wire, [
  { role: 'user', content: 'read a' },
  wireCalls('call_a'),
  wireTool('call_a', 'contents of a'),
]), sent)
check('no user message carries the tool output',
  sent.wire.length > 0 && !sent.wire.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('contents of a')), sent)

sent = await send([userSays('read both'), callsTools('call_a', 'call_b'),
  toolAnswers('call_a', [textBlock('A')]), toolAnswers('call_b', [textBlock('B')])])
check('parallel results keep their order', isDeepStrictEqual(sent.wire.slice(1), [
  wireCalls('call_a', 'call_b'),
  wireTool('call_a', 'A'),
  wireTool('call_b', 'B'),
]), sent)

sent = await send([userSays('touch'), callsTools('call_a'), toolAnswers('call_a', [])])
check('empty result -> (no output)', isDeepStrictEqual(sent.wire.at(-1), wireTool('call_a', '(no output)')), sent)

sent = await send([userSays('read'), callsTools('call_a'), toolAnswers('call_a', [textBlock('ENOENT: no such file')], true)])
check('failed result is sent verbatim', isDeepStrictEqual(sent.wire.at(-1), wireTool('call_a', 'ENOENT: no such file')), sent)

readImageRequest = async (ref) => ({ mediaType: 'image/png', data: Buffer.from(ref.attachmentId) })
sent = await send([userSays('screenshot'), callsTools('call_a'), toolAnswers('call_a', [imageBlock('img-1')])])
check('image-only result -> (see attached image), then one labelled user message', isDeepStrictEqual(sent.wire.slice(2), [
  wireTool('call_a', '(see attached image)'),
  wireToolImages('img-1'),
]), sent)
sent = await send([userSays('two shots'), callsTools('call_a', 'call_b'),
  toolAnswers('call_a', [imageBlock('img-1')]), toolAnswers('call_b', [textBlock('saved'), imageBlock('img-2')]), userSays('thanks')])
check('a run of results sends all its images in one user message after the run', isDeepStrictEqual(sent.wire.slice(2), [
  wireTool('call_a', '(see attached image)'),
  wireTool('call_b', 'saved'),
  wireToolImages('img-1', 'img-2'),
  { role: 'user', content: 'thanks' },
]), sent)
readImageRequest = noImages

sent = await send([userSays('screenshot'), callsTools('call_a'),
  toolAnswers('call_a', [textBlock('shot: '), imageBlock('img-1', true)])])
check('offloaded image -> placeholder text, no user message', isDeepStrictEqual(sent.wire.slice(2), [
  wireTool('call_a', 'shot: [image omitted to fit the request limits]'),
]), sent)

sent = await send([systemSays('be brief'), userSays('hi'), assistantSays('hello'), systemSays(''), userSays('again')])
check('empty system message in the history is not sent', isDeepStrictEqual(sent.wire, [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'again' },
]), sent)

// Older runtimes put tool results in a user message as `tool-result` blocks.
const legacyResult = (id, text) => ({ type: 'tool-result', toolCallId: id, content: [textBlock(text)] })
sent = await send([userSays('read'), callsTools('call_a'),
  { role: 'user', content: [legacyResult('call_a', 'legacy A'), textBlock('and summarize')] }])
check('legacy tool-result block: tool message first, then the rest of the user message', isDeepStrictEqual(sent.wire.slice(2), [
  wireTool('call_a', 'legacy A'),
  { role: 'user', content: 'and summarize' },
]), sent)
sent = await send([userSays('read'), callsTools('call_a'), { role: 'user', content: [legacyResult('call_a', 'legacy A')] }])
check('legacy results alone add no empty user message', isDeepStrictEqual(sent.wire.slice(2), [
  wireTool('call_a', 'legacy A'),
]), sent)

// ---------------------------------------------------------------------------
// The site's replay data (new-api-main relaykit shared/gemini/replay.go,
// shared/openai/replay.go, oai_responses/to_oai_chat_stream_resp.go): a Gemini
// token in the finish chunk and thought signatures on tool calls, a GPT token
// in a chunk of its own. It rides the finish chunk as replayState and goes
// back with that turn only to the same group and model while the turn's text
// and tool calls are unchanged; GPT's only with the settings switch on.
log('Replay: capture')
const GEMINI_ROUTE = ROUTE
const GPT_ROUTE = { provider: 'pixel/default', model: 'gpt-6.2-sol' }
const digestOf = (text, calls) => createHash('sha256').update(JSON.stringify([text, calls])).digest('hex')
const finishChunk = (chunks) => chunks.findLast((c) => c.type === 'finish')
// One request to `route` through the real runtime.
const streamTo = async (route, responder, messages = [userSays('go')]) => {
  chat = responder
  const chunks = []
  for await (const chunk of llm.stream({ ...route, messages })) chunks.push(chunk)
  return chunks
}
// A Gemini tool-calling turn as the site streams it: of two parallel calls only
// the first carries a thought signature, and the finish chunk the token.
const geminiTurn = () => sse([
  choice({ content: 'Reading ' }),
  choice({ content: 'both.' }),
  choice({ tool_calls: [{ index: 0, id: 'call_g1', type: 'function', function: { name: 'read', arguments: '{"p":' }, extra_content: { google: { thought_signature: 'sig-g1' } } }] }),
  choice({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
  choice({ tool_calls: [{ index: 1, id: 'call_g2', type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } }] }),
  choice({ extra_content: { google: { new_api_gemini_replay: 'gemini-token' } } }, 'tool_calls'),
  usage, '[DONE]',
])
const geminiContent = [
  textBlock('Reading both.'),
  { type: 'tool-call', id: 'call_g1', name: 'read', arguments: '{"p":"a"}' },
  { type: 'tool-call', id: 'call_g2', name: 'read', arguments: '{"p":"b"}' },
]
const geminiDigest = digestOf('Reading both.', [['call_g1', 'read', '{"p":"a"}'], ['call_g2', 'read', '{"p":"b"}']])
const geminiReplay = {
  response: { kind: 'pixel-api', version: 1, digest: geminiDigest, gemini: 'gemini-token', signatures: { call_g1: 'sig-g1' } },
}
// A GPT turn through the site's Responses conversion: the encrypted reasoning
// token in a chunk of its own, before the finish chunk.
const gptTurn = () => sse([
  choice({ reasoning_content: 'Thinking.' }),
  choice({ content: 'Checking.' }),
  choice({ tool_calls: [{ index: 0, id: 'call_o1', type: 'function', function: { name: 'read', arguments: '{"p":"c"}' } }] }),
  choice({ extra_content: { openai: { new_api_openai_replay: 'openai-token' } } }),
  choice({}, 'tool_calls'), usage, '[DONE]',
])
const gptContent = [
  { type: 'reasoning', text: 'Thinking.' },
  textBlock('Checking.'),
  { type: 'tool-call', id: 'call_o1', name: 'read', arguments: '{"p":"c"}' },
]
const gptReplay = {
  response: { kind: 'pixel-api', version: 1, digest: digestOf('Checking.', [['call_o1', 'read', '{"p":"c"}']]), openai: 'openai-token' },
}

let finished = finishChunk(await streamTo(GEMINI_ROUTE, geminiTurn))
check('Gemini: replayState holds the token, the signature by call id, and the turn digest',
  isDeepStrictEqual(finished?.replayState, geminiReplay), finished)
check('  ...the turn still finishes tool-calls', finished?.reason?.kind === 'tool-calls', finished?.reason)
check('  ...the finish chunk is lossless JSON, as the agent loop requires', finished !== undefined && isJsonValue(finished), finished)
finished = finishChunk(await streamTo(GPT_ROUTE, gptTurn))
check('GPT: the token from its own chunk lands in replayState.response.openai',
  isDeepStrictEqual(finished?.replayState, gptReplay), finished)
finished = finishChunk(await streamTo(GPT_ROUTE, () => sse([choice({ content: 'plain' }), choice({}, 'stop'), usage, '[DONE]'])))
check('no replay data -> the finish chunk has no replayState',
  finished?.reason?.kind === 'stop' && !('replayState' in finished), finished)
finished = finishChunk(await streamTo(GEMINI_ROUTE, () => sse([
  choice({ content: 'plain', extra_content: { openai: { new_api_openai_replay: '' }, google: { new_api_gemini_replay: '' } } }),
  choice({ tool_calls: [{ index: 0, id: 'call_e', type: 'function', function: { name: 'read', arguments: '{}' }, extra_content: { google: { thought_signature: '' } } }] }),
  choice({}, 'tool_calls'), '[DONE]',
])))
check('empty tokens and signatures are not replay data',
  finished?.reason?.kind === 'tool-calls' && !('replayState' in finished), finished)
const tokenOnly = { extra_content: { google: { new_api_gemini_replay: 'gemini-token' } } }
for (const [label, events, code] of [
  ['an empty reply', [choice(tokenOnly, 'stop'), '[DONE]'], 'EMPTY_RESPONSE'],
  ['an unknown finish_reason', [choice({ content: 'x', ...tokenOnly }, 'eaten'), '[DONE]'], 'UNKNOWN_FINISH_REASON'],
]) {
  finished = finishChunk(await streamTo(GEMINI_ROUTE, () => sse(events)))
  check(`${label} with a token -> ${code}, no replayState`,
    finished?.reason?.failure?.code === code && !('replayState' in finished), finished)
}

log('Replay: what goes back with a stored turn')
const storedTurn = (route, content, replayState) => ({
  role: 'assistant',
  source: { kind: 'model', ...route, ...(replayState === undefined ? {} : { replayState }) },
  content,
})
const geminiHistory = (turn) => [userSays('read a and b'), turn,
  toolAnswers('call_g1', [textBlock('A')]), toolAnswers('call_g2', [textBlock('B')])]
const gptHistory = (turn) => [userSays('read c'), turn, toolAnswers('call_o1', [textBlock('C')])]
// One request to `route`; `assistant` is the stored turn as it reached the site.
const sendTo = async (route, messages) => {
  const before = chatBodies.length
  const chunks = await streamTo(route, () => sse([choice({ content: 'ok' }), choice({}, 'stop'), usage, '[DONE]']), messages)
  const body = chatBodies.length > before ? chatBodies.at(-1) : undefined
  return { finish: finishOf(chunks), assistant: body?.messages.find((m) => m.role === 'assistant') }
}
// The turn went as ordinary history: no turn-level replay data, no signature.
const plain = (assistant) => assistant !== undefined && !('extra_content' in assistant)
  && (assistant.tool_calls ?? []).every((call) => !('extra_content' in call))
const readCall = (id, args, signature) => ({
  id,
  type: 'function',
  function: { name: 'read', arguments: args },
  ...(signature === undefined ? {} : { extra_content: { google: { thought_signature: signature } } }),
})

let back = await sendTo(GEMINI_ROUTE, geminiHistory(storedTurn(GEMINI_ROUTE, geminiContent, geminiReplay)))
check('same group, model and content: the Gemini token on the turn, the signature on the call it signed',
  isDeepStrictEqual(back.assistant, {
    role: 'assistant',
    content: 'Reading both.',
    tool_calls: [readCall('call_g1', '{"p":"a"}', 'sig-g1'), readCall('call_g2', '{"p":"b"}')],
    extra_content: { google: { new_api_gemini_replay: 'gemini-token' } },
  }), back.assistant)
back = await sendTo(GEMINI_ROUTE, geminiHistory(storedTurn(GEMINI_ROUTE, geminiContent,
  { response: { kind: 'pixel-api', version: 1, digest: geminiDigest, signatures: { call_g2: 'sig-g2' } } })))
check('a signature goes back without a Gemini token',
  isDeepStrictEqual(back.assistant?.tool_calls, [readCall('call_g1', '{"p":"a"}'), readCall('call_g2', '{"p":"b"}', 'sig-g2')])
  && !('extra_content' in back.assistant), back.assistant)

const gptStored = storedTurn(GPT_ROUTE, gptContent, gptReplay)
back = await sendTo(GPT_ROUTE, gptHistory(gptStored))
check('GPT token, switch off (the default): not sent', plain(back.assistant)
  && back.assistant.content === 'Checking.' && back.assistant.reasoning_content === 'Thinking.', back.assistant)
config.openaiReasoningReplay?.[WRITE]?.(true)
back = await sendTo(GPT_ROUTE, gptHistory(gptStored))
check('switch turned on (a live edit, no reload): the GPT token goes back on the turn', isDeepStrictEqual(back.assistant, {
  role: 'assistant',
  content: 'Checking.',
  reasoning_content: 'Thinking.',
  tool_calls: [readCall('call_o1', '{"p":"c"}')],
  extra_content: { openai: { new_api_openai_replay: 'openai-token' } },
}), back.assistant)

// With the switch still on, so only the route and content rules hold it back.
const notReplayed = [
  ['Gemini turn, another model in the same group', { ...GEMINI_ROUTE, model: 'gemini-4-carbon' },
    geminiHistory(storedTurn(GEMINI_ROUTE, geminiContent, geminiReplay))],
  ['Gemini turn, the same model in another group', { ...GEMINI_ROUTE, provider: 'pixel/default' },
    geminiHistory(storedTurn(GEMINI_ROUTE, geminiContent, geminiReplay))],
  ['GPT turn, another model in the same group', { ...GPT_ROUTE, model: 'gpt-6.2-luna' }, gptHistory(gptStored)],
  ['GPT turn, the same model in another group', { ...GPT_ROUTE, provider: 'pixel/room-1024' }, gptHistory(gptStored)],
  ['the turn lost a tool call', GEMINI_ROUTE, [userSays('read a and b'),
    storedTurn(GEMINI_ROUTE, geminiContent.slice(0, 2), geminiReplay), toolAnswers('call_g1', [textBlock('A')])]],
  ['the turn text changed', GEMINI_ROUTE,
    geminiHistory(storedTurn(GEMINI_ROUTE, [textBlock('Reading both!'), ...geminiContent.slice(1)], geminiReplay))],
  ['a tool call argument changed', GPT_ROUTE, gptHistory(storedTurn(GPT_ROUTE,
    [...gptContent.slice(0, 2), { type: 'tool-call', id: 'call_o1', name: 'read', arguments: '{"p":"d"}' }], gptReplay))],
]
for (const [label, route, messages] of notReplayed) {
  const sentBack = await sendTo(route, messages)
  check(`${label}: nothing goes back`, plain(sentBack.assistant), sentBack.assistant)
}
const damaged = [
  ['another adapter kind (pi-ai)', { response: { kind: 'pi-ai', version: 2, api: 'openai-completions',
    provider: GEMINI_ROUTE.provider, model: GEMINI_ROUTE.model, stopReason: 'toolUse' },
  blocks: [{ type: 'text' }, { type: 'tool-call', thoughtSignature: 'sig-g1' }, { type: 'tool-call' }] }],
  ['another version', { response: { ...geminiReplay.response, version: 2 } }],
  ['no digest', { response: { kind: 'pixel-api', version: 1, gemini: 'gemini-token' } }],
  ['a Gemini token that is not a string', { response: { ...geminiReplay.response, gemini: { token: 'gemini-token' } } }],
  ['a GPT token that is not a string', { response: { ...geminiReplay.response, openai: 7 } }],
  ['signatures as a list', { response: { ...geminiReplay.response, signatures: ['sig-g1'] } }],
  ['a signature that is not a string', { response: { ...geminiReplay.response, signatures: { call_g1: 1 } } }],
  ['no response object', 'gemini-token'],
]
for (const [label, replayState] of damaged) {
  const sentBack = await sendTo(GEMINI_ROUTE, geminiHistory(storedTurn(GEMINI_ROUTE, geminiContent, replayState)))
  check(`replayState with ${label}: nothing goes back, the request succeeds`,
    plain(sentBack.assistant) && sentBack.finish?.kind === 'stop', sentBack)
}

log('Replay: round trip through the agent loop assembly')
// Mirror of dsh-agent-loop agent.ts (a completed step): AssistantStreamAccumulator
// snapshots each chunk, BlockAssembler assembles it, and the stored message
// keeps the assembler's replayState in its model source.
const assembleTurn = async (route, responder) => {
  const accumulator = new AssistantStreamAccumulator()
  const assembler = new BlockAssembler()
  for (const chunk of await streamTo(route, responder)) {
    assembler.push(accumulator.push({ time: Date.now(), chunk }).chunk)
  }
  return {
    finish: assembler.finish,
    replayState: assembler.replayState,
    message: createAssistantMessage({
      content: assembler.blocks(),
      source: { ...route, ...(assembler.replayState !== undefined ? { replayState: assembler.replayState } : {}) },
    }),
  }
}
// A stored turn as a session reloaded from its log reads it back.
const fromLog = (message) => JSON.parse(JSON.stringify(message))

let assembled = await assembleTurn(GEMINI_ROUTE, geminiTurn)
back = await sendTo(GEMINI_ROUTE, [userSays('go'), fromLog(assembled.message),
  toolAnswers('call_g1', [textBlock('A')]), toolAnswers('call_g2', [textBlock('B')])])
check('Gemini turn assembled by DSH and read back from the log: token and signature go back',
  back.assistant?.extra_content?.google?.new_api_gemini_replay === 'gemini-token'
  && isDeepStrictEqual(back.assistant?.tool_calls, [readCall('call_g1', '{"p":"a"}', 'sig-g1'), readCall('call_g2', '{"p":"b"}')]),
  back.assistant)
assembled = await assembleTurn(GPT_ROUTE, gptTurn)
back = await sendTo(GPT_ROUTE, [userSays('go'), fromLog(assembled.message), toolAnswers('call_o1', [textBlock('C')])])
check('GPT turn assembled by DSH (switch on): its token goes back',
  isDeepStrictEqual(back.assistant?.extra_content, { openai: { new_api_openai_replay: 'openai-token' } }), back.assistant)
// finish_reason length: assembly drops every tool call yet keeps the envelope.
assembled = await assembleTurn(GEMINI_ROUTE, () => sse([
  choice({ content: 'Reading.' }),
  choice({ tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' }, extra_content: { google: { thought_signature: 'sig-cut' } } }] }),
  choice({ extra_content: { google: { new_api_gemini_replay: 'cut-token' } } }, 'length'),
  usage, '[DONE]',
]))
check('finish_reason length with a tool call: DSH drops the call, keeps the envelope',
  assembled.finish.kind === 'max-tokens' && assembled.replayState !== undefined
  && isDeepStrictEqual(assembled.message.content, [textBlock('Reading.')]), assembled)
back = await sendTo(GEMINI_ROUTE, [userSays('go'), fromLog(assembled.message), userSays('go on')])
check('  ...the trimmed turn no longer matches its token: nothing goes back', plain(back.assistant), back.assistant)
config.openaiReasoningReplay?.[WRITE]?.(false)

// ---------------------------------------------------------------------------
// Claude prompt caching: on a claude route the plugin marks two cache_control
// breakpoints the site's chat→Claude conversion keeps — the system prompt and
// the last conversation message (new-api-main relaykit claude_messages). Tools
// stay unmarked, and every non-claude route's body is byte-identical to before.
log('Claude prompt caching (cache_control breakpoints)')
const CLAUDE_ROUTE = { provider: 'pixel/room-1024', model: 'claude-opus-5-5' }
const EPHEMERAL = { type: 'ephemeral' }
const cachedPart = (text) => ({ type: 'text', text, cache_control: EPHEMERAL })
// The full request body one history produced.
const bodyOf = async (route, messages) => {
  const before = chatBodies.length
  await streamTo(route, () => sse([choice({ content: 'ok' }), choice({}, 'stop'), usage, '[DONE]']), messages)
  return chatBodies.length > before ? chatBodies.at(-1) : undefined
}
const marks = (body) => JSON.stringify(body).split('"cache_control"').length - 1
readImageRequest = async (ref) => ({ mediaType: 'image/png', data: Buffer.from(ref.attachmentId) })

// system + user + tool-call turn + tool result: system and the trailing tool
// message take the two breakpoints.
let body = await bodyOf(CLAUDE_ROUTE, [systemSays('be brief'), userSays('read a'),
  callsTools('call_a'), toolAnswers('call_a', [textBlock('contents of a')])])
check('claude: the system prompt is marked, its text in one cached part',
  isDeepStrictEqual(body.messages[0], { role: 'system', content: [cachedPart('be brief')] }), body.messages[0])
check('claude: the last tool message is marked, its string body one cached part',
  isDeepStrictEqual(body.messages.at(-1), { role: 'tool', tool_call_id: 'call_a', content: [cachedPart('contents of a')] }), body.messages.at(-1))
check('claude: the tool-call turn between them is not marked',
  body.messages[2].role === 'assistant' && !JSON.stringify(body.messages[2]).includes('cache_control'), body.messages[2])
check('claude: exactly two breakpoints in the request', marks(body) === 2, marks(body))

// tools are declared but never marked (the site drops cache_control there).
body = await bodyOf({ ...CLAUDE_ROUTE, model: 'claude-opus-5-5' }, [systemSays('sys'), userSays('hi')])
check('claude: a plain user turn takes the second breakpoint',
  isDeepStrictEqual(body.messages.at(-1), { role: 'user', content: [cachedPart('hi')] }), body.messages.at(-1))
const withTools = async (route) => {
  const before = chatBodies.length
  chat = () => sse([choice({ content: 'ok' }), choice({}, 'stop'), usage, '[DONE]'])
  for await (const _ of llm.stream({ ...route, messages: [systemSays('sys'), userSays('hi')],
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }] })) void _
  return chatBodies.length > before ? chatBodies.at(-1) : undefined
}
body = await withTools(CLAUDE_ROUTE)
check('claude: tools are declared but carry no cache_control (still two breakpoints)',
  Array.isArray(body.tools) && body.tools.length === 1 && marks(body) === 2
  && !JSON.stringify(body.tools).includes('cache_control'), { tools: body.tools, marks: marks(body) })

// An image-only last user message has an empty text part: skip it and mark the
// message before it instead.
body = await bodyOf(CLAUDE_ROUTE, [systemSays('sys'), userSays('earlier text'),
  { role: 'user', content: [imageBlock('img-1')] }])
check('claude: an image-only last user message (empty text) is not marked',
  Array.isArray(body.messages.at(-1).content) && !JSON.stringify(body.messages.at(-1)).includes('cache_control'), body.messages.at(-1))
check('claude: the breakpoint moves to the previous message',
  isDeepStrictEqual(body.messages[1], { role: 'user', content: [cachedPart('earlier text')] }), body.messages[1])
check('claude: still exactly two breakpoints', marks(body) === 2, marks(body))

// A trailing pure tool-call assistant turn (content "") is skipped too.
body = await bodyOf(CLAUDE_ROUTE, [systemSays('sys'), userSays('do it'), callsTools('call_a')])
check('claude: a trailing empty-content assistant turn is skipped, the user turn is marked',
  isDeepStrictEqual(body.messages[1], { role: 'user', content: [cachedPart('do it')] })
  && !JSON.stringify(body.messages.at(-1)).includes('cache_control') && marks(body) === 2, body.messages)

// No system message: only the last conversation message is marked.
body = await bodyOf(CLAUDE_ROUTE, [userSays('just this')])
check('claude without a system prompt: one breakpoint, on the last message',
  isDeepStrictEqual(body.messages, [{ role: 'user', content: [cachedPart('just this')] }]) && marks(body) === 1, body.messages)

// The trigger is case-insensitive and matches the model anywhere in its id.
body = await bodyOf({ provider: 'pixel/default', model: 'Anthropic-Claude-Sonnet' }, [systemSays('sys'), userSays('hi')])
check('claude match is case-insensitive and substring', marks(body) === 2, marks(body))

// Every non-claude route is untouched: same history, no cache_control at all.
body = await bodyOf(GEMINI_ROUTE, [systemSays('be brief'), userSays('read a'),
  callsTools('call_a'), toolAnswers('call_a', [textBlock('contents of a')])])
check('non-claude: the body carries no cache_control anywhere', !JSON.stringify(body).includes('cache_control'), body)
check('non-claude: system and tool content stay plain strings',
  body.messages[0].content === 'be brief' && body.messages.at(-1).content === 'contents of a', body.messages)
readImageRequest = noImages

// ---------------------------------------------------------------------------
// prompt_cache_key: the session id, sent to the site only for gpt- models (it
// passes it through to the Responses/Codex upstream), clamped to 64 code
// points like the shipped pi-ai adapter's clampOpenAIPromptCacheKey.
log('prompt_cache_key (GPT models only)')
// One request body for `route`, carrying `sessionId` when defined.
const bodyWith = async (route, sessionId) => {
  const before = chatBodies.length
  chat = () => sse([choice({ content: 'ok' }), choice({}, 'stop'), usage, '[DONE]'])
  for await (const _ of llm.stream({ ...route, messages: [userSays('hi')],
    ...(sessionId === undefined ? {} : { sessionId }) })) void _
  return chatBodies.length > before ? chatBodies.at(-1) : undefined
}
let keyed = await bodyWith(GPT_ROUTE, 'sess-abc-123')
check('gpt model with a session id: prompt_cache_key equals it', keyed.prompt_cache_key === 'sess-abc-123', keyed.prompt_cache_key)
keyed = await bodyWith({ ...GPT_ROUTE, model: 'GPT-6.2-Sol' }, 'sess-cap')
check('the gpt- match is case-insensitive', keyed.prompt_cache_key === 'sess-cap', keyed.prompt_cache_key)
keyed = await bodyWith(GPT_ROUTE, 'y'.repeat(64))
check('a session id of exactly 64 chars is sent whole', keyed.prompt_cache_key === 'y'.repeat(64), keyed.prompt_cache_key?.length)
keyed = await bodyWith(GPT_ROUTE, 'x'.repeat(100))
check('a session id over 64 chars is clamped to 64', keyed.prompt_cache_key === 'x'.repeat(64)
  && keyed.prompt_cache_key.length === 64, keyed.prompt_cache_key?.length)
// Array.from clamps by code point, not UTF-16 unit: 65 astral chars -> 64.
keyed = await bodyWith(GPT_ROUTE, '😀'.repeat(65))
check('clamped by code point, not UTF-16 unit', Array.from(keyed.prompt_cache_key ?? '').length === 64
  && keyed.prompt_cache_key === '😀'.repeat(64), Array.from(keyed.prompt_cache_key ?? '').length)
keyed = await bodyWith(GPT_ROUTE, undefined)
check('gpt model without a session id: no prompt_cache_key', !('prompt_cache_key' in keyed), keyed)
for (const [label, route] of [
  ['gemini', GEMINI_ROUTE],
  ['claude', { provider: 'pixel/default', model: 'claude-opus-5-5' }],
  ['a model merely starting with "gpt" and no hyphen', { provider: 'pixel/default', model: 'gptx-1' }],
]) {
  keyed = await bodyWith(route, 'sess-abc-123')
  check(`non-gpt (${label}): no prompt_cache_key`, !('prompt_cache_key' in keyed), keyed?.model)
}

// ---------------------------------------------------------------------------
// A refresh the site never answered, or answered with a 5xx, says nothing
// about the session: the request fails in a code the Harness retries and the
// refresh cookie stays. Only the site's refusal is AUTH.
log('Session refresh failures: chat requests')
const answered = () => sse([choice({ content: 'ok' }), choice({}, 'stop'), usage, '[DONE]'])
const refreshCases = [
  ['unreachable -> TRANSPORT, with the network reason', 'network',
    { code: 'TRANSPORT', status: undefined, message: 'pixel-api: session refresh failed: 连不上 PIXEL 主站：getaddrinfo ENOTFOUND api.ai-pixel.online' }],
  ['500 -> SERVER', '500', { code: 'SERVER', status: 500 }],
  ['502 HTML from the gateway -> SERVER', '502', { code: 'SERVER', status: 502 }],
  ['refused (401) -> AUTH, the wording as before', '401',
    { code: 'AUTH', message: 'pixel-api: session refresh failed: Unauthorized' }],
]
for (const [label, mode, expected] of refreshCases) {
  refreshMode = 'ok'
  await run(answered) // a fresh access token, so the 401 below forces a refresh
  refreshMode = mode
  const failure = finishOf(await run(httpError(401, siteError('', 'new_api_error', '未登录或登录已过期'))))?.failure
  check(`chat 401, then the refresh: ${label}`, failureMatches(failure, expected), failure)
  if (mode !== '401') {
    check('  ...the refresh cookie is kept', credentials.get('PIXEL_API_REFRESH') === 'seed-refresh', [...credentials.keys()])
  }
}
refreshMode = 'ok'
chunks = await run(answered)
check('site back: the next request goes through', finishOf(chunks)?.kind === 'stop', finishOf(chunks))

// ---------------------------------------------------------------------------
// The sign-in state, in instances of their own (runtime, credentials, logger,
// status store). Timers of 10 s or more are held instead of armed, so a retry
// fires when the test says so; shorter ones (the polling below) run for real.
log('Session refresh failures: sign-in state (reconcile)')
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const heldTimers = []
globalThis.setTimeout = (callback, ms, ...args) => {
  if (!(ms >= 10_000)) return realSetTimeout(callback, ms, ...args)
  const timer = { callback, ms, fired: false, cleared: false, unref: () => timer }
  heldTimers.push(timer)
  return timer
}
globalThis.clearTimeout = (timer) => {
  if (heldTimers.includes(timer)) timer.cleared = true
  else realClearTimeout(timer)
}
const pendingTimers = () => heldTimers.filter((timer) => !timer.fired && !timer.cleared)
// Fires the pending retry, if there is one (none is a failure the checks report).
const firePending = () => {
  const timer = pendingTimers()[0]
  if (timer === undefined) return
  timer.fired = true
  timer.callback()
}
const until = async (condition, tries = 100) => {
  for (let i = 0; i < tries && !condition(); i++) await new Promise((r) => realSetTimeout(r, 20))
}
// Lets the plugin's queued promise work run to its end.
const drain = () => new Promise((r) => realSetTimeout(r, 0))
// `refreshCookie` undefined: no session stored yet; `password`: a sign-in the
// settings page submitted; `config`: more of the stored plugin config (a
// reload); `attachments` and `failingWrites` as for fakeCtxFor, the latter
// kept as a Set a check can change. The credential store here fires no events
// of its own: `emit` runs the handlers the plugin registered for one host event.
const bootInstance = async (refreshCookie, { password, config: stored = {}, attachments = true, failingWrites = [] } = {}) => {
  const instanceApp = new Context()
  await instanceApp.plugin(LlmRuntime)
  const instanceConfig = plugin.Config({ username: 'tester', ...stored })
  const listeners = new Map()
  const instance = {
    app: instanceApp,
    llm: instanceApp.get('llm'),
    config: instanceConfig,
    credentials: new Map([
      ...(refreshCookie === undefined ? [] : [['PIXEL_API_REFRESH', refreshCookie]]),
      ...(password === undefined ? [] : [['PIXEL_API_PASSWORD', password]]),
    ]),
    failingWrites: new Set(failingWrites),
    warnings: [],
    registered: [],
    statuses: [],
    status: () => instance.statuses.at(-1),
    emit: (name, ...args) => {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
  // The host commits each status write into the config cell, the copy the
  // plugin compares its next write against.
  const edit = async (entry, change) => {
    const { auth } = change({})
    if (auth === undefined) return
    instance.statuses.push(auth)
    instanceConfig.auth[WRITE](auth)
  }
  plugin.apply(fakeCtxFor({
    runtime: instance.llm,
    credentials: instance.credentials,
    warnings: instance.warnings,
    registered: instance.registered,
    edit,
    listeners,
    attachments,
    failingWrites: instance.failingWrites,
  }), instanceConfig)
  return instance
}
const statusIs = (status, state, message, user) =>
  status?.state === state && status?.message === message && (user === undefined || status?.user === user)

refreshMode = 'network'
const offline = await bootInstance('seed-refresh-b')
await until(() => pendingTimers().length > 0)
check('site unreachable at start: no routes registered', offline.registered.length === 0, offline.registered)
check('  ...the refresh cookie is kept', offline.credentials.get('PIXEL_API_REFRESH') === 'seed-refresh-b', [...offline.credentials.keys()])
check('  ...status error, with the fixed retry text and the configured user',
  statusIs(offline.status(), 'error', '暂时连不上 PIXEL 主站，登录状态已保留，稍后自动重试', 'tester'), offline.status())
check('  ...the reason goes to the log only',
  offline.warnings.some((line) => line.includes('getaddrinfo ENOTFOUND')) && !offline.status()?.message.includes('ENOTFOUND'), offline.warnings)
check('  ...one retry pending, due in 15 s', pendingTimers().length === 1 && pendingTimers()[0].ms === 15_000,
  pendingTimers().map((timer) => timer.ms))
const delays = [pendingTimers()[0]?.ms]
for (let i = 0; i < 6 && pendingTimers().length === 1; i++) {
  firePending()
  await until(() => pendingTimers().length > 0)
  delays.push(pendingTimers().length === 1 ? pendingTimers()[0].ms : `${pendingTimers().length} pending`)
}
check('still unreachable: each failed retry schedules one more, 15 s doubling to at most 5 min',
  isDeepStrictEqual(delays, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]), delays)
check('  ...the status is written once, not once per retry', offline.statuses.length === 1, offline.statuses)

refreshMode = 'ok'
firePending()
await until(() => offline.registered.length > 0 && offline.status()?.state === 'ok')
check('site back, the retry fires: routes registered',
  JSON.stringify(offline.registered[0]) === JSON.stringify(['pixel/room-1024', 'pixel/default']), offline.registered)
check('  ...status ok', statusIs(offline.status(), 'ok', '', 'tester'), offline.status())
check('  ...no retry left pending', pendingTimers().length === 0, pendingTimers().map((timer) => timer.ms))

refreshMode = '401'
const heldBefore = heldTimers.length
const refused = await bootInstance('seed-refresh-c')
await until(() => refused.status()?.state === 'none')
await drain()
check('refresh refused at start: the refresh cookie is dropped', !refused.credentials.has('PIXEL_API_REFRESH'), [...refused.credentials.keys()])
check('  ...status none, asking to sign in again', statusIs(refused.status(), 'none', '登录会话已过期，请重新登录'), refused.status())
check('  ...no retry scheduled', heldTimers.length === heldBefore, heldTimers.slice(heldBefore).map((timer) => timer.ms))
check('  ...no routes registered', refused.registered.length === 0, refused.registered)
refreshMode = 'ok'

// ---------------------------------------------------------------------------
// A site that stops answering: each site call ends on its own timer (index.js
// SITE_API_TIMEOUT_MS) as the same 连接超时 failure, whether the connect or the
// body read stalls. It must neither hold the reconcile queue for minutes nor
// count toward the sign-in backoff. Here AbortSignal.timeout turns 10 s or more
// into 50 ms. Node runs it on internal timers, not the global setTimeout, so
// the hold above never sees it and still holds the plugin's 15 s retries.
log('Site call timeouts')
const realAbortTimeout = AbortSignal.timeout
AbortSignal.timeout = (ms) => realAbortTimeout.call(AbortSignal, ms >= 10_000 ? 50 : ms)
// About 5 s: long enough for the mock's 2 s no-signal failure to land, so a run
// against an index.js without these timeouts reports what that build ends with.
const SETTLE_TRIES = 250
const TIMED_OUT = '连不上 PIXEL 主站：连接超时'
const loginCalls = () => apiCalls.filter((call) => call.path === '/api/user/login').length

const heldAtProbe = heldTimers.length
realAbortTimeout.call(AbortSignal, 20_000)
const probe = AbortSignal.timeout(20_000)
await until(() => probe.aborted)
check('harness: a 20 s AbortSignal.timeout holds no setTimeout, and the shortened one fires on its own',
  heldTimers.length === heldAtProbe && probe.aborted && probe.reason?.name === 'TimeoutError',
  { held: heldTimers.length - heldAtProbe, aborted: probe.aborted, reason: probe.reason?.name })

// Sign-in: the settings page stored a password, and the site never answers.
loginMode = 'hang'
const stuckLogin = await bootInstance(undefined, { password: 'pw-1' })
await until(() => stuckLogin.status()?.state === 'error', SETTLE_TRIES)
check('login hangs: status error, 连不上 PIXEL 主站：连接超时',
  statusIs(stuckLogin.status(), 'error', TIMED_OUT, 'tester'), stuckLogin.status())
check('  ...the password credential is dropped', !stuckLogin.credentials.has('PIXEL_API_PASSWORD'), [...stuckLogin.credentials.keys()])
// The same password stored again, then a settings commit: a volatile update
// reruns reconcile without the password-entry event that lifts the backoff.
loginMode = 'ok'
let callsBefore = loginCalls()
let writesBefore = stuckLogin.statuses.length
stuckLogin.credentials.set('PIXEL_API_PASSWORD', 'pw-1')
stuckLogin.emit('loader/volatile-update')
await until(() => stuckLogin.statuses.length > writesBefore, SETTLE_TRIES)
check('  ...site back, the same password again: signed in (queue free, no backoff)',
  statusIs(stuckLogin.status(), 'ok', '', 'tester'), stuckLogin.status())
check('  ...that sign-in reached the site', loginCalls() === callsBefore + 1, loginCalls() - callsBefore)

// A refusal the site answered still counts: the backoff holds the retry back.
loginMode = 'reject'
const refusedLogin = await bootInstance(undefined, { password: 'pw-2' })
await until(() => refusedLogin.status()?.state === 'error', SETTLE_TRIES)
check('login refused (success:false): status error with the site text',
  statusIs(refusedLogin.status(), 'error', '用户名或密码错误，或用户已被封禁', 'tester'), refusedLogin.status())
callsBefore = loginCalls()
writesBefore = refusedLogin.statuses.length
refusedLogin.credentials.set('PIXEL_API_PASSWORD', 'pw-2')
refusedLogin.emit('loader/volatile-update')
await until(() => refusedLogin.statuses.length > writesBefore, SETTLE_TRIES)
check('  ...the same password right after: held back, 登录连续失败…',
  refusedLogin.status()?.state === 'error' && refusedLogin.status().message.startsWith('登录连续失败'), refusedLogin.status())
check('  ...no second login request sent', loginCalls() === callsBefore, loginCalls() - callsBefore)

// 2FA: the code check hangs. The challenge ends; a new sign-in starts another.
loginMode = '2fa'
verifyMode = 'hang'
const stuckCode = await bootInstance(undefined, { password: 'pw-3' })
await until(() => stuckCode.status()?.state === '2fa', SETTLE_TRIES)
stuckCode.credentials.set('PIXEL_API_2FA', '123456')
stuckCode.emit('credentials/reference-updated', 'PIXEL_API_2FA')
await until(() => stuckCode.status()?.state === 'error', SETTLE_TRIES)
check('2FA check hangs: status error, 连不上 PIXEL 主站：连接超时',
  statusIs(stuckCode.status(), 'error', TIMED_OUT, 'tester'), stuckCode.status())
check('  ...the code credential is dropped', !stuckCode.credentials.has('PIXEL_API_2FA'), [...stuckCode.credentials.keys()])
verifyMode = 'ok'
writesBefore = stuckCode.statuses.length
stuckCode.credentials.set('PIXEL_API_PASSWORD', 'pw-3')
stuckCode.emit('loader/volatile-update')
await until(() => stuckCode.statuses.length > writesBefore && stuckCode.status()?.state === '2fa', SETTLE_TRIES)
stuckCode.credentials.set('PIXEL_API_2FA', '654321')
stuckCode.emit('credentials/reference-updated', 'PIXEL_API_2FA')
await until(() => stuckCode.status()?.state === 'ok', SETTLE_TRIES)
check('  ...site back: a new sign-in and code go through', statusIs(stuckCode.status(), 'ok', '', 'tester'), stuckCode.status())
loginMode = 'ok'

// Session refresh: as when the site is unreachable, the cookie stays and one
// retry is due in 15 s; the log names the timeout, never a bodiless "HTTP 200".
for (const [label, mode, cookie] of [
  ['refresh hangs before any answer', 'hang', 'seed-refresh-d'],
  ['refresh headers arrive, then the body stalls', 'stall', 'seed-refresh-e'],
]) {
  refreshMode = mode
  const heldAtBoot = heldTimers.length
  const retries = () => heldTimers.slice(heldAtBoot).filter((timer) => !timer.fired && !timer.cleared)
  const stuck = await bootInstance(cookie)
  await until(() => retries().length > 0, SETTLE_TRIES)
  check(`${label}: the refresh cookie is kept`, stuck.credentials.get('PIXEL_API_REFRESH') === cookie, [...stuck.credentials.keys()])
  check('  ...status error, with the fixed retry text and the configured user',
    statusIs(stuck.status(), 'error', '暂时连不上 PIXEL 主站，登录状态已保留，稍后自动重试', 'tester'), stuck.status())
  check('  ...one retry pending, due in 15 s', retries().length === 1 && retries()[0].ms === 15_000,
    retries().map((timer) => timer.ms))
  check('  ...the log names 连不上 PIXEL 主站：连接超时, never "HTTP 200"',
    stuck.warnings.some((line) => line.includes(TIMED_OUT)) && !stuck.warnings.some((line) => line.includes('HTTP 200')),
    stuck.warnings)
}
refreshMode = 'ok'

// Sign-out: the revoke call hangs, and the sign-out completes regardless.
const leaving = await bootInstance('seed-refresh-f')
await until(() => leaving.status()?.state === 'ok', SETTLE_TRIES)
logoutMode = 'hang'
leaving.config.signOutAt[WRITE](Date.now())
leaving.emit('loader/volatile-update')
await until(() => leaving.status()?.state === 'none' && leaving.credentials.size === 0, SETTLE_TRIES)
const logoutCall = stuckRequests.findLast((request) => request.path === '/api/user/auth/logout')
check('sign-out while the logout call hangs: that call ends on its own timeout', logoutCall?.ended === 'timeout', logoutCall)
check('  ...the sign-out still completes: status none', statusIs(leaving.status(), 'none', '', ''), leaving.status())
check('  ...every credential is cleared', leaving.credentials.size === 0, [...leaving.credentials.keys()])
logoutMode = 'ok'
AbortSignal.timeout = realAbortTimeout
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout

// ---------------------------------------------------------------------------
// The checks below run on real timers again. `settle` waits out a pass that
// changes nothing visible: its work here is mock calls and promise turns.
const settle = () => new Promise((r) => realSetTimeout(r, 200))
const verifyCalls = () => apiCalls.filter((call) => call.path === '/api/user/login/verify').length
const refreshCalls = () => apiCalls.filter((call) => call.path === '/api/user/auth/refresh').length
const groupFetches = () => apiCalls.filter((call) => call.path === '/api/user/self/groups').length
// One request through an instance's own runtime.
const streamOn = async (instance, responder, messages = [userSays('hi')]) => {
  chat = responder
  const collected = []
  for await (const chunk of instance.llm.stream({ ...ROUTE, messages })) collected.push(chunk)
  return collected
}
const turnedDown = () => json({ error: siteError('', 'new_api_error', '未登录或登录已过期') }, 401)

// ---------------------------------------------------------------------------
// "返回" on the 2FA step bumps cancelChallengeAt. The host drops the pending
// challenge ahead of its challenge branch, which would otherwise put the 2FA
// step straight back and take the next password as its own. Each value is
// served once — a repeated or older one cancels nothing, after a reload too —
// and with no challenge pending it is only recorded.
log('2FA: 返回 from the code step (cancelChallengeAt)')
loginMode = '2fa'
const backing = await bootInstance(undefined, { password: 'pw-7' })
await until(() => backing.status()?.state === '2fa')
check('setup: the sign-in stops at the 2FA step', backing.status()?.state === '2fa', backing.status())
// A code and a password are stored, but 返回 is pressed before the host acts
// on them (no credential event fired for either).
backing.credentials.set('PIXEL_API_2FA', '111111')
backing.credentials.set('PIXEL_API_PASSWORD', 'pw-7')
let verifiesAt = verifyCalls()
let loginsAt = loginCalls()
const cancelAt = Date.now()
backing.config.cancelChallengeAt?.[WRITE]?.(cancelAt)
backing.emit('loader/volatile-update')
await until(() => backing.status()?.state !== '2fa')
check('返回: status none, with no message and no user', statusIs(backing.status(), 'none', '', ''), backing.status())
check('  ...the code and the password credentials are deleted',
  !backing.credentials.has('PIXEL_API_2FA') && !backing.credentials.has('PIXEL_API_PASSWORD'), [...backing.credentials.keys()])
check('  ...neither the code nor the password went to the site',
  verifyCalls() === verifiesAt && loginCalls() === loginsAt, { verify: verifyCalls() - verifiesAt, login: loginCalls() - loginsAt })
check('  ...the served value is stamped into the status', backing.status()?.cancelChallengeAt === cancelAt, backing.status())
check('  ...the username stays for the login form', read(backing.config.username) === 'tester', read(backing.config.username))
// In the host that status write re-runs reconcile: the 2FA step must not return.
let writesAt = backing.statuses.length
backing.emit('loader/volatile-update')
await until(() => backing.statuses.length > writesAt)
check('  ...the next pass leaves the 2FA step gone', backing.status()?.state === 'none', backing.status())
// A new sign-in from the login form: its password reaches the site.
loginsAt = loginCalls()
backing.credentials.set('PIXEL_API_PASSWORD', 'pw-8')
backing.emit('credentials/reference-updated', 'PIXEL_API_PASSWORD')
await until(() => loginCalls() > loginsAt && backing.status()?.state === '2fa')
check('a new password after 返回 goes to the site as a new sign-in, not to the old challenge',
  loginCalls() === loginsAt + 1 && backing.status()?.state === '2fa', { login: loginCalls() - loginsAt, status: backing.status() })
// That sign-in stopped at the 2FA step again. The served value once more, then
// an older one: neither cancels the new challenge.
writesAt = backing.statuses.length
backing.config.cancelChallengeAt?.[WRITE]?.(cancelAt)
backing.emit('loader/volatile-update')
await settle()
backing.config.cancelChallengeAt?.[WRITE]?.(cancelAt - 1000)
backing.emit('loader/volatile-update')
await settle()
check('  ...the served value again, then an older one: the new challenge stays',
  backing.status()?.state === '2fa' && loginCalls() === loginsAt + 1 && backing.statuses.length === writesAt,
  { status: backing.status(), writes: backing.statuses.length - writesAt })
verifiesAt = verifyCalls()
backing.credentials.set('PIXEL_API_2FA', '222222')
backing.emit('credentials/reference-updated', 'PIXEL_API_2FA')
await until(() => backing.status()?.state === 'ok')
check('  ...and its code completes the sign-in',
  statusIs(backing.status(), 'ok', '', 'tester') && verifyCalls() === verifiesAt + 1,
  { status: backing.status(), verify: verifyCalls() - verifiesAt })
// Signed in, no challenge pending: 返回 is only recorded.
writesAt = backing.statuses.length
const keysAt = [...backing.credentials.keys()]
const idleCancelAt = Date.now() + 1
backing.config.cancelChallengeAt?.[WRITE]?.(idleCancelAt)
backing.emit('loader/volatile-update')
await until(() => backing.statuses.length > writesAt)
check('返回 with no challenge pending: still signed in, credentials and routes as they were',
  backing.status()?.state === 'ok' && isDeepStrictEqual([...backing.credentials.keys()], keysAt) && backing.registered.length === 1,
  { status: backing.status(), credentials: [...backing.credentials.keys()], registered: backing.registered.length })
check('  ...only the served value is recorded, riding the next status write',
  backing.status()?.cancelChallengeAt === idleCancelAt, backing.status())
// A reload starts from the stored config, the served value in its status: the
// next fiber leaves its own new challenge alone, and a newer value still works.
const reloaded = await bootInstance(undefined, {
  password: 'pw-9',
  config: { cancelChallengeAt: idleCancelAt, auth: { state: 'ok', user: 'tester', cancelChallengeAt: idleCancelAt } },
})
await until(() => reloaded.status()?.state === '2fa')
check('after a reload, the served value does not cancel the new challenge', reloaded.status()?.state === '2fa', reloaded.status())
reloaded.config.cancelChallengeAt?.[WRITE]?.(Date.now() + 2)
reloaded.emit('loader/volatile-update')
await until(() => reloaded.status()?.state !== '2fa')
check('  ...a newer value still cancels it', statusIs(reloaded.status(), 'none', '', ''), reloaded.status())
loginMode = 'ok'

// ---------------------------------------------------------------------------
// The site rotates the refresh cookie with every session it issues and
// revokes the session when the replaced one comes back more than 30 s later
// (new-api-main model/user_session.go RotateUserSessionRefresh), so the new
// cookie must be stored before the session is taken on. Here the credential
// store refuses that write, naming another temp file each time.
log('Rotated refresh cookie the credential store cannot keep')
const STORE_FAILED = 'PIXEL 登录会话保存失败：本机凭据写入出错，登录无法保持'
refreshMode = 'rotate'
const unkept = await bootInstance('seed-refresh-g', { failingWrites: ['PIXEL_API_REFRESH'] })
await until(() => unkept.status() !== undefined)
check('a refresh whose new cookie is not stored: status error with the fixed text (not ok, not 会话已过期)',
  statusIs(unkept.status(), 'error', STORE_FAILED), unkept.status())
check('  ...the session is not taken on: no routes registered', unkept.registered.length === 0, unkept.registered)
check('  ...the stored cookie is left as it was', unkept.credentials.get('PIXEL_API_REFRESH') === 'seed-refresh-g',
  unkept.credentials.get('PIXEL_API_REFRESH'))
check("  ...the store's own reason is in the log", unkept.warnings.some((line) => line.includes('EPERM')), unkept.warnings)
// In the host that status write re-runs reconcile. The same failure again,
// under another temp file name, must leave the status alone: a changing text
// would start the next pass, and the next, until the old cookie expired.
let refreshesAt = refreshCalls()
writesAt = unkept.statuses.length
unkept.emit('loader/volatile-update')
await until(() => refreshCalls() > refreshesAt)
await settle()
check('  ...failing again under another reason rewrites nothing (no write → reconcile loop)',
  refreshCalls() === refreshesAt + 1 && unkept.statuses.length === writesAt,
  { refreshes: refreshCalls() - refreshesAt, writes: unkept.statuses.length - writesAt })
unkept.failingWrites.clear()
unkept.emit('loader/volatile-update')
await until(() => unkept.status()?.state === 'ok')
check('  ...the store writable again: the next pass keeps the session, its new cookie stored',
  statusIs(unkept.status(), 'ok', '', 'tester') && /^rotated-\d+$/.test(unkept.credentials.get('PIXEL_API_REFRESH') ?? ''),
  { status: unkept.status(), cookie: unkept.credentials.get('PIXEL_API_REFRESH') })
// A chat request the site turned down refreshes the session itself: the same
// failure fails that request under its own code and the fixed text — not
// AUTH, whose text the chat blanks — and nothing is sent again.
const chatting = await bootInstance('seed-refresh-h')
await until(() => chatting.status()?.state === 'ok' && chatting.registered.length > 0)
chatting.failingWrites.add('PIXEL_API_REFRESH')
const sentAt = chatBodies.length
let chatAttempts = 0
const unkeptChat = finishOf(await streamOn(chatting, () => (chatAttempts++ === 0 ? turnedDown() : answered())))?.failure
check('chat 401, then a refresh whose new cookie is not stored: NO_CREDENTIAL_STORE with the fixed text',
  failureMatches(unkeptChat, { code: 'NO_CREDENTIAL_STORE', message: STORE_FAILED }), unkeptChat)
check('  ...the request is not sent again', chatBodies.length - sentAt === 1, chatBodies.length - sentAt)
refreshMode = 'ok'
// A sign-in whose cookie is not stored fails the same way, and is no failed
// login: the same password right after is sent, not held back by the backoff.
loginMode = 'rotate'
const unkeptLogin = await bootInstance(undefined, { password: 'pw-10', failingWrites: ['PIXEL_API_REFRESH'] })
await until(() => unkeptLogin.status() !== undefined)
check('a sign-in whose new cookie is not stored: status error with the fixed text',
  statusIs(unkeptLogin.status(), 'error', STORE_FAILED, 'tester'), unkeptLogin.status())
check('  ...that session is not taken on either: no routes registered', unkeptLogin.registered.length === 0, unkeptLogin.registered)
unkeptLogin.failingWrites.clear()
loginsAt = loginCalls()
unkeptLogin.credentials.set('PIXEL_API_PASSWORD', 'pw-10')
unkeptLogin.emit('loader/volatile-update')
await until(() => unkeptLogin.status()?.state === 'ok')
check('  ...the same password right after goes to the site (no login backoff): signed in',
  statusIs(unkeptLogin.status(), 'ok', '', 'tester') && loginCalls() === loginsAt + 1,
  { status: unkeptLogin.status(), login: loginCalls() - loginsAt })
// The same through a 2FA code.
loginMode = '2fa'
verifyMode = 'rotate'
const unkeptCode = await bootInstance(undefined, { password: 'pw-11', failingWrites: ['PIXEL_API_REFRESH'] })
await until(() => unkeptCode.status()?.state === '2fa')
unkeptCode.credentials.set('PIXEL_API_2FA', '333333')
unkeptCode.emit('credentials/reference-updated', 'PIXEL_API_2FA')
await until(() => unkeptCode.status()?.state !== '2fa')
check('a 2FA code accepted, its new cookie not stored: status error with the fixed text',
  statusIs(unkeptCode.status(), 'error', STORE_FAILED, 'tester'), unkeptCode.status())
check("  ...the code's session is not taken on: no routes registered", unkeptCode.registered.length === 0, unkeptCode.registered)
loginMode = 'ok'
verifyMode = 'ok'

// ---------------------------------------------------------------------------
// The runtime keeps each route's display name from registration (dsh-llm
// prepareRoutes reads providerInfo), and only a replace reads it again. A
// group whose ratio or room name the site changed under the same key must
// still reach it; an unchanged reload must not replace anything.
log('Route names follow the site (ratio, room name)')
const providerNames = (instance) =>
  Object.fromEntries(instance.llm.listProviders().map((provider) => [provider.id, provider.name]))
// A signed-in instance, then one settings-page refresh (a full reload of the
// groups) with the site answering `groups`.
const reloadWith = async (groups) => {
  siteGroups = DEFAULT_GROUPS
  const instance = await bootInstance('seed-refresh-i')
  await until(() => instance.status()?.state === 'ok' && instance.registered.length > 0)
  let announced = 0
  instance.app.on('llm/adapters-updated', () => { announced += 1 })
  siteGroups = groups
  const fetchesAt = groupFetches()
  const writesBefore = instance.statuses.length
  instance.config.refreshAt[WRITE](Date.now())
  instance.emit('loader/volatile-update')
  await until(() => groupFetches() > fetchesAt && instance.statuses.length > writesBefore)
  siteGroups = DEFAULT_GROUPS
  return {
    names: providerNames(instance),
    ids: instance.llm.listProviders().map((provider) => provider.id),
    announced,
    fetched: groupFetches() - fetchesAt,
  }
}
let renamed = await reloadWith(DEFAULT_GROUPS)
check('unchanged groups: names carry the ratio, and a reload replaces nothing',
  isDeepStrictEqual(renamed.names, { 'pixel/room-1024': 'Room 1024 ×0.5', 'pixel/default': 'default ×1' })
  && renamed.fetched === 1 && renamed.announced === 0, renamed)
renamed = await reloadWith({ ...DEFAULT_GROUPS, default: { ratio: 1.5 } })
check("a group's ratio changed under the same key: the runtime has the new name, announced once",
  isDeepStrictEqual(renamed.names, { 'pixel/room-1024': 'Room 1024 ×0.5', 'pixel/default': 'default ×1.5' })
  && renamed.announced === 1, renamed)
renamed = await reloadWith({ ...DEFAULT_GROUPS, 'room-1024': { ...DEFAULT_GROUPS['room-1024'], room_name: 'Room 2048' } })
check('a room renamed under the same key: the runtime has the new name, announced once',
  isDeepStrictEqual(renamed.names, { 'pixel/room-1024': 'Room 2048 ×0.5', 'pixel/default': 'default ×1' })
  && renamed.announced === 1, renamed)
check('  ...the same routes, in the same order', isDeepStrictEqual(renamed.ids, ['pixel/room-1024', 'pixel/default']), renamed.ids)

// ---------------------------------------------------------------------------
// A profile that mounts no attachment service: every request builds its image
// reader, so only reading an image may fail, never a text-only request.
log('No attachment service mounted')
const bare = await bootInstance('seed-refresh-m', { attachments: false })
await until(() => bare.status()?.state === 'ok' && bare.registered.length > 0)
let bareChunks = await streamOn(bare, answered)
check('a text-only request goes through', finishOf(bareChunks)?.kind === 'stop', finishOf(bareChunks))
const sentBeforeImage = chatBodies.length
bareChunks = await streamOn(bare, answered, [{ role: 'user', content: [textBlock('look'), imageBlock('img-1')] }])
check('  ...a request with an image still fails UNSUPPORTED_CONTENT, before anything is sent',
  failureMatches(finishOf(bareChunks)?.failure, {
    code: 'UNSUPPORTED_CONTENT',
    message: 'pixel-api: image input needs the attachment service, which this profile does not mount',
  }) && chatBodies.length === sentBeforeImage,
  { failure: finishOf(bareChunks)?.failure, sent: chatBodies.length - sentBeforeImage })

// ---------------------------------------------------------------------------
// A chat request turned down (401) while a reconcile is between site calls.
// The token it drops goes on the session chain, so the reconcile's later calls
// still carry the token it checked, never an empty Bearer. Only that token is
// dropped: a second request turned down with it keeps the token the first
// one's refresh brought, instead of refreshing again.
log('A chat 401 while a reconcile is in flight')
const racing = await bootInstance('seed-refresh-n')
await until(() => racing.status()?.state === 'ok' && racing.registered.length > 0)
let releaseChat
const chatHeld = new Promise((resolve) => { releaseChat = resolve })
let raceAttempts = 0
let raceToken
const raceStream = streamOn(racing, async (body, init) => {
  raceAttempts += 1
  if (raceAttempts > 1) return answered()
  raceToken = new Headers(init.headers).get('authorization')
  await chatHeld
  return turnedDown()
})
await until(() => raceAttempts === 1)
// A settings-page refresh starts a full reload, held at the group list.
let releaseGroups
groupsGate = new Promise((resolve) => { releaseGroups = resolve })
const callsAtReload = apiCalls.length
const fetchesAtRace = groupFetches()
racing.config.refreshAt[WRITE](Date.now())
racing.emit('loader/volatile-update')
await until(() => groupFetches() > fetchesAtRace)
// The site turns the chat request down meanwhile; then the group list arrives.
releaseChat()
await settle()
groupsGate = undefined
releaseGroups()
const raceChunks = await raceStream
const reloadCalls = apiCalls.slice(callsAtReload)
  .filter((call) => call.path === '/api/pricing' || call.path === '/api/user/self')
check('reconcile calls after the chat 401 still carry the token it checked, not an empty one',
  reloadCalls.length === 2 && raceToken !== undefined && reloadCalls.every((call) => call.authorization === raceToken),
  { raceToken, reloadCalls })
check('  ...the chat request then refreshes and goes through', finishOf(raceChunks)?.kind === 'stop' && raceAttempts === 2,
  { finish: finishOf(raceChunks), attempts: raceAttempts })
const pair = await bootInstance('seed-refresh-o')
await until(() => pair.status()?.state === 'ok' && pair.registered.length > 0)
// Each request's first attempt waits for its release, then is turned down.
const holds = new Map()
const turnedDownOnce = new Set()
const pairResponder = async (body) => {
  const text = body.messages.at(-1).content
  if (turnedDownOnce.has(text)) return answered()
  turnedDownOnce.add(text)
  await new Promise((resolve) => holds.set(text, resolve))
  return turnedDown()
}
const refreshesAtPair = refreshCalls()
const streamA = streamOn(pair, pairResponder, [userSays('A')])
const streamB = streamOn(pair, pairResponder, [userSays('B')])
await until(() => holds.size === 2)
holds.get('A')?.()
const chunksA = await streamA
holds.get('B')?.()
const chunksB = await streamB
check('two requests turned down with the same token: one refresh, and both go through',
  refreshCalls() - refreshesAtPair === 1 && finishOf(chunksA)?.kind === 'stop' && finishOf(chunksB)?.kind === 'stop',
  { refreshes: refreshCalls() - refreshesAtPair, a: finishOf(chunksA), b: finishOf(chunksB) })

check('every site request refused redirects', redirectViolations === 0, redirectViolations)
const unsignalled = apiCalls.filter((call) => !call.signalled)
check('every /api/* request carried an abort signal', unsignalled.length === 0,
  { count: unsignalled.length, paths: [...new Set(unsignalled.map((call) => call.path))] })
check('no plugin warnings', warnings.length === 0, warnings)
finish()
