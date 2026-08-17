// PTY e2e #3: Alt+V image paste (real clipboard) + large-paste collapse marker.
// Requires an image already on the clipboard (set by the caller).
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})
let buf = ''
let mark = 0
const started = Date.now()
const bigPaste = Array.from({ length: 12 }, (_, i) => 'pasted line ' + (i + 1)).join('\r\n')
const steps = [
  { name: 'boot', wait: /dsh tui[\s\S]*\/help for commands/, send: '\x1bv' }, // Alt+V
  { name: 'image path inserted', wait: /dsh-clipboard-[0-9a-f-]+\.png/, send: '\x15' }, // Ctrl+U clear
  { name: 'cleared', wait: null, send: '\x1b[200~' + bigPaste + '\x1b[201~' },
  { name: 'large paste collapsed to marker', wait: /\[paste #1 \+12 lines\]/, send: '\r' },
  { name: 'payload submitted (turn runs)', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿][\s\S]*?○ idle/, send: '/exit\r' },
]
let stepIndex = 0
const killer = setTimeout(() => {
  console.log(`\n[PTY3] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e3-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)
function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.wait !== null && !step.wait.test(buf.slice(mark))) return
    console.log(`[PTY3] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    mark = buf.length
    stepIndex++
    if (step.send !== null) child.write(step.send)
  }
}
child.onData((d) => { buf += d; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e3-dump.txt', buf)
  console.log(`\n[PTY3] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(stepIndex >= steps.length ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
