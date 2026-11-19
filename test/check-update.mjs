// Host-half check for the self-update (设置 → PIXEL API → 插件更新).
// Real git reads real tags from a local repository; the plugin manager's own
// shipped origin check (dsh-plugin-manager lib/types/install-spec.js) judges
// the update target; a fake plugin manager records calls and plays each
// outcome an update can have. Nothing is installed and nothing leaves the
// machine.
//
//   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/check-update.mjs [out-file]
//   node test/check-update.mjs [out-file]
//
// Needs git on PATH. Exits 1 when a check fails.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const lines = []
let failures = 0
const log = (line) => { lines.push(line); console.log(line) }
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  log(`${ok ? '  ok  ' : '  FAIL'} ${label}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (cond, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

// The plugin manager's own origin check, from the Desktop archive or from a
// resolvable package (file import: the package's exports omit this module).
const runtimeRoot = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules')
const runtimeFile = async (id, file) => {
  try {
    return await import(pathToFileURL(join(runtimeRoot, id, file)).href)
  } catch {
    const dir = dirname(createRequire(import.meta.url).resolve(`${id}/package.json`))
    return import(pathToFileURL(join(dir, file)).href)
  }
}
const { pinnedGitOrigin } = await runtimeFile('@deepseek-ai/dsh-plugin-manager', 'lib/types/install-spec.js')

// ---------------------------------------------------------------------------
// A local repository with real release tags.
const root = mkdtempSync(join(tmpdir(), 'pixel-update-'))
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.invalid',
  GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.invalid',
}
const git = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
  cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const work = join(root, 'work')
mkdirSync(work)
git(['init', '-q'], work)
const commitVersion = (version) => {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'dsh-pixel-api', version }))
  git(['add', 'package.json'], work)
  git(['commit', '-q', '-m', `v${version}`], work)
  return git(['rev-parse', 'HEAD'], work)
}
const c022 = commitVersion('0.2.2')
git(['tag', '-a', 'v0.2.2', '-m', 'v0.2.2'], work)
git(['tag', 'v0.1.0'], work) // lightweight
const c024 = commitVersion('0.2.4')
git(['tag', '-a', 'v0.2.4', '-m', 'v0.2.4'], work)
commitVersion('0.3.0-rc.1')
git(['tag', '-a', 'v0.3.0-rc.1', '-m', 'prerelease'], work) // never offered
const tag022 = git(['rev-parse', 'v0.2.2'], work)
const tag024 = git(['rev-parse', 'v0.2.4'], work)
const bare = join(root, 'repo.git')
git(['clone', '-q', '--bare', work, bare], root)
const repoUrl = pathToFileURL(bare).href
// Where a copy that did not come from Git reads tags (CANONICAL_REPOSITORY).
process.env.PIXEL_API_UPDATE_REPO = repoUrl

// ---------------------------------------------------------------------------
// The plugin as two versions: OWN_VERSION comes from the package.json beside
// index.js, so the "next" version is a copy beside a manifest saying 0.2.4.
const OWN = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version
const nextDir = join(here, '.tmp-update')
rmSync(nextDir, { recursive: true, force: true })
mkdirSync(nextDir)
copyFileSync(join(pluginDir, 'index.js'), join(nextDir, 'index.js'))
writeFileSync(join(nextDir, 'package.json'), JSON.stringify({ name: 'dsh-pixel-api', version: '0.2.4', type: 'module' }))
// Git writes its objects read-only, which Windows refuses to delete; make the
// tree writable first. Cleanup never decides the result.
const forceRemove = (dir) => {
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else chmodSync(full, 0o666)
    }
  }
  try {
    walk(dir)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`  note: could not remove ${dir}: ${error?.code ?? error}`)
  }
}
const finish = () => {
  forceRemove(nextDir)
  forceRemove(root)
  log(failures === 0 ? 'ALL OK' : `${failures} FAILED`)
  if (process.argv[2]) writeFileSync(process.argv[2], lines.join('\n'))
  process.exit(failures === 0 ? 0 : 1)
}
process.on('unhandledRejection', (error) => { log(`  FAIL unhandled rejection :: ${error?.stack ?? error}`); failures += 1 })

let fetchCalls = []
let fetchReply = () => { throw new Error('no network in this check') }
globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url))
  return fetchReply(String(url), init)
}

const current = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
const next = await import(pathToFileURL(join(nextDir, 'index.js')).href)
check(`plugin under test is ${OWN}`, OWN === '0.2.3', OWN)

// ---------------------------------------------------------------------------
const WRITE = Symbol.for('cosmokit.volatile.write')
const read = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
const warnings = []

// One plugin start: the fake config editor commits into the live volatile
// cells and then fires loader/volatile-update, as the loader does.
function boot(module, config, manager) {
  const handlers = []
  const disposers = []
  const writes = []
  const fire = () => { for (const fn of handlers) fn() }
  const ctx = {
    logger: { warn: (...parts) => warnings.push(parts.map(String).join(' ')), info() {}, debug() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on(name, fn) {
      if (name === 'loader/volatile-update') handlers.push(fn)
      return () => {}
    },
    inject() {},
    fiber: { entry: { id: 'pixel-api' } },
    llm: { registerAdapter: () => Object.assign(() => {}, { replace() {} }) },
    get(name) {
      if (name === 'configEditor') {
        return {
          edit: async (_entry, edit) => {
            const raw = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, read(v)]))
            for (const [key, value] of Object.entries(edit(raw))) {
              if (JSON.stringify(value) === JSON.stringify(raw[key]) || typeof config[key]?.[WRITE] !== 'function') continue
              config[key][WRITE](value)
              writes.push({ key, value })
            }
            setTimeout(fire, 0)
          },
        }
      }
      if (name === 'pluginManager') return manager
      if (name === 'credentials') return { resolve: async () => undefined, set: async () => {}, unset: async () => {} }
      return undefined
    },
  }
  module.apply(ctx, config)
  return { writes, fire, dispose: () => { for (const d of disposers) d() } }
}

function fakeManager(bundle) {
  const manager = {
    list: 0,
    updates: [],
    play: async () => { throw new Error('no update expected') },
    async listBundles() {
      manager.list += 1
      return bundle === undefined ? [] : [bundle]
    },
    async updateBundle(name, version, options) {
      manager.updates.push({ name, version, options })
      return manager.play({ name, version, options })
    },
  }
  return manager
}
const gitBundle = (version, source) => ({ name: 'dsh-pixel-api', version, source, update: 'git', installed: true })
const status = (config) => read(config.update)
const ask = async (host, config, field) => {
  const at = Date.now() + Math.floor(Math.random() * 1000)
  config[field][WRITE](at)
  host.fire()
  const served = field === 'updateCheckAt' ? 'servedCheckAt' : 'servedApplyAt'
  await until(() => status(config)[served] === at && status(config).state !== 'checking')
  return at
}

// ---------------------------------------------------------------------------
log('Start-up')
const gitSource = `git+${repoUrl}#${c022}`
const config = current.Config({})
const manager = fakeManager(gitBundle(OWN, gitSource))
const host = boot(current, config, manager)
await until(() => status(config).current === OWN)
check('records the running version', status(config).current === OWN && status(config).state === 'idle', status(config))
check('stays offline: no plugin-manager listing, no fetch', manager.list === 0 && fetchCalls.length === 0)

log('Check')
const checkAt = await ask(host, config, 'updateCheckAt')
let u = status(config)
check('offers v0.2.4; skips the v0.3.0-rc.1 prerelease', u.state === 'available' && u.latest === '0.2.4' && u.target === '0.2.4', u)
check('target is the installed spec with only the commit replaced', u.spec === `git+${repoUrl}#${c024}`, u.spec)
check("plugin manager's own origin check accepts the target",
  pinnedGitOrigin(u.spec) !== undefined && pinnedGitOrigin(u.spec) === pinnedGitOrigin(gitSource),
  [pinnedGitOrigin(u.spec), pinnedGitOrigin(gitSource)])
check('records when it checked', u.checkedAt > 0 && u.servedCheckAt === checkAt, u)
check('a check never starts an update', manager.updates.length === 0)
const listed = manager.list
host.fire()
await sleep(200)
check('a served check is not repeated by later settings commits', manager.list === listed)

log('Update (HMR: the plugin manager removes this copy mid-call)')
let atCall
manager.play = async () => {
  atCall = { ...status(config) }
  host.dispose()
  return { from: OWN, to: '0.2.4', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: u.spec } }
}
const applyAt = Date.now() + 5000
config.updateApplyAt[WRITE](applyAt)
host.fire()
await until(() => manager.updates.length === 1)
await sleep(100)
const call = manager.updates[0]
check('asks the plugin manager for dsh-pixel-api 0.2.4 with the pinned spec',
  call?.name === 'dsh-pixel-api' && call.version === '0.2.4' && call.options.spec === u.spec, call)
