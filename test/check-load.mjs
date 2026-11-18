// Load the packed plugin module inside the host runtime and validate its Config
// against realistic inputs (empty, logged in, legacy). Usage:
//   ELECTRON_RUN_AS_NODE=1 <electron> test/check-load.mjs <package-dir> <out-file>
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [dir, outFile] = process.argv.slice(2)
const out = []
const cell = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v)
try {
  const module = await import(pathToFileURL(join(dir, 'index.js')).href)
  out.push(`loaded name=${module.name} apply=${typeof module.apply} config=${typeof module.Config}`)

  const cases = {
    empty: {},
    loggedIn: {
      username: 'u13123',
      auth: {
        state: 'ok', message: '', user: 'u13123', groups: [], groupCount: 359, models: 95, signOutAt: 0,
        profile: { id: 13123, name: 'u13123', group: 'auto', balance: '¥0.10', used: '¥0.00', requests: 0, updatedAt: 1 },
      },
    },
    legacy: { username: 'u', auth: { state: 'ok', user: 'u', groups: ['a'], models: 9 } },
    controls: { refreshAt: 123, signOutAt: 456, debug: true },
  }
  for (const [label, input] of Object.entries(cases)) {
    const value = module.Config(input)
    const auth = cell(value.auth)
    out.push(`${label}: keys=${Object.keys(value).join(',')} state=${auth.state} groups=${auth.groupCount} balance=${auth.profile.balance} signOutAt=${auth.signOutAt} refreshAt=${cell(value.refreshAt)} debug=${cell(value.debug)}`)
  }
} catch (error) {
  out.push(`ERROR ${error && error.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : error}`)
}
writeFileSync(outFile, out.join('\n'))
process.exit(0)
