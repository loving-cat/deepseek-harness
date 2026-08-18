// e2e11: app-internal mouse text selection — left-drag highlights a box
// (inverse video) over the body window; right-click or Ctrl+C copies it to
// the real clipboard and dismisses the box. SGR coordinates are 1-based
// cols/rows; the boot body row 3 is the yellow system line whose text starts
// 'dsh tui — deepseek-official …' — 'dsh tui — ' is 10 columns, so selecting
// cols 11..27 on row 3 must copy exactly 'deepseek-official'.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})

let buf = ''
const started = Date.now()
const count = (re) => (buf.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
let selBase = 0
const steps = [
  { name: 'boot frame', need: () => count(/\/help for commands/) >= 1 },
  // Press then drag in ONE write: both are send-steps whose delays would
  // otherwise race (the 200ms drag would fire before the 2500ms press).
  { name: 'press+drag row3 col11..27', send: '\x1b[<0;11;3M\x1b[<32;27;3M', delay: 2500 },
  { name: 'selection highlighted', need: () => count(/\x1b\[7m/) >= 1 },
  { name: 'release button', send: '\x1b[<0;27;3m', delay: 200 },
  // Right-click copies the box.
  { name: 'right-click copies', send: '\x1b[<2;27;3M', delay: 300 },
  { name: 'copied selection notice', need: () => count(/copied selection \(/) >= 1, setBase: () => { selBase = count(/\x1b\[7m/) } },
  // Second selection, copied with Ctrl+C instead (must NOT quit — the app
  // stays alive because a live selection makes Ctrl+C a copy, not exit).
  { name: 'press+drag again', send: '\x1b[<0;11;3M\x1b[<32;27;3M', delay: 300 },
  { name: 'selected again', need: () => count(/\x1b\[7m/) > selBase },
  { name: 'Ctrl+C copies selection (no quit)', send: '\x03', delay: 200 },
  { name: 'copied again', need: () => count(/copied selection \(/) >= 2 },
  // App is still alive: a keystroke now must still reach the editor.
  { name: 'still alive - type marker', send: 'hello', delay: 200 },
  { name: 'typed echoed', need: () => count(/dsh > (?:\x1b\[[0-9;]*m)*hello/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e11-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 180000)

function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.need !== undefined && !step.need()) return
    console.log(`[PTY] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    stepIndex++
    if (step.setBase !== undefined) step.setBase()
    if (step.send !== undefined) {
      if (step.delay !== undefined) setTimeout(() => child.write(step.send), step.delay)
      else child.write(step.send)
    }
  }
}

child.onData((data) => { buf += data; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e11-dump.txt', buf)
  const clip = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { timeout: 15000 })
  const clipText = (clip.stdout ?? '').toString().trim()
  const clipOk = clipText === 'deepseek-official'
  const all = stepIndex >= steps.length && clipOk
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} clipboard=${clipOk ? 'deepseek-official ✓' : JSON.stringify(clipText.slice(0, 60))} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
