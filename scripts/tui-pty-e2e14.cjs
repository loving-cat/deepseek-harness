// e2e14: Ctrl+F transcript search (open, live filter with match markers and
// n/m counter, Esc closes, editor restored) and the idle Ctrl+C double-press
// protocol (first clears input, second warns, third quits).
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})

let buf = ''
const started = Date.now()
const count = (re) => (buf.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
const steps = [
  { name: 'boot frame', need: () => count(/\/help for commands/) >= 1 },
  { name: 'Ctrl+F opens search', send: '\x06', delay: 2500 },
  { name: 'search prompt shows', need: () => count(/🔍/) >= 1 },
  { name: 'type query', send: 'help', delay: 200 },
  { name: 'match marker + counter', need: () => count(/▍/) >= 1 && count(/1\/1/) >= 1 },
  { name: 'Up wraps', send: '\x1b[A', delay: 200 },
  { name: 'Down wraps', send: '\x1b[B', delay: 200 },
  { name: 'Esc closes search', send: '\x1b', delay: 800 },
  { name: 'type after close (editor restored)', send: 'abc', delay: 1400 }, // must trail the Esc's 800ms + stash flush
  { name: 'editor echoes abc', need: () => count(/dsh > (?:\x1b\[[0-9;]*m)*abc/) >= 1 },
  { name: 'Ctrl+C #1 clears input', send: '\x03', delay: 200 },
  { name: 'cleared notice', need: () => count(/input cleared — Ctrl\+C again to quit/) >= 1 },
  { name: 'Ctrl+C #2 warns', send: '\x03', delay: 300 },
  { name: 'press again notice', need: () => count(/press Ctrl\+C again to quit/) >= 1 },
  { name: 'Ctrl+C #3 quits', send: '\x03', delay: 300 },
  { name: 'exit', need: () => false, send: null, finish: true }, // app should have quit by now
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e14-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 120000)

function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.need !== undefined && !step.need()) return
    console.log(`[PTY] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    stepIndex++
    if (step.send !== undefined) {
      if (step.delay !== undefined) setTimeout(() => child.write(step.send), step.delay)
      else child.write(step.send)
    }
  }
}

child.onData((data) => { buf += data; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e14-dump.txt', buf)
  const all = stepIndex >= steps.length - 1 // the app itself exits on Ctrl+C #3
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all && stepIndex >= steps.length - 1 ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length - 1) onExitDone({ exitCode: -1 }) }, 5000)
advance()
