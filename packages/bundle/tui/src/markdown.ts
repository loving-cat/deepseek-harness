/**
 * Lightweight terminal markdown renderer: block structure (fenced code,
 * headings, blockquotes, lists, tables) plus inline emphasis, code spans, and
 * links. No dependencies — output is ANSI text that the term module wraps by
 * visible width (CJK-aware).
 *
 * Code fences carry a language (```python …) and each language gets its own
 * keyword set plus comment/string rules; python triple-quoted strings and
 * block comments are tracked across lines by a small closure state machine.
 *
 * @module @deepseek-ai/dsh-tui/markdown
 */

import { ANSI, ansiLength, truncateAnsi, wrapAnsi } from './term.ts'

const BACKTICK = String.fromCharCode(96)

/**
 * Render inline markdown (code, bold, italic, strikethrough, links) to ANSI.
 * When `base` is given (e.g. the dim/gray reasoning style), inline elements
 * restore that base instead of a full reset, so wrapped content stays muted.
 */
export function renderInline(text: string, base = ''): string {
  // Inside a base style, after an inline element restore reset+base (not a
  // plain reset, which would drop the muted styling for the rest of the text).
  const R = base === '' ? ANSI.reset : ANSI.reset + base
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === BACKTICK) {
      const end = text.indexOf(BACKTICK, i + 1)
      if (end === -1) { out += ch; i += 1; continue }
      out += ANSI.cyan + text.slice(i + 1, end) + R
      i = end + 1
    } else if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end === -1) { out += '**'; i += 2; continue }
      out += ANSI.bold + renderInline(text.slice(i + 2, end), base) + R
      i = end + 2
    } else if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end === -1) { out += '~~'; i += 2; continue }
      out += '\x1b[9m' + renderInline(text.slice(i + 2, end), base) + R
      i = end + 2
    } else if (ch === '[') {
      const close = text.indexOf('](', i + 1)
      if (close === -1) { out += ch; i += 1; continue }
      const urlEnd = text.indexOf(')', close + 2)
      if (urlEnd === -1) { out += ch; i += 1; continue }
      out += ANSI.underline + ANSI.blue + renderInline(text.slice(i + 1, close), base) + R
      i = urlEnd + 1
    } else if (ch === '*') {
      const end = text.indexOf('*', i + 1)
      if (end === -1) { out += ch; i += 1; continue }
      out += ANSI.italic + renderInline(text.slice(i + 1, end), base) + R
      i = end + 1
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/** Per-language highlighting rules. */
interface LangSpec {
  keywords: ReadonlySet<string>
  /** Line comment openers, longest first (e.g. ['//'], python/shell ['#'], sql ['--']). */
  lineComments: readonly string[]
  /** Block comment pair (slash-star … star-slash; html uses angle brackets). */
  blockComment?: readonly [string, string]
  /** Python-style ''' / """ strings that may span lines. */
  tripleStrings?: boolean
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'class', 'interface', 'type', 'enum', 'extends',
  'implements', 'import', 'export', 'from', 'async', 'await', 'new', 'delete', 'this',
  'try', 'catch', 'finally', 'throw', 'static', 'readonly', 'public', 'private', 'protected',
  'in', 'of', 'as', 'yield', 'typeof', 'instanceof', 'void', 'get', 'set', 'super',
  'namespace', 'declare', 'abstract', 'override', 'keyof', 'infer', 'satisfies',
  'true', 'false', 'null', 'undefined',
])

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield', 'match', 'case', 'self', 'None', 'True', 'False',
])

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
  'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move',
  'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait',
  'type', 'unsafe', 'use', 'where', 'while', 'box', 'true', 'false',
])

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
  'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
  'return', 'select', 'struct', 'switch', 'type', 'var', 'nil', 'true', 'false', 'iota',
])

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
  'esac', 'function', 'in', 'select', 'echo', 'local', 'export', 'readonly', 'return',
  'exit', 'shift', 'eval', 'exec', 'set', 'unset', 'trap', 'source', 'true', 'false',
])

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'on', 'group', 'by', 'order',
  'having', 'limit', 'offset', 'union', 'all', 'distinct', 'as', 'and', 'or', 'not',
  'null', 'is', 'in', 'like', 'between', 'exists', 'case', 'when', 'then', 'else',
  'end', 'create', 'table', 'alter', 'drop', 'index', 'primary', 'key', 'foreign',
  'references', 'unique', 'default', 'check', 'constraint', 'SELECT', 'FROM', 'WHERE',
])

