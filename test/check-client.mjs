// Client-half check for the 设置 → PIXEL API page. Executes the real client.js
// in a vm with a minimal hook renderer and a fake settings/credentials wire,
// then drives the page: the context window row (folded by default; display,
// validation, save, restore defaults), the GPT replay switch, the plugin
// version row (check, confirm, each state), sign-out confirmation, the login
// card (field checks, progress read from the password credential, refusals,
// the 2FA step's auto-submit and a refused code), and the view of a session
// that is kept while the site cannot be reached.
//   node test/check-client.mjs [out-file]
// Exits 1 when a check fails. Layout, styling and motion still need a look in the app.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const lines = []
let failures = 0
const log = (line) => { lines.push(line); console.log(line) }
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
}

// --- minimal React: element objects plus a re-rendering hook dispatcher -----
// Hook state lives per tree position (and key). A component not rendered in a
// pass is unmounted: its effect cleanups run and its state is dropped.
const FRAGMENT = Symbol('fragment')
const same = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]))
function createRenderer() {
  const nodes = new Map()
  const errors = []
  let instance
  let dirty = false
  let elements = []
  let texts = []
  let visited = new Set()
  let ids = 0
  const nodeFor = (key) => {
    visited.add(key)
    if (!nodes.has(key)) nodes.set(key, { hooks: [], deps: [], cleanups: [], pending: [] })
    return nodes.get(key)
  }
  const call = (type, props, path) => {
    const node = nodeFor(`${path}:${type.name || 'anon'}`)
    node.cursor = 0
    const previous = instance
    instance = node
    try {
      return { out: type(props), pending: node.pending.splice(0) }
    } catch (error) {
      errors.push(`render ${type.name}: ${error?.stack ?? error}`)
      return { out: null, pending: node.pending.splice(0) }
    } finally {
      instance = previous
    }
  }
  const walk = (el, path, effects) => {
    if (el === null || el === undefined || typeof el === 'boolean') return
    if (typeof el === 'string' || typeof el === 'number') { texts.push(String(el)); return }
    if (Array.isArray(el)) { el.forEach((child, i) => walk(child, `${path}/${i}`, effects)); return }
    if (!el.__el) return
    const at = el.props.key === undefined ? path : `${path}#${el.props.key}`
    if (el.type === FRAGMENT) { walk(el.props.children, `${at}/f`, effects); return }
    if (typeof el.type === 'function') {
      const { out, pending } = call(el.type, el.props, at)
      effects.push(...pending)
      walk(out, `${at}/${el.type.name}`, effects)
      return
    }
    elements.push(el)
    walk(el.props.children, `${at}/${el.type}`, effects)
  }
  const dispatcher = {
    useState(initial) {
      const node = instance
      const i = node.cursor++
      if (!(i in node.hooks)) node.hooks[i] = typeof initial === 'function' ? initial() : initial
      return [node.hooks[i], (value) => {
        const next = typeof value === 'function' ? value(node.hooks[i]) : value
        if (next !== node.hooks[i]) { node.hooks[i] = next; dirty = true }
      }]
    },
    useEffect(fn, deps) {
      const node = instance
      const i = node.cursor++
      if (node.deps[i] === undefined || deps === undefined || !same(node.deps[i], deps)) {
        node.deps[i] = deps ?? null
        node.pending.push(() => {
          if (typeof node.cleanups[i] === 'function') node.cleanups[i]()
          node.cleanups[i] = fn()
        })
      }
    },
    useMemo(fn, deps) {
      const node = instance
      const i = node.cursor++
      if (!(i in node.hooks) || !same(node.deps[i], deps)) { node.hooks[i] = fn(); node.deps[i] = deps }
      return node.hooks[i]
    },
    useRef(initial) {
      const node = instance
      const i = node.cursor++
      if (!(i in node.hooks)) node.hooks[i] = { current: initial }
      return node.hooks[i]
    },
    useId() {
      const node = instance
      const i = node.cursor++
      if (!(i in node.hooks)) node.hooks[i] = `:r${++ids}:`
      return node.hooks[i]
    },
  }
  return {
    errors,
    dispatcher,
    get elements() { return elements },
    get text() { return texts.join(' ') },
    async settle(Component, props) {
      for (let pass = 0; pass < 25; pass++) {
        dirty = false
        elements = []
        texts = []
        visited = new Set()
        const effects = []
        const root = call(Component, props, 'root')
        effects.push(...root.pending)
        walk(root.out, 'root/0', effects)
        for (const [key, node] of nodes) {
          if (visited.has(key)) continue
          for (const cleanup of node.cleanups) if (typeof cleanup === 'function') cleanup()
          nodes.delete(key)
        }
        for (const effect of effects) {
          try { effect() } catch (error) { errors.push(`effect: ${error?.stack ?? error}`) }
        }
        await new Promise((r) => setTimeout(r, 10))
        if (!dirty) return
      }
      errors.push('render did not settle')
    },
  }
}

