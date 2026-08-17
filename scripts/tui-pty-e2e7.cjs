// PTY e2e #7 (phase-2): mouse click on the dropdown, @ file completion,
// /model arg completion (two levels), Ctrl+Z undo, /copy to the clipboard.
const pty = require(require.resolve('node-pty', { paths: [require('node:path').join(__dirname, '../packages/subprocess/subprocess-local')] }))
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'tui'], {
  cwd: 'D:/deepseek-harness', cols: 100, rows: 30, env: process.env,
})
let buf = ''
let mark = 0
const started = Date.now()
const steps = [
  // LLM-independent editor mechanics first (the API is not needed until the last two steps).
  { name: 'boot', wait: /dsh tui[\s\S]*\/help for commands/, send: '/mo' },
  // '/mo' filters to exactly /model: 1 dropdown row + 1 input row → row 29 of 30.
  { name: 'dropdown open', wait: /❯\s*(?:\x1b\[[0-9;]*m)*\/model/, send: '\x1b[<0;3;29M' },
  { name: 'mouse click applied /model ', wait: /dsh > (?:\x1b\[[0-9;]*m)*\/model /, send: 'deepseek-o' },
  { name: 'provider arg offered', wait: /deepseek-official/, send: '\t' },
  { name: 'provider filled', wait: /dsh > (?:\x1b\[[0-9;]*m)*\/model deepseek-official /, send: 'd' },
  { name: 'models filled async', wait: /deepseek-v4/, send: '\x15' },
  { name: 'cleared', wait: null, send: 'look @packa' },
  { name: 'file completion shows package.json', wait: /package\.json/, send: '\t' },
  { name: 'path applied without @', wait: /dsh > (?:\x1b\[[0-9;]*m)*look package\.json /, send: '\x15' },
  { name: 'cleared again', wait: null, send: 'hello world' },
  { name: 'typing done', wait: /dsh > (?:\x1b\[[0-9;]*m)*hello world/, send: '\x1a' },
  { name: 'ctrl+z removes last word', wait: /dsh > (?:\x1b\[[0-9;]*m)*hello\s*$/, send: '\x15', raw: true },
  // LLM-dependent steps (need one successful turn for /copy to have content).
  { name: 'task sent', wait: null, send: 'Reply with exactly the single token COPY_ME_OK and nothing else.\r' },
  { name: 'turn done', wait: /[⠋⠙⠹⠸⠼⠴⦾⦿][\s\S]*?○ idle/, send: '/copy\r' },
  { name: 'reply copied', wait: /copied the last reply/, send: '/exit\r' },
]
let stepIndex = 0
const killer = setTimeout(() => {
  console.log(`\n[PTY7] TIMEOUT at step ${stepIndex} (${steps[stepIndex]?.name ?? 'done'})`)
  fs.writeFileSync('D:/tmp/pty-e2e7-dump.txt', buf)
  try { child.write('\x15/exit\r') } catch {}
  setTimeout(() => process.exit(2), 8000)
}, 300000)

function currentInputLine() {
  const tail = buf.slice(mark)
  const idx = tail.lastIndexOf('dsh > ')
  if (idx === -1) return ''
  return tail.slice(idx).replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, '').split('\n')[0] ?? ''
}

function advance() {
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]
    if (step.raw) {
      // compare against the current input line (trailing padding stripped)
      if (!/dsh > hello\s*$/.test(currentInputLine())) return
    } else if (step.wait !== null && !step.wait.test(buf.slice(mark))) {
      return
    }
    console.log(`[PTY7] step ok: ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    mark = buf.length
    stepIndex++
    if (step.send !== null) child.write(step.send)
  }
}
child.onData((d) => { buf += d; advance() })
const onExitDone = ({ exitCode }) => {
  clearTimeout(killer)
  fs.writeFileSync('D:/tmp/pty-e2e7-dump.txt', buf)
  // Verify the copied text actually reached the Windows clipboard.
  const clip = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { timeout: 15000 })
  const clipText = (clip.stdout ?? '').toString().trim()
  const clipOk = clipText.includes('COPY_ME_OK')
  console.log(`\n[PTY7] exit code=${exitCode} steps=${stepIndex}/${steps.length} clipboard=${clipOk ? 'COPY_ME_OK' : JSON.stringify(clipText.slice(0, 60))} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  process.exit(stepIndex >= steps.length && clipOk ? 0 : 1)
}
child.onExit(onExitDone)
// ConPTY sometimes never fires onExit; once every step is done, close out from a watchdog.
const exitWatchdog = setInterval(() => { if (stepIndex >= steps.length) onExitDone({ exitCode: -1 }) }, 5000)
advance()
