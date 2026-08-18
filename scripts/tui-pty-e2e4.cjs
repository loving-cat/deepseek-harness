// PTY e2e #4: slash-command autocomplete dropdown — open, filter, case-insensitive,
// Tab completes, Enter applies+submits, Esc closes.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})
let buf = ''
let mark = 0
const started = Date.now()
const steps = [
  { name: 'boot', wait: /dsh tui[\s\S]*\/help for commands/, send: '/model' },
  { name: 'dropdown shows /model highlighted', wait: /❯\s*(?:\x1b\[[0-9;]*m)*\/model/, send: '\t' },
  { name: 'tab filled /model + space', wait: /dsh > (?:\x1b\[[0-9;]*m)*\/model /, send: '\r' },
  { name: 'enter runs /model → picker opens', wait: /model provider/, send: '\x1b' },
  { name: 'esc closes the modal menu', wait: /dsh > /, send: '/F' },
  { name: 'uppercase /F → /fork first', wait: /❯\s*(?:\x1b\[[0-9;]*m)*\/fork/, send: '\x1b' },
  { name: 'esc closes dropdown', wait: null, send: null, custom: 'esc' },
  { name: 'dropdown closed', wait: null, send: '\x15', custom: 'escGone' },
  { name: 'cleared, exit', wait: null, send: '/exit\r' },
]
let stepIndex = 0
const killer = setTimeout(() => {
  console.log(`\n[PTY4] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e4-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 240000)

let advancing = false
async function advance() {
  if (advancing) return
  advancing = true
  try {
    while (stepIndex < steps.length) {
      const step = steps[stepIndex]
      if (step.custom === 'esc') {
        // Esc is stashed ~25ms before dispatch; wait then verify no crash and move on.
        await new Promise(r => setTimeout(r, 200))
      } else if (step.custom === 'escGone') {
        await new Promise(r => setTimeout(r, 100))
        const tail = buf.slice(mark)
        // after Esc the latest frame must not carry the fork-highlight row anymore
        const lastFrame = tail.slice(tail.lastIndexOf('dsh tui'))
        if (/❯\s*(?:\x1b\[[0-9;]*m)*\/fork/.test(lastFrame)) return
      } else if (step.wait !== null && !step.wait.test(buf.slice(mark))) {
        return
      }
      console.log(`[PTY4] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      mark = buf.length
      stepIndex++
      if (step.send !== null) child.write(step.send)
    }
  } finally {
    advancing = false
  }
}
child.onData((d) => { buf += d; void advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e4-dump.txt', buf)
  console.log(`\n[PTY4] exit code=${exitCode} steps=${stepIndex}/${steps.length} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(stepIndex >= steps.length ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
void advance()