const C_LIKE_KEYWORDS = new Set([
  'class', 'interface', 'enum', 'extends', 'implements', 'public', 'private', 'protected',
  'static', 'final', 'void', 'int', 'long', 'double', 'float', 'char', 'boolean', 'byte',
  'short', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'this', 'super', 'import',
  'package', 'namespace', 'using', 'readonly', 'const', 'let', 'var', 'func', 'guard',
  'protocol', 'extension', 'abstract', 'sealed', 'override', 'virtual', 'template',
  'typename', 'typedef', 'struct', 'union', 'sizeof', 'true', 'false', 'null', 'nil',
])

const GENERIC_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'class', 'interface', 'type', 'enum', 'extends',
  'implements', 'import', 'export', 'from', 'async', 'await', 'new', 'delete', 'this',
  'try', 'catch', 'finally', 'throw', 'static', 'readonly', 'public', 'private', 'protected',
  'in', 'of', 'as', 'yield', 'def', 'None', 'True', 'False', 'lambda', 'raise', 'with',
  'fn', 'mut', 'match', 'pub', 'use', 'mod', 'impl', 'struct', 'trait', 'where', 'loop',
  'go', 'func', 'package', 'defer', 'chan', 'map', 'range', 'select', 'goto', 'nil',
  'true', 'false', 'null', 'undefined',
])

const BLOCK_SLASH_STAR: readonly [string, string] = ['/*', '*/']

