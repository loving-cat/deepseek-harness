// e2e10: /model picker full flow — provider picker → model roster → arrows →
// apply → reopen → Esc cancel. (/preset and /mode pickers are covered by
// e2e9; chaining three modals in one script proved flaky under count-mode.)
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
  { name: 'send /model', send: '/model\r', delay: 2500 },
  { name: 'provider picker shows', need: () => count(/model provider/) >= 1 },
  { name: 'current provider highlighted', need: () => count(/❯ (?:\x1b\[[0-9;]*m)*deepseek-official/) >= 1 },
  { name: 'Enter into provider', send: '\r', delay: 400 },
  { name: 'model picker 2nd level', need: () => count(/model — deepseek-official/) >= 1 },
  { name: 'current model marked', need: () => count(/\(current\)/) >= 2 },
  { name: 'Down moves highlight', send: '\x1b[B', delay: 200 },
  { name: 'Up moves back', send: '\x1b[A', delay: 200 },
  { name: 'Enter applies model', send: '\r', delay: 400 },
  { name: 'model switch applied', need: () => count(/model → deepseek-official \/ deepseek-v4-pro-0813/) >= 1 },
  { name: 'reopen /model', send: '/model\r', delay: 400 },
  { name: 'provider picker again', need: () => count(/model provider/) >= 2 },
  { name: 'Enter into provider', send: '\r', delay: 400 },
  { name: 'model picker again', need: () => count(/model — deepseek-official/) >= 2 },
  { name: 'Esc cancels the menu', send: '\x1b', delay: 800 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e10-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 180000)

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
  fs.writeFileSync('D:/tmp/pty-e2e10-dump.txt', buf)
  const all = stepIndex >= steps.length
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