let renderer = createRenderer()
const React = {
  Fragment: FRAGMENT,
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { __el: true, type, props: merged }
  },
  useState: (...a) => renderer.dispatcher.useState(...a),
  useEffect: (...a) => renderer.dispatcher.useEffect(...a),
  useMemo: (...a) => renderer.dispatcher.useMemo(...a),
  useCallback: (fn, deps) => renderer.dispatcher.useMemo(() => fn, deps),
  useRef: (...a) => renderer.dispatcher.useRef(...a),
  useId: () => renderer.dispatcher.useId(),
  useSyncExternalStore: (subscribe, get) => get(),
}

// --- run client.js ----------------------------------------------------------
const loaders = []
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => loaders.push(definition) }, addEventListener() {}, removeEventListener() {} },
  document: { getElementById: () => null, createElement: () => ({ remove() {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
  queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
vm.runInContext(source, sandbox, { filename: 'client.js' })
check('client.js registers with the module loader', loaders.length === 1)
const exports = loaders[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`no ${name} in this check`)
})

// --- fake host: settings document, credential store, update events ---------
const NS = 'pixel-api'
const REFS = { password: 'PIXEL_API_PASSWORD', refresh: 'PIXEL_API_REFRESH', otp: 'PIXEL_API_2FA' }
const RETRY_TEXT = '暂时连不上 PIXEL 主站，登录状态已保留，稍后自动重试'
const authStatus = (fields) => ({
  state: 'none', message: '', user: '', groups: [], groupCount: 0, models: -1, signOutAt: 0,
  profile: { id: 0, name: '', group: '', balance: '', used: '', requests: 0, updatedAt: 0 },
  ...fields,
})
const OK_FIELDS = {
  state: 'ok', user: 'tester', groupCount: 2, models: 3,
  profile: { id: 7, name: 'tester', group: 'default', balance: '$1.00', used: '$0.01', requests: 3, updatedAt: Date.now() },
}
let section = { username: 'tester', contextWindow: 272000, contextWindows: {}, auth: authStatus(OK_FIELDS) }
let creds = { [REFS.password]: false, [REFS.refresh]: true, [REFS.otp]: false }
const mutations = []
// Every wire write in order: { kind: 'mutate', ns, ops } or { kind: 'set' | 'unset', ref, value }.
const wire = []
const ok = (value) => ({ ok: true, value })
// Like the real wire: a committed write announces itself.
const listeners = new Map()
const emit = (name) => { for (const fn of listeners.get(name) ?? []) fn() }
const remote = {
  settings: {
    describe: async () => ok({ namespaces: [{ ns: NS, value: section }] }),
    mutate: async (ns, ops) => {
      mutations.push({ ns, ops })
      wire.push({ kind: 'mutate', ns, ops })
      for (const op of ops) section = { ...section, [op.path[0]]: op.value }
      setTimeout(() => emit('settings/document-updated'), 0)
      return ok(undefined)
    },
  },
  credentials: {
    describe: async (refs) => ok(Object.fromEntries(refs.map((ref) => [ref, { configured: creds[ref] === true }]))),
    set: async (ref, value) => {
      wire.push({ kind: 'set', ref, value })
      creds = { ...creds, [ref]: true }
      setTimeout(() => emit('credentials/record-updated'), 0)
      return ok(undefined)
    },
    unset: async (ref) => {
      wire.push({ kind: 'unset', ref })
      creds = { ...creds, [ref]: false }
      setTimeout(() => emit('credentials/record-updated'), 0)
      return ok(undefined)
    },
  },
  $on: (name, fn) => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn])
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn))
  },
}
const dicts = {}
const registrations = []
exports.apply({
  effect: (fn) => fn(),
  locale: {
    register: (ns, map) => { dicts[ns] = map; return () => {} },
    bind: (ns) => (key) => dicts[ns]?.zh?.[key] ?? key,
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
  inject: () => {},
  remote,
})
const page = registrations.find((r) => r.options.name === 'settings.section')
check('settings.section registered', page !== undefined)
const props = page.options.inject()
const t = props.t
const zh = dicts[NS].zh
const en = dicts[NS].en
const missing = Object.keys(zh).filter((k) => /^(ctx|err\.ctx|upd|replay)\./.test(k)).filter((k) => !(k in en))
check('every ctx/upd/replay string has an English entry', missing.length === 0, missing)
const onlyZh = Object.keys(zh).filter((k) => !(k in en))
const onlyEn = Object.keys(en).filter((k) => !(k in zh))
check('zh and en carry the same keys', onlyZh.length === 0 && onlyEn.length === 0, { onlyZh, onlyEn })
const read = new Set([...source.matchAll(/\bt\('([^']+)'\)|fillText\(t, '([^']+)'/g)].map((m) => m[1] ?? m[2]))
const undefinedKeys = [...read].filter((k) => !(k in zh))
const unusedKeys = Object.keys(zh).filter((k) => !read.has(k))
check('every copy key the page reads exists, and every key is read', undefinedKeys.length === 0 && unusedKeys.length === 0, { undefinedKeys, unusedKeys })

// --- locating things ----------------------------------------------------------
const settle = () => renderer.settle(page.component, props)
const find = (pred) => renderer.elements.find(pred)
const cls = (el) => String(el?.props.className || '')
const hasClass = (el, name) => cls(el).split(' ').includes(name)
// Text inside a node: strings under host and fragment elements. Components
// (icons, spinners, folding regions) are opaque here.
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.__el && typeof node.type !== 'function') return textOf(node.props.children)
  return ''
}
const button = (label) => find((el) => el.type === 'button' && textOf(el.props.children) === label)
const buttonsIn = (el) => {
  const out = []
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || !node.__el || typeof node.type === 'function') return
    if (node.type === 'button') out.push(node)
    visit(node.props.children)
  }
  visit(el?.props.children)
  return out
}
const rowOf = (title) => find((el) => hasClass(el, 'pxa-row') && textOf(el.props.children).includes(title))
const input = () => find((el) => el.type === 'input' && hasClass(el, 'narrow'))
const textarea = () => find((el) => el.type === 'textarea')
const field = (name) => find((el) => el.type === 'input' && el.props.name === name)
const otpInput = () => find((el) => el.type === 'input' && hasClass(el, 'pxa-otp'))
const loginCard = () => find((el) => hasClass(el, 'pxa-login'))
const messageOpen = () => hasClass(find((el) => hasClass(el, 'pxa-expand') && hasClass(el, 'drop')), 'open')
const skeletonShown = () => find((el) => hasClass(el, 'pxa-skel')) !== undefined
const type = async (el, value) => { el.props.onChange({ target: { value } }); await settle() }
const click = async (label) => { await button(label).props.onClick(); await settle() }
const submit = async () => { await find((el) => el.type === 'form').props.onSubmit({ preventDefault() {} }); await settle() }
// No animation runs in this vm: end the login card's shake by hand.
const endShake = async () => {
  const card = loginCard()
  card.props.onAnimationEnd({ target: card, currentTarget: card })
  await settle()
}
// The host writing its status and/or changing credentials.
const host = async ({ auth, creds: changed } = {}) => {
  if (auth) section = { ...section, auth: authStatus(auth) }
  if (changed) creds = { ...creds, ...changed }
  emit('settings/document-updated')
  emit('credentials/record-updated')
  await settle()
}