/** Language id (from the code fence) → highlighting rules. */
const LANGS: Record<string, LangSpec> = {
  js: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  jsx: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  mjs: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  cjs: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  javascript: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  ts: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  tsx: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  mts: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  typescript: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  py: { keywords: PY_KEYWORDS, lineComments: ['#'], tripleStrings: true },
  python: { keywords: PY_KEYWORDS, lineComments: ['#'], tripleStrings: true },
  rs: { keywords: RUST_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  rust: { keywords: RUST_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  go: { keywords: GO_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  golang: { keywords: GO_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  sh: { keywords: SH_KEYWORDS, lineComments: ['#'] },
  bash: { keywords: SH_KEYWORDS, lineComments: ['#'] },
  shell: { keywords: SH_KEYWORDS, lineComments: ['#'] },
  zsh: { keywords: SH_KEYWORDS, lineComments: ['#'] },
  sql: { keywords: SQL_KEYWORDS, lineComments: ['--'], blockComment: BLOCK_SLASH_STAR },
  json: { keywords: new Set(['true', 'false', 'null']), lineComments: [] },
  jsonc: { keywords: new Set(['true', 'false', 'null']), lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  yaml: { keywords: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']), lineComments: ['#'] },
  yml: { keywords: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']), lineComments: ['#'] },
  html: { keywords: new Set(), lineComments: [], blockComment: ['<!--', '-->'] },
  xml: { keywords: new Set(), lineComments: [], blockComment: ['<!--', '-->'] },
  vue: { keywords: JS_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  css: { keywords: new Set(), lineComments: [], blockComment: BLOCK_SLASH_STAR },
  scss: { keywords: new Set(), lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  java: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  c: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  h: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  cpp: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  cs: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  csharp: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  kt: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  kotlin: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
  swift: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockComment: BLOCK_SLASH_STAR },
}

const GENERIC_SPEC: LangSpec = { keywords: GENERIC_KEYWORDS, lineComments: ['//', '#'], blockComment: BLOCK_SLASH_STAR }

/** True for the three quote characters (double/single/backtick) via charCode to avoid escaping. */
function isQuote(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return c === 34 || c === 39 || c === 96
}

/** Advance past a string literal starting at `start` (handles backslash escapes via charCode 92). */
function stringEnd(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    if (line.charCodeAt(i) === 92) { i += 2; continue }
    if (line[i] === quote) return i + 1
    i += 1
  }
  return line.length
}

/**
 * Build a stateful line highlighter for one code block of the given language.
 * The closure tracks multi-line block comments and python triple-quoted
 * strings across the lines of its block; unknown languages get generic rules.
 */
export function makeHighlighter(lang: string): (line: string) => string {
  const spec = LANGS[lang.toLowerCase()] ?? GENERIC_SPEC
  let inBlockComment = false
  let tripleQuote = ''
  return (line: string): string => {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (tripleQuote !== '') {
        const end = line.indexOf(tripleQuote, i)
        const stop = end === -1 ? line.length : end + tripleQuote.length
        out += ANSI.green + line.slice(i, stop) + ANSI.reset
        i = stop
        if (end !== -1) tripleQuote = ''
        continue
      }
      if (inBlockComment && spec.blockComment !== undefined) {
        const closer = spec.blockComment[1]
        const end = line.indexOf(closer, i)
        const stop = end === -1 ? line.length : end + closer.length
        out += ANSI.gray + line.slice(i, stop) + ANSI.reset
        i = stop
        if (end !== -1) inBlockComment = false
        continue
      }
      const ch = line[i] ?? ''
      const lineComment = spec.lineComments.find(opener => line.startsWith(opener, i))
      if (lineComment !== undefined) { out += ANSI.gray + line.slice(i) + ANSI.reset; break }
      if (spec.blockComment !== undefined && line.startsWith(spec.blockComment[0], i)) {
        const [opener, closer] = spec.blockComment
        const end = line.indexOf(closer, i + opener.length)
        if (end === -1) { out += ANSI.gray + line.slice(i) + ANSI.reset; inBlockComment = true; break }
        out += ANSI.gray + line.slice(i, end + closer.length) + ANSI.reset
        i = end + closer.length
        continue
      }
      if (spec.tripleStrings === true && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        const quote = line.slice(i, i + 3)
        const end = line.indexOf(quote, i + 3)
        if (end === -1) { out += ANSI.green + line.slice(i) + ANSI.reset; tripleQuote = quote; break }
        out += ANSI.green + line.slice(i, end + 3) + ANSI.reset
        i = end + 3
        continue
      }
      if (isQuote(ch)) {
        const end = stringEnd(line, i, ch)
        out += ANSI.green + line.slice(i, end) + ANSI.reset
        i = end
        continue
      }
      if (ch >= '0' && ch <= '9') {
        const m = /^[0-9][0-9a-zA-Z_.]*/.exec(line.slice(i))
        const tok = m?.[0] ?? ch
        out += ANSI.brightYellow + tok + ANSI.reset
        i += tok.length
        continue
      }
      if (/[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i))
        const word = m?.[0] ?? ch
        out += spec.keywords.has(word) ? ANSI.magenta + word + ANSI.reset : word
        i += word.length
        continue
      }
      out += ch
      i += 1
    }
    return out
  }
}

/** Render one code-block body: dim border, language-aware highlight, no re-flow. */
function renderCodeBlock(body: string[], width: number, lang: string): string[] {
  const inner = Math.max(1, width - 2)
  const bar = '─'.repeat(Math.max(0, inner))
  const highlight = makeHighlighter(lang)
  const out: string[] = [ANSI.dim + '┌' + (lang === '' ? '' : ' ' + lang + ' ') + bar + ANSI.reset]
  for (const line of body) {
    const clipped = line.length > inner ? line.slice(0, inner) : line
    out.push(ANSI.dim + '│' + ANSI.reset + highlight(clipped))
  }
  out.push(ANSI.dim + '└' + bar + ANSI.reset)
  return out
}

/** A table row is mostly `|`s; the delimiter row is only pipes/dashes/colons. */
function isTableDelimiter(line: string): boolean {
  const core = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (core === '') return false
  const cells = core.split('|')
  return cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell))
}

/** Split one table row into trimmed cells (outer pipes dropped). */
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

type Alignment = 'left' | 'right' | 'center'

/** Pad an ANSI-carrying cell to a visible column width per its alignment. */
function padCell(text: string, width: number, align: Alignment): string {
  const visible = ansiLength(text)
  if (visible >= width) return text
  const pad = width - visible
  if (align === 'right') return ' '.repeat(pad) + text
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + text + ' '.repeat(pad - left)
  }
  return text + ' '.repeat(pad)
}

/** Render a GFM table block: aligned columns, dim pipes, clipped to width. */
function renderTable(tableLines: string[], width: number): string[] {
  const header = splitTableRow(tableLines[0] ?? '')
  const delimiter = splitTableRow(tableLines[1] ?? '')
  const cols = Math.max(1, header.length)
  const aligns: Alignment[] = Array.from({ length: cols }, (_, i) => {
    const spec = (delimiter[i] ?? '').trim()
    const left = spec.startsWith(':')
    const right = spec.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
  const rows: string[][] = [header]
  for (const line of tableLines.slice(2)) {
    const cells = splitTableRow(line)
    while (cells.length < cols) cells.push('')
    rows.push(cells.slice(0, cols))
  }
  // Natural widths (capped), then shrink the widest until the frame fits.
  const widths = Array.from({ length: cols }, (_, ci) => {
    let w = 4
    for (const row of rows) w = Math.max(w, Math.min(40, ansiLength(renderInline(row[ci] ?? ''))))
    return w
  })
  const frame = cols + 1 + cols * 2 // pipes + one space of padding on each side
  const budget = Math.max(cols * 4, width - frame)
  const sum = (): number => widths.reduce((a, b) => a + b, 0)
  while (sum() > budget) {
    let widest = 0
    for (let i = 1; i < cols; i += 1) if ((widths[i] ?? 0) > (widths[widest] ?? 0)) widest = i
    if ((widths[widest] ?? 4) <= 4) break
    widths[widest] = (widths[widest] ?? 4) - 1
  }
  const renderRow = (cells: string[], bold: boolean): string => {
    let out = ANSI.dim + '│' + ANSI.reset
    for (let ci = 0; ci < cols; ci += 1) {
      const w = widths[ci] ?? 4
      const rendered = renderInline(cells[ci] ?? '')
      const clipped = ansiLength(rendered) > w ? truncateAnsi(rendered, w) : rendered
      const padded = padCell(clipped, w, aligns[ci] ?? 'left')
      out += ' ' + (bold ? ANSI.bold + padded + ANSI.reset : padded) + ' ' + ANSI.dim + '│' + ANSI.reset
    }
    return out
  }
  const separator = ANSI.dim + '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤' + ANSI.reset
  const out: string[] = [renderRow(header, true), separator]
  for (const row of rows.slice(1)) out.push(renderRow(row, false))
  return out
}

/**
 * Render a markdown string to wrapped, ANSI-styled lines.
 * @param text - the markdown source.
 * @param width - the terminal width to wrap to.
 */
export function renderMarkdown(text: string, width: number): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBody: string[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(...wrapAnsi(renderInline(paragraph.join(' ')), width))
    out.push('')
    paragraph = []
  }

  const flushCode = (): void => {
    if (!inCode) return
    out.push(...renderCodeBlock(codeBody, width, codeLang))
    out.push('')
    inCode = false
    codeLang = ''
    codeBody = []
  }

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] ?? ''
    const fence = new RegExp('^' + BACKTICK + '{3,}(\\S*)').exec(line)
    if (fence !== null) {
      if (inCode) { flushCode() } else { flushParagraph(); inCode = true; codeLang = fence[1] ?? '' }
      continue
    }
    if (inCode) { codeBody.push(line); continue }
    if (line.trim() === '') { flushParagraph(); continue }

    // GFM table: a pipe-carrying line followed by a delimiter row.
    if (line.includes('|') && li + 1 < lines.length && isTableDelimiter(lines[li + 1] ?? '')) {
      flushParagraph()
      const tableLines = [line, lines[li + 1] ?? '']
      li += 2
      while (li < lines.length) {
        const bodyLine = lines[li] ?? ''
        if (bodyLine.trim() === '' || !bodyLine.includes('|')) break
        tableLines.push(bodyLine)
        li += 1
      }
      li -= 1
      out.push(...renderTable(tableLines, width))
      out.push('')
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = (heading[1] ?? '').length
      const text = heading[2] ?? ''
      const style = level <= 2 ? ANSI.bold : ANSI.bold + ANSI.dim
      out.push(...wrapAnsi(style + '#'.repeat(level) + ' ' + renderInline(text) + ANSI.reset, width))
      out.push('')
      continue
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph()
      out.push(ANSI.dim + '─'.repeat(Math.max(1, width - 1)) + ANSI.reset)
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      out.push(...wrapAnsi(ANSI.dim + '│ ' + renderInline(quote[1] ?? '') + ANSI.reset, width))
      continue
    }

    const ul = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (ul !== null) {
      flushParagraph()
      const indent = ' '.repeat((ul[1] ?? '').length)
      out.push(...wrapAnsi(indent + ANSI.brightGreen + '• ' + ANSI.reset + renderInline(ul[2] ?? ''), width))
      continue
    }

    const ol = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line)
    if (ol !== null) {
      flushParagraph()
      const indent = ' '.repeat((ol[1] ?? '').length)
      // number marker green, content in default color (mirrors the bullet list)
      out.push(...wrapAnsi(indent + ANSI.brightGreen + (ol[2] ?? '') + ANSI.reset + ' ' + renderInline(ol[3] ?? ''), width))
      continue
    }

    paragraph.push(line.trim())
  }
  flushParagraph()
  flushCode()
  return out
}
