// e2e12: batch-1 UX additions — /name session naming (shown in /sessions),
// Ctrl+T toggles the reasoning display, Ctrl+P cycles the model, Ctrl+L
// opens the model picker. Runs against the built lib.
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
  // /name names the current session; the label shows in /sessions.
  { name: 'send /name', send: '/name 我的会话\r', delay: 2500 },
  { name: 'session named', need: () => count(/session named → 我的会话/) >= 1 },
  { name: 'open /sessions', send: '/sessions\r', delay: 300 },
  { name: 'named label with star', need: () => count(/✦ (?:\x1b\[[0-9;]*m)*我的会话/) >= 1 },
  { name: 'Esc closes the menu', send: '\x1b', delay: 800 },
  // Ctrl+T toggles the reasoning display.
  { name: 'Ctrl+T hide thinking', send: '\x14', delay: 300 },
  { name: 'thinking hidden', need: () => count(/thinking: hidden \(Ctrl\+T shows\)/) >= 1 },
  { name: 'Ctrl+T show thinking', send: '\x14', delay: 200 },
  { name: 'thinking shown', need: () => count(/thinking: shown \(Ctrl\+T hides\)/) >= 1 },
  // Ctrl+P cycles to the next model in the provider catalog.
  { name: 'Ctrl+P cycle model', send: '\x10', delay: 300 },
  { name: 'model cycled', need: () => count(/model → deepseek-official \//) >= 1 },
  // Ctrl+L opens the model picker menu.
  { name: 'Ctrl+L model picker', send: '\x0c', delay: 300 },
  { name: 'model picker opens', need: () => count(/model provider/) >= 1 },
  { name: 'Esc closes it', send: '\x1b', delay: 800 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e12-dump.txt', buf)
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
  fs.writeFileSync('D:/tmp/pty-e2e12-dump.txt', buf)
  const all = stepIndex >= steps.length
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
