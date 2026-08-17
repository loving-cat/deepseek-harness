// PTY e2e #2: /fork <turn> numeric rewind + invalid turn error.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})
let buf = ''
let mark = 0
const started = Date.now()
const steps = [
  { name: 'boot', wait: /dsh tui[\s\S]*\/help for commands/, send: 'Reply with exactly TUI_OK.\r' },
  { name: 'turn 1 done', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿][\s\S]*?○ idle/, send: 'Again: reply with exactly TUI_OK.\r' },
  { name: 'turn 2 done', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿][\s\S]*?○ idle/, send: '/fork 1\r' },
  { name: 'rewound fork to turn 1', wait: /forked @ turn 1/, send: '/fork 99\r' },
  { name: 'invalid turn reported', wait: /no completed turn 99/, send: '/exit\r' },
]
let stepIndex = 0
const killer = setTimeout(() => {
  console.log(`\n[PTY2] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e2-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)
function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.wait !== null && !step.wait.test(buf.slice(mark))) return
    console.log(`[PTY2] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    mark = buf.length
    stepIndex++
    if (step.send !== null) child.write(step.send)
  }
}
child.onData((d) => { buf += d; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e2-dump.txt', buf)
  console.log(`\n[PTY2] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(stepIndex >= steps.length ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
