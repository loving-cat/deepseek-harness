/**
 * Bordered panel renderer for shell tools (bash/pwsh/shell) and the plain-text
 * copy-cleanup helpers shared by selection copy.
 *
 * Every rendered row must fill exactly `width` visible columns: the border
 * characters + interior content = width, never more (a wider row makes the
 * terminal wrap the frame line and shatter the panel). The frame maths below
 * mirrors renderCodeBlock in markdown.ts.
 */
import { ANSI, ansiLength, wrapAnsi } from './term.ts'

/** A shell tool block rendered as a panel (subset of the tool Block shape). */
export interface ShellPanelBlock {
  name: string
  args: string
  summary?: string
}

/** Parse the command out of a shell tool's JSON args (best effort). */
export function shellCommand(args: string): string {
  try {
    const parsed = JSON.parse(args) as { command?: unknown; cwd?: unknown }
    if (typeof parsed.command === 'string') {
      const cwd = typeof parsed.cwd === 'string' ? ' (in ' + parsed.cwd + ')' : ''
      return parsed.command + cwd
    }
  } catch { /* not JSON */ }
  return args.replace(/\s+/g, ' ').trim()
}

/**
 * Render a shell tool block as a bordered panel: command line, then the
 * output (dim, collapsed unless expanded), then a status row.
 */
export function renderShellPanel(block: ShellPanelBlock, width: number, expandTools: boolean): string[] {
  const inner = Math.max(1, width - 2)
  const cmd = shellCommand(block.args)
  const nameLen = ansiLength(block.name)
  // Top frame: '╭ bash ' occupies nameLen + 3 columns, the bar fills the rest.
  const topBar = '─'.repeat(Math.max(0, inner - nameLen - 1))
  const out: string[] = [ANSI.cyan + '╭' + ANSI.reset + ' ' + ANSI.bold + block.name + ANSI.reset + ANSI.dim + ' ' + topBar + ANSI.reset]
  // Command line, soft-wrapped to the terminal width (long env setup lines
  // must not truncate). wrapAnsi already budgets the '$ ' prompt of the first
  // row, so continuation rows must NOT add an extra indent — that would push
  // them past `width` and the terminal would wrap the │ border.
  const cmdLines = wrapAnsi(ANSI.green + '$ ' + ANSI.reset + cmd, inner - 2)
  cmdLines.forEach((line) => {
    out.push(ANSI.cyan + '│' + ANSI.reset + ' ' + line)
  })
  const summary = block.summary
  if (summary !== undefined && summary !== '') {
    const cap = expandTools ? 60 : 8
    // Wrap the output to the inner width; every row carries its own │ so the
    // border never detaches (wrapAnsi on a prefixed blob lost it on wraps).
    for (const line of wrapAnsi(summary, inner).slice(0, cap)) {
      out.push(ANSI.cyan + '│' + ANSI.reset + ' ' + line)
    }
  } else {
    out.push(ANSI.cyan + '│' + ANSI.reset + ' ' + ANSI.dim + '(no output)' + ANSI.reset)
  }
  // Bottom frame: '╰' + bar fills the full width (inner + 1 = width - 1).
  const bottomBar = '─'.repeat(Math.max(0, inner + 1))
  out.push(ANSI.cyan + '╰' + ANSI.reset + ANSI.dim + bottomBar + ANSI.reset)
  return out
}

/** Row prefixes that mark a TUI-drawn frame (bash panels, code blocks, tables). */
const FRAME_OPEN = /^[╭╰┌└├┤┼╞╡]/

/**
 * Whether a workspace root is dangerous for the Windows ACL sandbox: the
 * platform temp root inside it would be rejected (`temp root must be outside
 * the workspace`), or the root is a drive root / user home whose recursive
 * ACL grant needs admin rights and would escape every child (`grantWrite`
 * Win32 5). Such roots need an explicit trust decision rather than an
 * implicit sandbox grant.
 */
export function isDangerousWorkspaceRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = cwd.replace(/[\\/]+$/, '').toLowerCase()
  // Drive roots (D:), user home (C:\Users\XL), and the temp dir itself.
  if (/^[a-z]:$/.test(norm)) return true
  const home = (env.USERPROFILE ?? env.HOME ?? '').replace(/[\\/]+$/, '').toLowerCase()
  if (home !== '' && norm === home) return true
  const temp = (env.TMP ?? env.TEMP ?? '').replace(/[\\/]+$/, '').toLowerCase()
  if (temp !== '' && (norm === temp || norm.startsWith(temp + '\\') || norm.startsWith(temp + '/'))) return true
  return false
}

/**
 * Strip TUI frame characters from a copied row so pasting into another tool
 * yields clean text: content rows lose their leading │ (and one padding
 * space), pure frame rows (╭… ╰… ┌… └… table separators) become empty.
 * Rows whose first visible char is not a border pass through untouched.
 */
export function cleanCopiedLine(line: string): string {
  if (line.startsWith('│') || line.startsWith('╞') || line.startsWith('╡')) {
    return line.replace(/^│ ?/, '')
  }
  if (FRAME_OPEN.test(line)) return ''
  return line
}
