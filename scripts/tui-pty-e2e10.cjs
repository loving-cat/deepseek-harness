// e2e10: /model opens an arrow-navigable provider→model picker, /preset opens
// a picker, Esc cancels a modal menu. Runs against the BUILT lib (what the
// user launches). ConPTY rewrites frame addressing, so assertions count
// text features over the whole accumulated buffer (each frame repaints the
// full screen, so every feature repeats once per frame).
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness',
  cols: 100,
  rows: 30,
  env: process.env,
})

let buf = ''
const started = Date.now()
const count = (re) => (buf.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
let prev = {}
/** steps run once; a step with `need` waits until its count exceeds the snapshot. */
const steps = [
  { name: 'boot frame', need: () => count(/\/help for commands/) >= 1 },
  // send steps fire the input; need steps wait for the frame it produces.
  { name: 'send /model', send: '/model\r', delay: 2500 },
  { name: 'provider picker shows', need: () => count(/model provider/) >= 1 },
  { name: 'current provider highlighted', need: () => count(/❯ (?:\x1b\[[0-9;]*m)*deepseek-official/) >= 1 },
  // Enter descends into the second level: the provider's model roster.
  { name: 'Enter into provider', send: '\r', delay: 300 },
  { name: 'model picker 2nd level', need: () => count(/model — deepseek-official/) >= 1 },
  { name: 'current model marked', need: () => count(/\(current\)/) >= 2 },
  // Arrow keys navigate; back up; Enter picks the (current) row.
  { name: 'Down moves highlight', send: '\x1b[B', delay: 150 },
  { name: 'Up moves back', send: '\x1b[A', delay: 150 },
  { name: 'Enter applies model', send: '\r', delay: 300 },
  { name: 'model switch applied', need: () => count(/model → deepseek-official \/ deepseek-v4-pro-0813/) >= 1 },
  // Reopen, descend, Esc cancels at the model level.
  { name: 'reopen /model', send: '/model\r', delay: 300 },
  { name: 'provider picker again', need: () => count(/model provider/) >= 2 },
  { name: 'Enter into provider', send: '\r', delay: 300 },
  { name: 'model picker again', need: () => count(/model — deepseek-official/) >= 2 },
  { name: 'Esc cancels the menu', send: '\x1b', delay: 400 },
  // With the modal gone, /preset must open its own picker.
  { name: 'open /preset menu', send: '/preset\r', delay: 800 },
  { name: 'preset picker shows', need: () => count(/agent preset/) >= 1 },
  { name: 'preset roster listed', need: () => count(/(标准模式|极简模式|创造模式)/) >= 1 },
  { name: 'Enter applies preset', send: '\r', delay: 800 },
  { name: 'preset switch applied', need: () => count(/preset → |the preset is fixed/) >= 1 },
  // /mode shares the same picker machinery with a 'mode' title (the count
  // gates on the bold 'mode' title so stale 'agent preset' frames can't match).
  { name: 'open /mode menu', send: '/mode\r', delay: 300 },
  { name: 'mode menu shows current', need: () => count(/\x1b\[1mmode\x1b\[[0-9;]*m/) >= 1 && count(/标准模式/) >= 1 },
  { name: 'down to PTC', send: '\x1b[B', delay: 150 },
  { name: 'Enter applies PTC', send: '\r', delay: 300 },
  { name: 'mode switch applied', need: () => count(/mode → code — PTC 模式/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 800 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e10-dump.txt', buf)
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

child.onData((data) => {
  buf += data
  advance()
})
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e10-dump.txt', buf)
  const all = stepIndex >= steps.length
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
