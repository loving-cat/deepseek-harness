// e2e16: sub-agent activity panel — the parent spawns a subagent (subagent
// tool), whose session events fold into a compact '└─ ⚙ #xxxxxx' line under
// the main transcript instead of being silent.
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
  { name: 'subagent task', send: 'Use the subagent tool to spawn ONE child that lists the current directory, waits for its result, then reply with exactly the token DONE_SUBAGENT.\r', delay: 2500 },
  { name: 'subagents panel appears', need: () => count(/╭─ subagents/) >= 1 },
  { name: 'child status line', need: () => count(/⚙ (?:\x1b\[[0-9;]*m)*#/) >= 1 },
  { name: 'child finishes', need: () => count(/turns/) >= 1 },
  { name: 'parent done', need: () => count(/DONE_SUBAGENT/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e16-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)

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
  fs.writeFileSync('D:/tmp/pty-e2e16-dump.txt', buf)
  const all = stepIndex >= steps.length
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
