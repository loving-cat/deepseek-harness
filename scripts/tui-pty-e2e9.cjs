// e2e9: Shift+Tab cycles reasoning effort (high → max → off → high) and
// /mode opens an arrow-navigable mode picker on a blank session.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Start from a clean effort: a previous run persists reasoningEffort into
// settings.yaml, which would shift the cycle (boot would resume mid-cycle).
const settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml')
try {
  const text = fs.readFileSync(settingsPath, 'utf8').replace(/\n[ \t]*reasoningEffort:.*(?:\n|$)/g, '\n')
  fs.writeFileSync(settingsPath, text)
} catch { /* no settings file — fine */ }

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness',
  cols: 100,
  rows: 30,
  env: process.env,
})

let buf = ''
let mark = 0
const started = Date.now()
const steps = [
  { name: 'boot frame', wait: /\/help for commands/, send: null },
  // Shift+Tab x4: undefined → high → max → off → high (delay: editor negotiates first)
  { name: 'press shift+tab', wait: null, send: '\x1b[Z', delay: 2500 },
  { name: 'effort -> high', wait: /effort → high/, send: null },
  { name: 'press shift+tab', wait: null, send: '\x1b[Z', delay: 800 },
  { name: 'effort -> max', wait: /effort → max/, send: null },
  { name: 'press shift+tab', wait: null, send: '\x1b[Z', delay: 800 },
  { name: 'effort -> off', wait: /effort → off/, send: null },
  { name: 'press shift+tab', wait: null, send: '\x1b[Z', delay: 800 },
  { name: 'effort -> high again', wait: /effort → high/, send: null },
  // /mode: opens the mode picker (current marked); Enter applies the
  // highlighted row; arrows move the highlight to pick a different mode.
  { name: 'mode cmd', wait: null, send: '/mode\r', delay: 800 },
  { name: 'mode menu shows current', wait: /标准模式[\s\S]*\(current\)/, send: null },
  { name: 'Enter applies current (standard)', wait: null, send: '\r', delay: 300 },
  { name: 'mode -> standard', wait: /mode → standard — 标准模式/, send: null },
  { name: 'mode cmd again', wait: null, send: '/mode\r', delay: 300 },
  { name: 'mode menu shows again', wait: /标准模式[\s\S]*\(current\)/, send: null },
  { name: 'down to PTC', wait: null, send: '\x1b[B', delay: 150 },
  { name: 'Enter applies PTC', wait: null, send: '\r', delay: 300 },
  { name: 'mode -> code — PTC 模式', wait: /mode → code — PTC 模式/, send: null },
  { name: 'exit', wait: null, send: '\x15/exit\r', delay: 800 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e9-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 180000)

function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.wait !== null && !step.wait.test(buf.slice(mark))) return
    console.log(`[PTY] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    mark = buf.length
    stepIndex++
    if (step.send !== null) {
      if (step.delay !== undefined) setTimeout(() => child.write(step.send), step.delay)
      else child.write(step.send)
    }
  }
}

child.onData((data) => {
  buf += data
  advance()
})
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e9-dump.txt', buf)
  const all = stepIndex >= steps.length
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