// --- connected: the context window row ---------------------------------------
await settle()
check('no render errors', renderer.errors.length === 0, renderer.errors)
check('card title rendered', renderer.text.includes(t('ctx.title')))
check('summary shows the default window', /272[,.\s]?000/.test(renderer.text) && renderer.text.includes('0 条单独设置'), renderer.text.slice(0, 400))
check('the editor starts folded', input() === undefined && textarea() === undefined && button(t('ctx.edit'))?.props['aria-expanded'] === false)
await click(t('ctx.edit'))
check('编辑 unfolds the editor and becomes 收起',
  input() !== undefined && textarea() !== undefined && button(t('ctx.collapse'))?.props['aria-expanded'] === true)
check('default input shows 272000', input()?.props.value === '272000', input()?.props.value)
check('save disabled until edited', button(t('ctx.save'))?.props.disabled === true)
check('restore disabled while already default', button(t('ctx.reset'))?.props.disabled === true)

await type(input(), '60000')
await click(t('ctx.save'))
check('window <= 65536 rejected without a write', mutations.length === 0 && renderer.text.includes(t('err.ctx.default')), mutations)
check('the error sits on its field, which turns red, and the editor shakes',
  input()?.props['aria-invalid'] === true && typeof input()?.props['aria-describedby'] === 'string'
  && hasClass(find((el) => hasClass(el, 'pxa-edit')), 'pxa-shake'))

