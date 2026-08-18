// e2e19: code-block click-to-copy — a real task with a markdown code block;
// clicking the block's top bar (┌ …⧉) copies its content to the clipboard.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})

let buf = ''
const started = Date.now()
const count = (re) => (buf.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
const steps = [
  { name: 'boot frame', need: () => count(/\/help for commands/) >= 1 },
  { name: 'code task', send: 'Reply with exactly a markdown fenced code block containing: const x = 42 — nothing else.\r', delay: 2500 },
  { name: 'code block rendered', need: () => count(/┌/) >= 1 && count(/const x = 42/) >= 1 },
  { name: 'top bar has copy mark', need: () => count(/⧉/) >= 1 },
  // Click rows until the copy fires (the top bar's screen row depends on the
  // streaming layout; non-bar rows just start/clear a selection harmlessly).
  { name: 'click rows until copied', custom: 'clickRows' },
  { name: 'copied notice', need: () => count(/copied code block/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0
let clickRow = 3

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e19-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 180000)

function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.custom === 'clickRows') {
      if (count(/copied code block/) >= 1) {
        console.log(`[PTY] step ok: click rows until copied (${((Date.now() - started) / 1000).toFixed(1)}s)`)
        stepIndex++
        continue
      }
      if (clickRow > 14) return
      child.write('\x1b[<0;5;' + String(clickRow) + 'M')
      clickRow += 1
      return // click one row per data tick
    }
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
  fs.writeFileSync('D:/tmp/pty-e2e19-dump.txt', buf)
  const clip = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { timeout: 15000 })
  const clipText = (clip.stdout ?? '').toString().trim()
  const clipOk = clipText.includes('const x = 42')
  const all = stepIndex >= steps.length && clipOk
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} clipboard=${clipOk ? 'const x = 42 ✓' : JSON.stringify(clipText.slice(0, 50))} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
