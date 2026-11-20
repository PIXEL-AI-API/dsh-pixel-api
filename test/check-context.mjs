// Host-half check: declared context capacity, refusal and overflow mapping,
// and the wire shape of tool results.
// Boots the real plugin module against the real LlmRuntime with a fake ctx and
// a mocked PIXEL site — no network, no credentials, nothing billed.
//
//   Desktop runtime (modules inside app.asar):
//     ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/check-context.mjs [out-file]
//   Any runtime whose @deepseek-ai/* packages resolve from the plugin directory:
//     node test/check-context.mjs [out-file]
//
// Exits 1 when a check fails.
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
const { LlmRuntime } = await runtimeImport('@deepseek-ai/dsh-llm', 'lib/index.js')
const plugin = await import(pathToFileURL(join(here, '..', 'index.js')).href)
const WRITE = Symbol.for('cosmokit.volatile.write')
const read = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)

// ---------------------------------------------------------------------------
log('Config')
const defaults = plugin.Config({})
check('default contextWindow is 272000', read(defaults.contextWindow) === 272000, read(defaults.contextWindow))
check('default contextWindows is empty', JSON.stringify(read(defaults.contextWindows)) === '{}', read(defaults.contextWindows))
const rejects = (input) => { try { plugin.Config(input); return false } catch { return true } }
check('rejects a non-numeric contextWindow', rejects({ contextWindow: '272k' }))
check('rejects a fractional contextWindow', rejects({ contextWindow: 1.5 }))
check('rejects a negative per-model window', rejects({ contextWindows: { x: -5 } }))

// ---------------------------------------------------------------------------
// Mocked site. Every request must refuse redirects (index.js siteFetch).
const SITE = 'https://api.ai-pixel.online'
const chatBodies = []
let chat = () => { throw new Error('no chat responder') }
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const sse = (events) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder()
    for (const event of events) {
      controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`))
    }
    controller.close()
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })
let redirectViolations = 0
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.origin !== SITE) throw new Error(`unexpected host ${target.origin}`)
  if (init.redirect !== 'error') redirectViolations += 1
  switch (target.pathname) {
    case '/api/user/auth/refresh':
      return json({
        success: true,
        data: {
          access_token: 'mock-access-token',
          access_expires_at: Math.floor(Date.now() / 1000) + 3600,
          session: { sid: 'sid-1' },
          user: { username: 'tester' },
        },
      })
    case '/api/user/self/groups':
      return json({ success: true, data: { 'room-1024': { is_room: true, room_name: 'Room 1024', ratio: 0.5, kind: 'pool' }, default: { ratio: 1 } } })
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
    case '/pg/chat/completions':
      chatBodies.push(JSON.parse(init.body))
      return chat()
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
const fakeCtx = {
  logger: { warn: (...parts) => warnings.push(parts.map(String).join(' ')), info() {}, debug() {}, error() {} },
  effect(fn) { fn(); return () => {} },
  on() { return () => {} },
  inject() {},
  get(name) {
    if (name === 'credentials') {
      return {
        resolve: async (ref) => (credentials.has(ref) ? { value: credentials.get(ref) } : undefined),
        set: async (ref, value) => { credentials.set(ref, value) },
        unset: async (ref) => { credentials.delete(ref) },
      }
    }
    if (name === 'configEditor') return { edit: async () => {} }
    if (name === 'attachments') return { readImageRequest: (ref, target) => readImageRequest(ref, target) }
    return undefined
  },
  fiber: { entry: { id: 'pixel-api' } },
  llm: {
    registerAdapter(ids, adapter) {
      registered.push(ids)
      return llm.registerAdapter(ids, adapter)
    },
  },
}

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

const httpError = (status, error) => () => json({ error }, status)
chunks = await run(httpError(400, { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum (request id: r1)' }))
check('passed-through Claude overflow -> CONTEXT_WINDOW_EXCEEDED', finishOf(chunks)?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576). (request id: r2)' }))
check('passed-through Gemini overflow -> CONTEXT_WINDOW_EXCEEDED', finishOf(chunks)?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'context_length_exceeded', type: 'invalid_request_error', message: "The input exceeds the model's context window. Please shorten the input and try again. (request id: r3)" }))
check('site-normalized overflow -> CONTEXT_WINDOW_EXCEEDED', finishOf(chunks)?.failure?.code === 'CONTEXT_WINDOW_EXCEEDED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'content_policy_violation', type: 'invalid_request_error', message: 'The request was rejected by the content policy. (request id: r4)' }))
check('content policy rejection -> CONTENT_REFUSED', finishOf(chunks)?.failure?.code === 'CONTENT_REFUSED', finishOf(chunks))
chunks = await run(httpError(400, { code: 'invalid_request', type: 'invalid_request_error', message: 'bad parameter (request id: r5)' }))
check('ordinary 400 stays BAD_REQUEST', finishOf(chunks)?.failure?.code === 'BAD_REQUEST', finishOf(chunks))

// ---------------------------------------------------------------------------
// Usage: the site's OpenAI-shaped usage per upstream family (new-api-main
// relaykit: claude_messages/to_oai_chat_resp.go buildOpenAIStyleUsageFromClaudeUsage,
// gemini_chat/to_oai_chat_resp.go, OpenAI passthrough, DeepSeek-type hit/miss).
log('Usage mapping (cache buckets the client turns into a hit rate)')
// Mirror of dsh-token-meter src/turn-usage.ts normalizeUsage (lines 85-113):
// usage that fails it is dropped from turn usage.
const keptByTurnUsage = (u) => {
  const isCount = (v) => Number.isSafeInteger(v) && v >= 0
  if (!isCount(u.inputTokens) || !isCount(u.outputTokens)) return false
  if (u.cacheReadTokens !== undefined && !isCount(u.cacheReadTokens)) return false
  if (u.cacheWriteTokens !== undefined && !isCount(u.cacheWriteTokens)) return false
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
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']
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

check('every site request refused redirects', redirectViolations === 0, redirectViolations)
check('no plugin warnings', warnings.length === 0, warnings)
finish()