await type(input(), '1m')
await type(textarea(), 'gemini-* = 1,048,576\n# comment\n\nclaude-opus-5-5 = 200k\nGEMINI-* = 2m')
await click(t('ctx.save'))
const saved = mutations.at(-1)
check('save writes both fields in one mutation', saved?.ns === NS && saved.ops.length === 2, saved)
check('1m parsed to 1000000', saved?.ops.find((o) => o.path[0] === 'contextWindow')?.value === 1000000, saved)
check('rules parsed, case-duplicate keeps the last line',
  JSON.stringify(saved?.ops.find((o) => o.path[0] === 'contextWindows')?.value) === JSON.stringify({ 'claude-opus-5-5': 200000, 'GEMINI-*': 2000000 }),
  saved?.ops.find((o) => o.path[0] === 'contextWindows')?.value)
check('saved notice shown', renderer.text.includes(t('ctx.saved')))
check('summary follows the stored value', /1[,.\s]?000[,.\s]?000/.test(renderer.text) && renderer.text.includes('2 条单独设置'), renderer.text.slice(0, 400))

const before = mutations.length
await type(textarea(), 'gemini-* 100')
await click(t('ctx.save'))
check('malformed rule rejected with its line number', mutations.length === before && renderer.text.includes('第 1 行'), renderer.text.slice(0, 400))
check('a rule error marks the rules field', textarea()?.props['aria-invalid'] === true && input()?.props['aria-invalid'] === false)
await type(textarea(), '* = 500000')
await click(t('ctx.save'))
check('bare * rejected', mutations.length === before && renderer.text.includes(t('err.ctx.star').replace('{line}', '1')))
await type(textarea(), 'claude-opus-5-5 = 60000')
await click(t('ctx.save'))
check('rule <= 65536 rejected', mutations.length === before)

