// PTY e2e #5 (phase-1): busy spinner + elapsed seconds, follow-up queue + Alt+Up
// recall, /new session, window-title OSC, taskbar progress OSC, /bell toggle.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})
let buf = ''
let mark = 0
const started = Date.now()
const steps = [
  { name: 'boot', wait: /dsh tui[\s\S]*\/help for commands/, send: 'Write a 400-word essay about the ocean.\r' },
  { name: 'busy spinner + progress OSC', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿]/, send: null },
  { name: 'elapsed seconds tick', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿] \d+s/, send: 'Now write 400 more words about mountains.\r' },
  { name: 'busy submit queued', wait: /queued \(1\)/, send: null },
  // turn/end + pending flush happen in one handler: the queued user block IS the turn-1-end proof.
  { name: 'queued follow-up auto-sent', wait: /❯[\s\S]*400 more words about mountains/, send: null },
  { name: 'turn 2 running', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿] \d+s/, send: 'recall me please\r' },
  { name: 'second queue parked', wait: /queued \(1\)/, send: '\x1b[1;3A' }, // Alt+Up
  { name: 'queue recalled into editor', wait: /recalled the queue/, send: null },
  { name: 'editor holds recalled text', wait: /dsh > (?:\x1b\[[0-9;]*m)*recall me please/, send: '\x15' },
  { name: 'cleared', wait: null, send: '/new\r' },
  { name: 'fresh session live', wait: /new session →/, send: null },
  { name: 'status counts 2 sessions', wait: /⇄ 2 sessions/, send: '/bell\r' },
  { name: 'bell toggled', wait: /turn-end bell: off/, send: '/exit\r' },
]
let stepIndex = 0
const killer = setTimeout(() => {
  console.log(`\n[PTY5] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e5-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)
function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.wait !== null && !step.wait.test(buf.slice(mark))) return
    console.log(`[PTY5] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    mark = buf.length
    stepIndex++
    if (step.send !== null) child.write(step.send)
  }
}
child.onData((d) => { buf += d; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e5-dump.txt', buf)
  const progressOn = buf.includes('\x1b]9;4;3\x07')
  const progressOff = buf.includes('\x1b]9;4;0\x07')
  console.log(`\n[PTY5] exit code=${exitCode} steps=${stepIndex}/${steps.length} progressOn=${progressOn} progressOff=${progressOff} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(stepIndex >= steps.length && progressOn && progressOff ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
