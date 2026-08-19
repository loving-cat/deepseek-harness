// Full-screen e2e through a real PTY (node-pty / ConPTY): boots dsh --profile tui,
// exercises kitty shift+enter input, /help, turn fork, session switch, /exit.
// Each step matches only output produced AFTER the previous step (mark cursor).
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness',
  cols: 100,
  rows: 30,
  env: process.env,
})

let buf = ''
let mark = 0
const started = Date.now()
const ANSI_M = '(?:\\x1b\\[[0-9;]*m)*'
const steps = [
  { name: 'boot frame', wait: /dsh tui[\s\S]*\/help for commands/, send: null },
  // type 'ab', shift+enter (kitty seq), 'cd' → input area must show two rows
  { name: 'shift+enter makes two input rows', wait: null, send: 'ab\x1b[13;2ucd' },
  { name: 'input rows rendered', wait: new RegExp('dsh > ' + ANSI_M + 'ab[\\s\\S]*?cd'), send: '\x15' }, // Ctrl+U clear
  { name: 'task submitted', wait: null, send: 'Reply with exactly the single token TUI_OK and nothing else. Do not call any tools; answer directly.\r' },
  { name: 'turn started', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿]/, send: null },
  { name: 'turn finished', wait: /○ idle/, send: '/help\r' },
  // The help text is ~41 wrapped rows — taller than the 30-row window, so
  // only its tail is visible; assert on the last line, not an early one.
  { name: 'help renders its tail line', wait: /Large pastes collapse/, send: '/fork\r' },
  { name: 'fork turn picker', wait: /fork at a past turn/, send: 'latest\r' },
  { name: 'forked + status shows 2 sessions', wait: /2 sessions[\s\S]*?forked @ latest point/, send: '/sessions\r' },
  { name: 'sessions switcher lists live', wait: /●[\s\S]*\(current\)/, send: '1\r' },
  { name: 'switched to parent', wait: /switched →/, send: '/exit\r' },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)

function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.wait !== null && !step.wait.test(buf.slice(mark))) return
    console.log(`[PTY] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    mark = buf.length
    stepIndex++
    if (step.send !== null) child.write(step.send)
  }
  stepsDone = true
}

// Auto-answer tool-approval prompts and user questions: the model sometimes
// calls tools even for a trivial reply task, and an unanswered modal stalls.
let approveMark = 0
let qMark = 0
let stepsDone = false
child.onData((data) => {
  buf += data
  if (!stepsDone) {
    // A fresh approval modal ('⚠ approve <tool>?') → allow once. The ⚠ is
    // load-bearing: a bare /approve / also matches the /help text ('toggle
    // auto-approve for this session'), which fired a phantom 'y' into the
    // editor — it landed as a queued CHAT message after the fork and stalled
    // the run (the historical '偶发卡 step 6/9' was this, not model whims).
    const atail = buf.slice(approveMark)
    if (/⚠ approve /.test(atail)) {
      approveMark = buf.length
      qMark = buf.length
      setTimeout(() => { try { child.write('y\r') } catch {} }, 300)
    } else {
      // A fresh ask_user_question modal → pick the first option. The label is
      // cyan ('\x1b[36m? …'); a bare '? ' would false-match reasoning text.
      const qtail = buf.slice(qMark)
      if (/\x1b\[36m\? /.test(qtail)) {
        qMark = buf.length
        setTimeout(() => { try { child.write('1\r') } catch {} }, 300)
      }
    }
  }
  advance()
})
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e-dump.txt', buf)
  const all = stepIndex >= steps.length
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
