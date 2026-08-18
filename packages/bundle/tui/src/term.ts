/**
 * Terminal primitives for the full-screen TUI: ANSI color/style constants,
 * visible-width aware text helpers, and the alternate-screen frame renderer.
 * Zero dependencies — everything here is raw ANSI over the tty streams.
 *
 * @module @deepseek-ai/dsh-tui/term
 */

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
} as const

/** Control sequences used for the alternate screen and cursor. */
const ESC = {
  altEnter: '\x1b[?1049h',
  altLeave: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clear: '\x1b[2J',
} as const

/** Codepoints that occupy two terminal columns. Covers CJK, Hangul, fullwidth forms, and common wide symbols. */
const WIDE_RE = new RegExp(
  '[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf'
  + '\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]',
)

/** Visible column width of a single codepoint (surrogate pairs are treated as one unit by String iteration). */
export function charWidth(ch: string): number {
  if (ch === '\t') return 4
  if (ch === '\n' || ch === '\r') return 0
  return WIDE_RE.test(ch) ? 2 : 1
}

/** Strip ANSI escape sequences (CSI, OSC, APC), returning only the printable payload. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

/** Visible column width of a string that may contain ANSI escapes. */
export function ansiLength(text: string): number {
  let width = 0
  let i = 0
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      // Skip one complete escape sequence (APC … ST, CSI … final, or OSC … BEL).
      if (text[i + 1] === ']') {
        const bel = text.indexOf('\x07', i + 2)
        i = bel === -1 ? text.length : bel + 1
      } else if (text[i + 1] === '_') {
        const st = text.indexOf('\x1b\\', i + 2)
        i = st === -1 ? text.length : st + 2
      } else {
        i += 2
        while (i < text.length && text.charCodeAt(i) < 0x40) i += 1
        i += 1
      }
      continue
    }
    width += charWidth(text[i] ?? '')
    i += 1
  }
  return width
}

/**
 * Wrap an ANSI-carrying string into lines no wider than `width` visible columns.
 * ANSI escapes are treated as zero-width and carried across the break so styling
 * survives wrapping. Hard newlines in the input are preserved.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let current = ''
    let col = 0
    let i = 0
    while (i < raw.length) {
      const code = raw.charCodeAt(i)
      if (code === 0x1b) {
        // Copy the whole escape sequence atomically (APC … ST included).
        let j = i
        if (raw[i + 1] === ']') {
          const bel = raw.indexOf('\x07', i + 2)
          j = bel === -1 ? raw.length - 1 : bel
        } else if (raw[i + 1] === '_') {
          const st = raw.indexOf('\x1b\\', i + 2)
          j = st === -1 ? raw.length - 1 : st + 1
        } else {
          j = i + 2
          while (j < raw.length && raw.charCodeAt(j) < 0x40) j += 1
        }
        const seq = raw.slice(i, j + 1)
        current += seq
        i = j + 1
        continue
      }
      const ch = raw[i] ?? ''
      const w = charWidth(ch)
      if (col + w > width && col > 0) {
        lines.push(current)
        current = ''
        col = 0
      }
      current += ch
      col += w
      i += 1
    }
    lines.push(current)
  }
  return lines
}

/**
 * Wrapped (row, col) of a character offset in text rendered at `width`.
 * Mirrors wrapAnsi's break rule (break when col + w > width and col > 0) and
 * ANSI skipping so the input cursor lands where the wrapped text did.
 */
export function wrappedCursor(text: string, offset: number, width: number): { row: number; col: number } {
  let row = 0
  let col = 0
  let i = 0
  const target = Math.max(0, Math.min(offset, text.length))
  while (i < target) {
    if (text.charCodeAt(i) === 0x1b) {
      if (text[i + 1] === ']') {
        const bel = text.indexOf('\x07', i + 2)
        i = bel === -1 ? text.length : bel + 1
      } else {
        i += 2
        while (i < text.length && text.charCodeAt(i) < 0x40) i += 1
        i += 1
      }
      continue
    }
    const ch = text[i] ?? ''
    if (ch === '\n') { row += 1; col = 0; i += 1; continue }
    const w = charWidth(ch)
    if (width > 0 && col + w > width && col > 0) { row += 1; col = 0 }
    col += w
    i += 1
  }
  return { row, col }
}

