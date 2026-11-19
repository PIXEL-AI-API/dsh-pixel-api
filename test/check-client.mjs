// Client-half check for the 设置 → PIXEL API context window card. Executes the
// real client.js in a vm with a minimal hook renderer and a fake settings wire,
// then drives the card: render, validation, save, restore defaults.
//   node test/check-client.mjs [out-file]
// Exits 1 when a check fails. Layout and styling still need a look in the app.
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
const FRAGMENT = Symbol('fragment')
const same = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]))
function createRenderer() {
  const nodes = new Map()
  const errors = []
  let instance
  let dirty = false
  let elements = []
  let texts = []
  const nodeFor = (key) => {
    if (!nodes.has(key)) nodes.set(key, { hooks: [], deps: [], pending: [] })
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
    if (el.type === FRAGMENT) { walk(el.props.children, `${path}/f`, effects); return }
    if (typeof el.type === 'function') {
      const { out, pending } = call(el.type, el.props, path)
      effects.push(...pending)
      walk(out, `${path}/${el.type.name}`, effects)
      return
    }
    elements.push(el)
    walk(el.props.children, `${path}/${el.type}`, effects)
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
        node.pending.push(fn)
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
        const effects = []
        const root = call(Component, props, 'root')
        effects.push(...root.pending)
        walk(root.out, 'root/0', effects)
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

const renderer = createRenderer()
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
vm.runInContext(readFileSync(join(here, '..', 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })
check('client.js registers with the module loader', loaders.length === 1)
const exports = loaders[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`no ${name} in this check`)
})

const NS = 'pixel-api'
let section = {
  username: 'tester',
  contextWindow: 272000,
  contextWindows: {},
  auth: {
    state: 'ok', message: '', user: 'tester', groups: [], groupCount: 2, models: 3, signOutAt: 0,
    profile: { id: 7, name: 'tester', group: 'default', balance: '$1.00', used: '$0.01', requests: 3, updatedAt: Date.now() },
  },
}
const mutations = []
const ok = (value) => ({ ok: true, value })
// Like the real wire: a committed mutation announces settings/document-updated.
const listeners = new Map()
const emit = (name) => { for (const fn of listeners.get(name) ?? []) fn() }
const remote = {
  settings: {
    describe: async () => ok({ namespaces: [{ ns: NS, value: section }] }),
    mutate: async (ns, ops) => {
      mutations.push({ ns, ops })
      for (const op of ops) section = { ...section, [op.path[0]]: op.value }
      setTimeout(() => emit('settings/document-updated'), 0)
      return ok(undefined)
    },
  },
  credentials: { describe: async () => ok({}), set: async () => ok(undefined), unset: async () => ok(undefined) },
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
const missing = Object.keys(zh).filter((k) => /^(ctx|err\.ctx|upd)\./.test(k)).filter((k) => !(k in en))
check('every ctx/upd string has an English entry', missing.length === 0, missing)

// --- drive the card ----------------------------------------------------------
const find = (pred) => renderer.elements.find(pred)
const cls = (el) => String(el.props.className || '')
const button = (label) => find((el) => el.type === 'button' && [].concat(el.props.children).join('') === label)
const input = () => find((el) => el.type === 'input' && cls(el).includes('narrow'))
const textarea = () => find((el) => el.type === 'textarea')
const type = async (el, value) => { el.props.onChange({ target: { value } }); await renderer.settle(page.component, props) }
const click = async (label) => { await button(label).props.onClick(); await renderer.settle(page.component, props) }

await renderer.settle(page.component, props)
check('no render errors', renderer.errors.length === 0, renderer.errors)
check('card title rendered', renderer.text.includes(t('ctx.title')))
check('summary shows the default window', /272[,.\s]?000/.test(renderer.text) && renderer.text.includes('0 条单独设置'), renderer.text.slice(0, 400))
check('default input shows 272000', input()?.props.value === '272000', input()?.props.value)
check('save disabled until edited', button(t('ctx.save'))?.props.disabled === true)
check('restore disabled while already default', button(t('ctx.reset'))?.props.disabled === true)

await type(input(), '60000')
await click(t('ctx.save'))
check('window <= 65536 rejected without a write', mutations.length === 0 && renderer.text.includes(t('err.ctx.default')), mutations)

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

// --- the update card ---------------------------------------------------------
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
check('available: offers the new version and explains what happens',
  renderer.text.includes(t('upd.available').replace('{version}', '0.2.4')) && renderer.text.includes(t('upd.availableHint')) && button(applyLabel) !== undefined)
const beforeApply = mutations.length
await click(applyLabel)
check('first click only asks for confirmation', mutations.length === beforeApply && button(t('upd.confirm')) !== undefined && button(t('upd.cancel')) !== undefined)
await click(t('upd.cancel'))
check('cancel returns to the offer without writing', mutations.length === beforeApply && button(applyLabel) !== undefined)
await click(applyLabel)
await click(t('upd.confirm'))
const applyOp = lastOp()
check('confirm bumps updateApplyAt', mutations.length === beforeApply + 1 && applyOp?.path?.[0] === 'updateApplyAt' && Number.isFinite(applyOp.value), applyOp)
await hostWrites({ state: 'updating', latest: '0.2.4', target: '0.2.4', servedCheckAt: checkOp.value, servedApplyAt: applyOp.value })
check('updating: progress shown, every button disabled',
  renderer.text.includes(t('upd.updating').replace('{version}', '0.2.4')) && button(t('upd.check'))?.props.disabled === true)
await hostWrites({ state: 'unsupported', latest: '0.2.4', message: '这份插件是从本地目录安装的，请在本地仓库更新代码' })
check('unsupported: newest version and the reason, no update button',
  renderer.text.includes('v0.2.4') && renderer.text.includes('本地目录') && button(applyLabel) === undefined)
await hostWrites({ state: 'failed', message: 'pnpm failed（已恢复原版本）' })
check('failed: the reason is shown', renderer.text.includes('pnpm failed（已恢复原版本）'))
await hostWrites({ state: 'updated', current: '0.2.4' })
check('updated: says which version is running', renderer.text.includes(t('upd.updated').replace('{version}', '0.2.4')))
check('no render errors in the update card', renderer.errors.length === 0, renderer.errors)

log(failures === 0 ? 'ALL OK' : `${failures} FAILED`)
if (process.argv[2]) writeFileSync(process.argv[2], lines.join('\n'))
process.exit(failures === 0 ? 0 : 1)
