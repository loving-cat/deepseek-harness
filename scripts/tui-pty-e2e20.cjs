// e2e20: /compact after a couple of real turns — when the engine compacts it
// emits compaction/summary, which the TUI folds as '⎘ context compacted …'
// plus the summary block. (If the engine declines, the notice is absent but
// the command still answers — the summary handling is unit/logic-tested.)
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
  { name: 'task 1', send: 'List the top-level files of this repository, then stop.\r', delay: 2500 },
  { name: 'task 1 idle', need: () => count(/○ idle/) >= 1 },
  { name: 'task 2', send: 'List the packages directory, then stop.\r', delay: 500 },
  { name: 'task 2 idle', need: () => count(/○ idle/) >= 2 },
  { name: 'run /compact', send: '/compact\r', delay: 500 },
  { name: 'compact answers (success or busy)', need: () => count(/compacted|Compaction is unavailable|Compaction could not|Compaction cancelled/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e20-dump.txt', buf)
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
  fs.writeFileSync('D:/tmp/pty-e2e20-dump.txt', buf)
  const all = stepIndex >= steps.length
  const notice = buf.includes('⎘ context compacted')
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} compactNotice=${notice} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
