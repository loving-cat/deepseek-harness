// e2e21: /export writes the session transcript to dsh-export-<id>.md.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')
const path = require('node:path')

const child = pty.spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})

let buf = ''
const started = Date.now()
const count = (re) => (buf.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length
const steps = [
  { name: 'boot frame', need: () => count(/\/help for commands/) >= 1 },
  { name: 'task', send: 'Reply with exactly the single token EXPORT_OK.\r', delay: 2500 },
  { name: 'task answered', need: () => count(/EXPORT_OK/) >= 1 },
  { name: 'run /export', send: '/export\r', delay: 300 },
  { name: 'exported notice', need: () => count(/exported → .*dsh-export-.*\.md/) >= 1 },
  { name: 'exit', send: '\x15/exit\r', delay: 300 },
]
let stepIndex = 0

const killer = setTimeout(() => {
  console.log(`\n[PTY] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e21-dump.txt', buf)
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

child.onData((data) => { buf += data; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e21-dump.txt', buf)
  // Find and verify the exported file, then clean it up.
  const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][0-9;]*/g, '')
  const m = clean.match(/exported → (\S+\.md)/)
  let fileOk = false
  if (m !== null) {
    const f = m[1]
    const full = path.isAbsolute(f) ? f : path.join('D:/deepseek-harness', f)
    try {
      const text = fs.readFileSync(full, 'utf8')
      fileOk = text.includes('EXPORT_OK') && text.includes('## You')
      fs.unlinkSync(full)
    } catch { /* missing file */ }
  }
  const all = stepIndex >= steps.length && fileOk
  console.log(`\n[PTY] exit code=${exitCode} steps=${stepIndex}/${steps.length} fileOk=${fileOk} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(all ? 0 : 1)
}
child.onExit(onExitDone)
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