await click(t('ctx.reset'))
const reset = mutations.at(-1)
check('restore defaults writes 272000 and no rules',
  mutations.length === before + 1
  && reset.ops.find((o) => o.path[0] === 'contextWindow')?.value === 272000
  && JSON.stringify(reset.ops.find((o) => o.path[0] === 'contextWindows')?.value) === '{}', reset)
check('form follows the restored value', input()?.props.value === '272000' && textarea()?.props.value === '', [input()?.props.value, textarea()?.props.value])
check('no render errors after interaction', renderer.errors.length === 0, renderer.errors)

// --- the GPT encrypted-reasoning switch --------------------------------------
log('Replay switch')
// The knob is a span; only the button carries the pxa-switch class.
const switchEl = () => find((el) => el.type === 'button' && hasClass(el, 'pxa-switch'))
const riskShown = () => find((el) => hasClass(el, 'pxa-expand') && hasClass(el, 'open') && textOf(el.props.children).includes(t('replay.desc'))) !== undefined
check('replay card rendered', renderer.text.includes(t('replay.title')))
check('switch defaults off', switchEl()?.props['aria-checked'] === false && !hasClass(switchEl(), 'on'), switchEl()?.props)
check('off: the risk text is not shown', !riskShown() && !renderer.text.includes(t('replay.desc')))
const beforeReplay = mutations.length
await switchEl().props.onClick()
await renderer.settle(page.component, props)
const replayOp = mutations.at(-1)
check('clicking writes openaiReasoningReplay = true in one mutation',
  mutations.length === beforeReplay + 1 && replayOp?.ns === NS && replayOp.ops.length === 1
  && replayOp.ops[0].path[0] === 'openaiReasoningReplay' && replayOp.ops[0].value === true, replayOp)
check('a stored true shows the switch on', switchEl()?.props['aria-checked'] === true && hasClass(switchEl(), 'on'), switchEl()?.props)
check('on: the full risk text unfolds under the row', riskShown())
await switchEl().props.onClick()
await renderer.settle(page.component, props)
check('clicking again writes false and the switch reads off',
  mutations.at(-1)?.ops[0].value === false && switchEl()?.props['aria-checked'] === false, [mutations.at(-1), switchEl()?.props])
check('off again: the risk text folds away', !riskShown())
check('no render errors in the replay card', renderer.errors.length === 0, renderer.errors)

// --- the plugin version row ----------------------------------------------------
log('Update card')
const hostWrites = async (update) => {
  section = { ...section, update: { state: 'idle', message: '', current: '0.2.3', latest: '', target: '', spec: '', checkedAt: 0, servedCheckAt: 0, servedApplyAt: 0, ...update } }
  emit('settings/document-updated')
  await renderer.settle(page.component, props)
}
const lastOp = () => mutations.at(-1)?.ops?.[0]
await hostWrites({})
check('card shows the running version', renderer.text.includes(t('upd.title')) && renderer.text.includes('v0.2.3'), renderer.text.slice(-400))
check('idle: says nothing is checked in the background', renderer.text.includes(t('upd.idle')))
check('idle: no update button', button(t('upd.apply').replace('{version}', '0.2.4')) === undefined)
await click(t('upd.check'))
const checkOp = lastOp()
check('检查更新 bumps updateCheckAt', checkOp?.path?.[0] === 'updateCheckAt' && Number.isFinite(checkOp.value), checkOp)
check('pending check shows progress and disables the button',
  renderer.text.includes(t('upd.checking')) && button(t('upd.check'))?.props.disabled === true)
await hostWrites({ state: 'available', latest: '0.2.4', target: '0.2.4', spec: 'git+https://github.com/PIXEL-AI-API/dsh-pixel-api.git#' + 'a'.repeat(40), checkedAt: Date.now(), servedCheckAt: checkOp.value })
const applyLabel = t('upd.apply').replace('{version}', '0.2.4')
check('available: offers the new version',
  renderer.text.includes(t('upd.available').replace('{version}', '0.2.4')) && button(applyLabel) !== undefined)