/** Truncate an ANSI-carrying string to `width` visible columns, appending an ellipsis when clipped. */
export function truncateAnsi(text: string, width: number): string {
  if (ansiLength(text) <= width) return text
  const target = Math.max(0, width - 1)
  let out = ''
  let col = 0
  let i = 0
  while (i < text.length && col < target) {
    const code = text.charCodeAt(i)
    if (code === 0x1b) {
      let j = i
      if (text[i + 1] === ']') {
        const bel = text.indexOf('\x07', i + 2)
        j = bel === -1 ? text.length - 1 : bel
      } else if (text[i + 1] === '_') {
        const st = text.indexOf('\x1b\\', i + 2)
        j = st === -1 ? text.length - 1 : st + 1
      } else {
        j = i + 2
        while (j < text.length && text.charCodeAt(j) < 0x40) j += 1
      }
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    const ch = text[i] ?? ''
    const w = charWidth(ch)
    if (col + w > target) break
    out += ch
    col += w
    i += 1
  }
  return out + '…'
}

/**
 * Wrap an inverse-video (\x1b[7m / \x1b[27m) pair around the visible column
 * range [startCol, endCol) of an ANSI string. Styling sequences pass through
 * untouched; a wide (CJK) character whose box straddles a boundary is kept
 * whole on the highlight side. Out-of-range columns clamp to the text.
 */
export function inverseRange(text: string, startCol: number, endCol: number): string {
  if (startCol >= endCol || endCol <= 0 || text === '') return text
  const s = Math.max(0, startCol)
  let out = ''
  let col = 0
  let on = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] ?? ''
    if (ch === '\x1b') {
      const m = /^\x1b\[[0-9;:<=>?]*[a-zA-Z]/.exec(text.slice(i))
      if (m?.[0] !== undefined) { out += m[0]; i += m[0].length; continue }
      out += ch; i += 1; continue
    }
    const w = charWidth(ch)
    if (!on && col < endCol && col + w > s) { out += '\x1b[7m'; on = true }
    out += ch
    col += w
    if (on && col >= endCol) { out += '\x1b[27m'; on = false }
    i += 1
  }
  if (on) out += '\x1b[27m'
  return out
}

/**
 * Extract the visible characters in the column range [startCol, endCol) of
 * an ANSI string, dropping all styling. Used to copy a mouse selection.
 */
export function sliceVisible(text: string, startCol: number, endCol: number): string {
  let out = ''
  let col = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] ?? ''
    if (ch === '\x1b') {
      const m = /^\x1b\[[0-9;:<=>?]*[a-zA-Z]/.exec(text.slice(i))
      if (m?.[0] !== undefined) { i += m[0].length; continue }
      i += 1; continue
    }
    const w = charWidth(ch)
    if (col >= startCol && col < endCol) out += ch
    col += w
    i += 1
  }
  return out
}

/** A terminal frame: rendered lines plus where the input cursor should sit. */
export interface Frame {
  /** Complete rendered screen lines (with ANSI), top to bottom. */
  lines: string[]
  /** 1-based row of the input cursor. */
  cursorRow: number
  /** 1-based column of the input cursor. */
  cursorCol: number
}

/** Terminal column count fallback when the tty reports none. */
const FALLBACK_WIDTH = 80
const FALLBACK_HEIGHT = 24

/**
 * Owns the alternate screen buffer and full-frame redraws. Every render is a
 * full clear + repaint (simplest correct approach; streaming is throttled by the
 * caller). Entering swaps to the alternate buffer and hides the cursor; leaving
 * restores both.
 */
export class Term {
  private readonly stdout: NodeJS.WriteStream
  private entered = false
  private resizeListener: (() => void) | undefined
  /** Padded rows of the last render, for the row-diff (undefined = no frame yet). */
  private lastRaw: readonly string[] | undefined

