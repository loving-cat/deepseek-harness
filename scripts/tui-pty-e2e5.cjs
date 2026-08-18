// PTY e2e #5 (phase-1, count-mode): busy spinner + elapsed seconds, follow-up
// queue + Alt+Up recall, /new session, window-title OSC, taskbar progress OSC,
// /bell toggle. Counts text features over the whole buffer (diff rendering
// changes byte layout, so byte-marks are unreliable).
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})
let buf = ''
const started = Date.now()
const count = (re) => (buf.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
const steps = [
  { name: 'boot', need: () => count(/\/help for commands/) >= 1 },
  { name: 'task 1', send: 'Write a 400-word essay about the ocean.\r', delay: 2500 },
  { name: 'busy spinner + progress OSC', need: () => count(/[⠋⠙⠹⠸⠼⠴⦾⦿]/) >= 1 },
  { name: 'elapsed seconds tick', need: () => count(/[⠋⠙⠹⠸⠼⠴⦾⦿] \d+s/) >= 1 },
  // Queued while busy: the input is NOT rendered as a user block yet.
  { name: 'task 2 (queues)', send: 'Now write 400 more words about mountains.\r', delay: 300 },
  { name: 'busy submit queued', need: () => count(/queued \(1\)/) >= 1 },
  // turn/end + pending flush happen in one handler: the queued user block IS the turn-1-end proof.
  { name: 'queued follow-up auto-sent', need: () => count(/❯[\s\S]*400 more words about mountains/) >= 1 },
  // Second queue proves turn 2 is running (only a busy agent parks a follow-up).
  { name: 'queue again', send: 'recall me please\r', delay: 300 },
  { name: 'second queue parked', need: () => count(/queued \(1\)/) >= 2 },
  { name: 'Alt+Up recall', send: '\x1b[1;3A', delay: 300 },
  { name: 'queue recalled into editor', need: () => count(/recalled the queue/) >= 1 },
  { name: 'editor holds recalled text', need: () => count(/dsh > (?:\x1b\[[0-9;]*m)*recall me please/) >= 1 },
  { name: 'clear', send: '\x15', delay: 300 },
  { name: '/new', send: '/new\r', delay: 300 },
  { name: 'fresh session live', need: () => count(/new session →/) >= 1 },
  { name: 'status counts 2 sessions', need: () => count(/⇄ 2 sessions/) >= 1 },
  { name: '/bell', send: '/bell\r', delay: 300 },
  { name: 'bell toggled', need: () => count(/turn-end bell: off/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
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
    if (step.need !== undefined && !step.need()) return
    console.log(`[PTY5] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    stepIndex++
    if (step.send !== undefined) {
      if (step.delay !== undefined) setTimeout(() => child.write(step.send), step.delay)
      else child.write(step.send)
    }
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