check('available: says when it was checked', /\d{2}-\d{2} \d{2}:\d{2} 检查/.test(renderer.text), renderer.text.slice(-300))
const beforeApply = mutations.length
await click(applyLabel)
check('first click only asks for confirmation', mutations.length === beforeApply && button(t('upd.confirm')) !== undefined && button(t('action.cancel')) !== undefined)
check('confirming: explains what happens before the update', renderer.text.includes(t('upd.availableHint')))
await click(t('action.cancel'))
check('cancel returns to the offer without writing', mutations.length === beforeApply && button(applyLabel) !== undefined)
await click(applyLabel)
await click(t('upd.confirm'))
const applyOp = lastOp()
check('confirm bumps updateApplyAt', mutations.length === beforeApply + 1 && applyOp?.path?.[0] === 'updateApplyAt' && Number.isFinite(applyOp.value), applyOp)
check('a sent update shows progress at once', button(t('upd.applying'))?.props.disabled === true)
await hostWrites({ state: 'updating', latest: '0.2.4', target: '0.2.4', servedCheckAt: checkOp.value, servedApplyAt: applyOp.value })
const versionButtons = buttonsIn(rowOf(t('upd.title')))
check('updating: progress shown, every button disabled',
  renderer.text.includes(t('upd.updating').replace('{version}', '0.2.4'))
  && versionButtons.length > 0 && versionButtons.every((b) => b.props.disabled === true), versionButtons.map((b) => textOf(b.props.children)))
await hostWrites({ state: 'unsupported', latest: '0.2.4', message: '这份插件是从本地目录安装的，请在本地仓库更新代码' })
check('unsupported: newest version and the reason, no update button',
  renderer.text.includes('v0.2.4') && renderer.text.includes('本地目录') && button(applyLabel) === undefined)
await hostWrites({ state: 'failed', message: 'pnpm failed（已恢复原版本）' })
check('failed: the reason is shown', renderer.text.includes('pnpm failed（已恢复原版本）'))
await hostWrites({ state: 'updated', current: '0.2.4' })
check('updated: says which version is running', renderer.text.includes(t('upd.updated').replace('{version}', '0.2.4')))
check('no render errors in the update card', renderer.errors.length === 0, renderer.errors)

// --- sign-out ------------------------------------------------------------------
log('Sign-out')
const beforeSignOut = wire.length
await click(t('action.logout'))
check('退出登录 first asks to confirm and writes nothing',
  wire.length === beforeSignOut && renderer.text.includes(t('logout.confirm')) && button(t('action.cancel')) !== undefined)
await click(t('action.cancel'))
check('取消 leaves the session alone',
  wire.length === beforeSignOut && !renderer.text.includes(t('logout.confirm')) && button(t('action.logout')) !== undefined)
await click(t('action.logout'))
await click(t('action.logout'))
const signOutCalls = wire.slice(beforeSignOut)
check('confirming writes signOutAt first, then drops every credential',
  signOutCalls[0]?.kind === 'mutate' && signOutCalls[0].ops[0].path[0] === 'signOutAt'
  && signOutCalls.slice(1).map((c) => `${c.kind}:${c.ref}`).join(',') === `unset:${REFS.password},unset:${REFS.refresh},unset:${REFS.otp}`,
  signOutCalls)
check('signed out: the login card replaces the account view',
  field('username') !== undefined && field('password') !== undefined && button(t('action.logout')) === undefined)
check('signed out: the plugin version row stays', rowOf(t('upd.title')) !== undefined)

// --- the login card --------------------------------------------------------------
log('Login card')
const beforeLogin = wire.length
await submit()
check('empty username and password: each field says so, nothing is written',
  wire.length === beforeLogin && renderer.text.includes(t('err.username')) && renderer.text.includes(t('err.password'))
  && field('username').props['aria-invalid'] === true && field('password').props['aria-invalid'] === true)