check('passes a request id', /^[0-9a-f-]{36}$/.test(String(call?.options?.requestId)), call?.options)
check("'updating' and its served stamp were persisted before the update began",
  atCall?.state === 'updating' && atCall.servedApplyAt === applyAt && atCall.target === '0.2.4', atCall)
const writesAtRemoval = host.writes.length
await sleep(200)
check('the removed copy writes nothing afterwards', host.writes.length === writesAtRemoval)
const carried = status(config)

log('Next start')
const nextConfig = next.Config({ update: carried, updateCheckAt: checkAt, updateApplyAt: applyAt })
const nextManager = fakeManager(gitBundle('0.2.4', `git+${repoUrl}#${c024}`))
const nextHost = boot(next, nextConfig, nextManager)
await until(() => status(nextConfig).state === 'updated')
check('the new version records the finished update',
  status(nextConfig).state === 'updated' && status(nextConfig).current === '0.2.4' && status(nextConfig).spec === '', status(nextConfig))
check('the new version repeats neither the update nor the check', nextManager.updates.length === 0 && nextManager.list === 0)
const latestAt = await ask(nextHost, nextConfig, 'updateCheckAt')
check('a check on the newest version reports it as latest',
  status(nextConfig).state === 'latest' && status(nextConfig).latest === '0.2.4' && status(nextConfig).servedCheckAt === latestAt, status(nextConfig))