  constructor(stdout: NodeJS.WriteStream = process.stdout) {
    this.stdout = stdout
    // A TUI must never die because the terminal vanished mid-frame (EPIPE on
    // a closed pty must not become an uncaught 'error' event).
    this.stdout.on('error', () => {})
  }

  get width(): number {
    return this.stdout.columns || FALLBACK_WIDTH
  }

  get height(): number {
    return this.stdout.rows || FALLBACK_HEIGHT
  }

  get isTty(): boolean {
    return  this.stdout.isTTY
  }

  /** Enter the alternate screen buffer and hide the cursor. */
  enter(): void {
    if (this.entered) return
    this.entered = true
    this.write(ESC.altEnter + ESC.hideCursor)
    this.resizeListener = (): void => { this.onResize() }
    this.stdout.on('resize', this.resizeListener)
  }

  /** Leave the alternate screen buffer and restore the cursor. */
  leave(): void {
    if (!this.entered) return
    this.entered = false
    if (this.resizeListener !== undefined) this.stdout.off('resize', this.resizeListener)
    this.resizeListener = undefined
    // Clear any terminal progress indicator before handing the screen back.
    this.write('\x1b]9;4;0\x07' + ESC.showCursor + ESC.altLeave)
  }

  /** Set the terminal window/tab title (OSC 0); control bytes are stripped. */
  setTitle(title: string): void {
    this.write('\x1b]0;' + title.replace(/[\x00-\x1f\x7f]/g, '') + '\x07')
  }

  /** Windows-Terminal-style taskbar progress (OSC 9;4): indeterminate on, cleared off. */
  setProgress(active: boolean): void {
    this.write(active ? '\x1b]9;4;3\x07' : '\x1b]9;4;0\x07')
  }

  /** Ring the terminal bell (turn-end notification). */
  bell(): void {
    this.write('\x07')
  }

  /** Raw write to stdout (no newline added); a dead terminal is ignored. */
  write(text: string): void {
    try {
      this.stdout.write(text)
    } catch {
      // EPIPE means the reader is gone — there is nothing left to paint on.
    }
  }

  /**
   * Repaint the screen, writing only the rows whose padded text changed since
   * the previous frame (pi-style row diff). A first frame or a resize (row
   * count change) falls back to a full clear + repaint. Rows are always
   * padded to the full width, so an overwrite never leaves stale tail
   * characters; the caller guarantees every row's styling closes before the
   * padding (wrapAnsi keeps ANSI per line), so an unchanged row below a
   * changed one is not affected by a lingering SGR state.
   */
  render(frame: Frame): void {
    const height = this.height
    const width = this.width
    const lines = frame.lines
    const padded: string[] = []
    for (let r = 0; r < height; r += 1) {
      const text = lines[r] ?? ''
      const visible = ansiLength(text)
      padded.push(visible < width ? text + ' '.repeat(width - visible) : text)
    }
    const out: string[] = []
    const prev = this.lastRaw
    // Compare the UNPADDED lines: two frames whose text differs only by a
    // trailing-space edit (e.g. an autocomplete insertion of a space) pad to
    // identical bytes, and a padded comparison would wrongly skip the write.
    if (prev === undefined || prev.length !== height) {
      out.push(ESC.clear)
      for (let r = 0; r < height; r += 1) out.push('\x1b[' + String(r + 1) + ';1H' + (padded[r] ?? ''))
    } else {
      for (let r = 0; r < height; r += 1) {
        const next = lines[r] ?? ''
        if (next !== prev[r]) out.push('\x1b[' + String(r + 1) + ';1H' + (padded[r] ?? ''))
      }
    }
    this.lastRaw = Array.from({ length: height }, (_, r) => lines[r] ?? '')
    const row = Math.max(1, Math.min(height, frame.cursorRow))
    const col = Math.max(1, Math.min(width, frame.cursorCol))
    out.push(ESC.showCursor + '\x1b[' + String(row) + ';' + String(col) + 'H')
    this.write(out.join(''))
  }

  /** Hook for the caller to react to terminal resize. Overridden by assignment. */
  onResize: () => void = () => {}
}