check('empty fields: the card shakes', hasClass(loginCard(), 'pxa-shake'))
await endShake()
await type(field('username'), 'alice')
check('typing clears that field\'s error only',
  !renderer.text.includes(t('err.username')) && renderer.text.includes(t('err.password')) && field('username').props['aria-invalid'] === false)
await submit()
check('empty password alone: only its error, nothing written',
  wire.length === beforeLogin && renderer.text.includes(t('err.password')) && !renderer.text.includes(t('err.username')))
await endShake()

await type(field('password'), 'wrong-secret')
await submit()
const loginCalls = wire.slice(beforeLogin)
check('登录 writes the username, then sets the password credential',
  loginCalls.length === 2 && loginCalls[0].kind === 'mutate' && loginCalls[0].ops[0].path[0] === 'username' && loginCalls[0].ops[0].value === 'alice'
  && loginCalls[1].kind === 'set' && loginCalls[1].ref === REFS.password && loginCalls[1].value === 'wrong-secret', loginCalls)
check('password credential configured: 登录中…, button and fields locked',
  button(t('action.loggingIn'))?.props.disabled === true && button(t('action.loggingIn'))?.props['aria-busy'] === true
  && field('username').props.disabled === true && field('password').props.disabled === true)
check('the password leaves the field once the host has it', field('password').props.value === '')
// The host used the password but has not written the outcome yet.
await host({ creds: { [REFS.password]: false } })
check('password used, outcome not written yet: still 登录中…', button(t('action.loggingIn')) !== undefined)
await host({ auth: { state: 'error', message: '用户名或密码错误', user: 'alice' } })
check('a refusal shows the site\'s reason above the button and frees the form',
  messageOpen() && renderer.text.includes('用户名或密码错误')
  && button(t('action.login'))?.props.disabled === false && field('password').props.disabled === false)
check('a refusal after a submission shakes the card', hasClass(loginCard(), 'pxa-shake'))
check('the reason is tied to the password field', typeof field('password').props['aria-describedby'] === 'string')
await endShake()

await type(field('password'), 'wrong-secret')
await submit()
check('a new attempt folds the previous reason away', !messageOpen() && button(t('action.loggingIn')) !== undefined)
// Same refusal again: the host skips writing an unchanged status, so only the
// credential going away tells the attempt ended.
await host({ creds: { [REFS.password]: false } })
check('the same refusal again (status unchanged) still ends the attempt: reason back, card shakes',
  messageOpen() && renderer.text.includes('用户名或密码错误') && hasClass(loginCard(), 'pxa-shake') && button(t('action.login')) !== undefined)
await endShake()
check('no render errors on the login card', renderer.errors.length === 0, renderer.errors)

// --- two-step verification ----------------------------------------------------------
log('Two-step verification')
await type(field('password'), 'right-secret')
await submit()
await host({ creds: { [REFS.password]: false }, auth: { state: '2fa', message: '该账号启用了两步验证，请输入 TOTP 验证码', user: 'alice' } })
check('2FA: the code step takes over the card', otpInput() !== undefined && field('password') === undefined && renderer.text.includes(t('otp.title')))
// The host's 2FA text is a fixed Chinese line; the page's own subtitle is
// localized and names the account.
check('2FA: the localized subtitle names the account, not the host text',
  renderer.text.includes(t('otp.subtitle').replace('{user}', 'alice')) && !renderer.text.includes('该账号启用了两步验证'))
check('2FA: 验证并登录 waits for 6 digits', button(t('action.verify'))?.props.disabled === true)
const beforeOtp = wire.length
await type(otpInput(), '12 34-5')
check('2FA: only digits are kept; 5 digits do not submit', otpInput()?.props.value === '12345' && wire.length === beforeOtp, otpInput()?.props.value)
await type(otpInput(), '12 34-56')
const otpCalls = wire.slice(beforeOtp)
check('2FA: the sixth digit submits the code by itself',
  otpCalls.length === 1 && otpCalls[0].kind === 'set' && otpCalls[0].ref === REFS.otp && otpCalls[0].value === '123456', otpCalls)