nextHost.dispose()

const restoredConfig = current.Config({ update: carried, updateCheckAt: checkAt, updateApplyAt: applyAt })
const restoredHost = boot(current, restoredConfig, fakeManager(gitBundle(OWN, gitSource)))
await until(() => status(restoredConfig).state === 'failed')
check('the old version restored after a failed install reports it',
  status(restoredConfig).state === 'failed' && status(restoredConfig).message.includes(`v${OWN}`), status(restoredConfig))
restoredHost.dispose()

log('Outcomes while this copy keeps running')
const playAlive = async (outcome) => {
  const cfg = current.Config({})
  const mgr = fakeManager(gitBundle(OWN, gitSource))
  const h = boot(current, cfg, mgr)
  await ask(h, cfg, 'updateCheckAt')
  mgr.play = typeof outcome === 'function' ? outcome : async () => outcome
  await ask(h, cfg, 'updateApplyAt')
  await until(() => status(cfg).state !== 'updating')
  h.dispose()
  return { status: status(cfg), mgr }
}
let alive = await playAlive({
  from: OWN, to: '0.2.4', step: 'check',
  result: { changed: false, application: 'failed', stage: 'install', target: 'dsh-pixel-api', error: { code: 'invalid-spec', diagnostic: 'not in the repository directory' } },
})
check('a refusal is reported with its diagnostic', alive.status.state === 'failed' && alive.status.message.includes('not in the repository directory'), alive.status)
alive = await playAlive({
  from: OWN, to: '0.2.4', step: 'install',
  result: { changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'operation-error', diagnostic: 'pnpm failed' } },
  restore: { changed: true, application: 'applied', stage: 'install', target: gitSource },
})
check('a failed install says the old version came back', alive.status.state === 'failed' && alive.status.message.includes('已恢复原版本'), alive.status)
alive = await playAlive({ from: OWN, to: '0.2.4', step: 'install', result: { changed: true, application: 'restart-required', stage: 'install', target: 'x' } })
check('without HMR the update waits for a restart', alive.status.state === 'restart' && alive.status.target === '0.2.4', alive.status)
const afterRestart = next.Config({ update: alive.status, updateApplyAt: alive.status.servedApplyAt, updateCheckAt: alive.status.servedCheckAt })
const restartHost = boot(next, afterRestart, fakeManager(gitBundle('0.2.4', `git+${repoUrl}#${c024}`)))
await until(() => status(afterRestart).state === 'updated')
check('the restart then records the finished update', status(afterRestart).state === 'updated', status(afterRestart))
restartHost.dispose()
alive = await playAlive(async () => { throw new Error('lock timeout') })
check('a rejected call is reported', alive.status.state === 'failed' && alive.status.message.includes('lock timeout'), alive.status)

