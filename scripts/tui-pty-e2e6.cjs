// PTY e2e #6 (count-mode): tool-call render → turn done → Ctrl+O expand → usage
// stats. Counts text features over the whole buffer (diff rendering changes
// byte layout, so byte-marks are unreliable).
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
  { name: 'tool task', send: 'Use the pwsh tool to run exactly: echo DSH_TOOL_OK — then reply with the word done.\r', delay: 2500 },
  { name: 'tool call rendered', need: () => count(/╭/) >= 1 },
  { name: 'turn done', need: () => count(/○ idle/) >= 1 },
  { name: 'Ctrl+O expand', send: '\x0f', delay: 300 },
  // Each feature independently (a diff frame does not repeat unchanged rows,
  // so a single ordered [\s\S]* scan over stale frames is unreliable).
  { name: 'usage stats + expanded args + hint', need: () => count(/↑[\d.]+[kM]? ↓[\d.]+[kM]?/) >= 1 && count(/tool output: expanded/) >= 1 && count(/\$ /) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0
const killer = setTimeout(() => {
  console.log(`\n[PTY6] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e6-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)
function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.need !== undefined && !step.need()) return
    console.log(`[PTY6] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
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
  fs.writeFileSync('D:/tmp/pty-e2e6-dump.txt', buf)
  console.log(`\n[PTY6] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(stepIndex >= steps.length ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