check('2FA: code credential configured: 验证中…, input locked',
  button(t('action.verifying'))?.props.disabled === true && otpInput()?.props.disabled === true)
await host({ creds: { [REFS.otp]: false }, auth: { state: 'error', message: '验证码错误', user: 'alice' } })
check('a refused code ends the challenge: back to the password step', field('password') !== undefined && otpInput() === undefined)
check('a refused code reads as a two-step failure', renderer.text.includes(t('err.otpFailed').replace('{reason}', '验证码错误')), renderer.text.slice(0, 300))
check('the username survives the round trip', field('username')?.props.value === 'alice')
await endShake()

// --- a sign-in that succeeds over an old error ----------------------------------------
log('Signing in over an old error')
await type(field('password'), 'right-secret')
await submit()
// Signed in: the host stored the session and dropped the password, but is
// still loading groups, so its status still holds the old error.
await host({ creds: { [REFS.password]: false, [REFS.refresh]: true } })
check('signed in, groups still loading: connecting skeleton, not the disconnected view',
  skeletonShown() && button(t('action.retryNow')) === undefined && field('password') === undefined)
await host({ auth: { ...OK_FIELDS, user: 'alice' } })
check('the host writes ok: the account view, and the status dot pulses once',
  renderer.text.includes(t('status.ok')) && find((el) => hasClass(el, 'pxa-dot') && hasClass(el, 'pulse')) !== undefined)

// --- session kept, site unreachable -------------------------------------------------------
log('Session kept, site unreachable')
await host({ auth: { state: 'error', message: RETRY_TEXT, user: 'alice' } })
check('error with a live session: no login form', field('password') === undefined && button(t('action.login')) === undefined)
check('error with a live session: 连接中断, the host reason and 立即重试',
  renderer.text.includes(t('status.interrupted')) && renderer.text.includes(RETRY_TEXT) && button(t('action.retryNow')) !== undefined)
check('error with a live session: no balance; settings and sign-out stay',
  !renderer.text.includes(t('ok.balance')) && renderer.text.includes(t('ctx.title')) && button(t('action.logout')) !== undefined)
const beforeRetry = mutations.length
await click(t('action.retryNow'))
check('立即重试 bumps refreshAt and spins', mutations.length === beforeRetry + 1 && lastOp()?.path?.[0] === 'refreshAt'
  && button(t('action.retryNow'))?.props['aria-busy'] === true)
await host({ auth: { state: 'error', message: '主站拒绝访问', user: 'alice' } })
check('a new status stops the spinner', button(t('action.retryNow'))?.props['aria-busy'] === false && renderer.text.includes('主站拒绝访问'))
await host({ auth: { state: 'none', message: '' } })
check('no status yet but a live session: connecting skeleton', skeletonShown() && field('password') === undefined)
check('no render errors on the session views', renderer.errors.length === 0, renderer.errors)

// --- opening the page while a sign-in runs ---------------------------------------------
log('Page opened during a sign-in')
renderer = createRenderer()
section = { username: 'alice', contextWindow: 272000, contextWindows: {}, auth: authStatus({ state: 'error', message: '用户名或密码错误', user: 'alice' }) }
creds = { [REFS.password]: true, [REFS.refresh]: false, [REFS.otp]: false }
await settle()
check('password credential configured on open: 登录中…, fields locked, old reason hidden',
  button(t('action.loggingIn'))?.props.disabled === true && field('username')?.props.disabled === true
  && field('password')?.props.disabled === true && !messageOpen())
check('the stored username is filled in', field('username')?.props.value === 'alice')
check('no render errors on a fresh page', renderer.errors.length === 0, renderer.errors)

log(failures === 0 ? 'ALL OK' : `${failures} FAILED`)
if (process.argv[2]) writeFileSync(process.argv[2], lines.join('\n'))
process.exit(failures === 0 ? 0 : 1)