log('Copies that cannot update here')
const checkOnly = async (bundle, withManager = true) => {
  const cfg = current.Config({})
  const mgr = fakeManager(bundle)
  const h = boot(current, cfg, withManager ? mgr : undefined)
  await ask(h, cfg, 'updateCheckAt')
  h.dispose()
  return { status: status(cfg), mgr }
}
let only = await checkOnly({ name: 'dsh-pixel-api', version: OWN, source: 'link:C:/work/dsh-pixel-api', installed: true })
check('a local link: newest release shown, no update offered',
  only.status.state === 'unsupported' && only.status.latest === '0.2.4' && only.status.spec === '' && only.status.message.includes('本地目录'), only.status)
only = await checkOnly({ name: 'dsh-pixel-api', version: OWN, source: 'dsh-pixel-api@0.2.3', update: 'registry', installed: true })
check('an npm copy is sent to the Plugins page', only.status.state === 'unsupported' && only.status.message.includes('npm'), only.status)
only = await checkOnly({ name: 'dsh-pixel-api', version: OWN, source: `git+${repoUrl}#main`, installed: true })
check('a Git copy not pinned to a commit is refused', only.status.state === 'unsupported' && only.status.message.includes('提交'), only.status)
only = await checkOnly(undefined, false)
check('no plugin manager service', only.status.state === 'unsupported' && only.status.message.includes('插件管理'), only.status)
only = await checkOnly(gitBundle(OWN, `git+${pathToFileURL(join(root, 'missing.git')).href}#${c022}`))
check('an unreachable repository is an error, not an offer', only.status.state === 'error' && only.status.spec === '', only.status)
check('no check or failure ever started an update', only.mgr.updates.length === 0)

log('Smart-HTTP fallback when git cannot run')
const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s
const advert = pkt('# service=git-upload-pack\n') + '0000'
  + pkt(`${c024} HEAD\0multi_ack thin-pack side-band agent=git/2\n`)
  + pkt(`${tag022} refs/tags/v0.2.2\n`) + pkt(`${c022} refs/tags/v0.2.2^{}\n`)
  + pkt(`${tag024} refs/tags/v0.2.4\n`) + pkt(`${c024} refs/tags/v0.2.4^{}\n`)
  + '0000'
fetchCalls = []
fetchReply = () => new Response(advert, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
const httpsSource = `git+https://example.invalid/Acme/dsh-pixel-api.git#${c022}`
const savedPath = process.env.PATH
process.env.PATH = ''
try {
  only = await checkOnly(gitBundle(OWN, httpsSource))
} finally {
  process.env.PATH = savedPath
}
check('reads the advertisement over HTTPS', fetchCalls[0] === 'https://example.invalid/Acme/dsh-pixel-api.git/info/refs?service=git-upload-pack', fetchCalls)
check('offers the peeled commit of v0.2.4, repository path case kept',
  only.status.state === 'available' && only.status.spec === `git+https://example.invalid/Acme/dsh-pixel-api.git#${c024}`, only.status)
check('origin check accepts it', pinnedGitOrigin(only.status.spec) === pinnedGitOrigin(httpsSource))

log('A build newer than every release')
fetchReply = () => { throw new Error('no network in this check') }
const aheadDir = join(here, '.tmp-ahead')
forceRemove(aheadDir)
mkdirSync(aheadDir)
copyFileSync(join(pluginDir, 'index.js'), join(aheadDir, 'index.js'))
writeFileSync(join(aheadDir, 'package.json'), JSON.stringify({ name: 'dsh-pixel-api', version: '0.5.0', type: 'module' }))
const ahead = await import(pathToFileURL(join(aheadDir, 'index.js')).href)
const aheadConfig = ahead.Config({})
const aheadHost = boot(ahead, aheadConfig, fakeManager(gitBundle('0.5.0', gitSource)))
await ask(aheadHost, aheadConfig, 'updateCheckAt')
check('reports the running version as latest, not an older tag',
  status(aheadConfig).state === 'latest' && status(aheadConfig).latest === '0.5.0', status(aheadConfig))
aheadHost.dispose()
forceRemove(aheadDir)

check('no plugin warnings', warnings.length === 0, warnings)
finish()
