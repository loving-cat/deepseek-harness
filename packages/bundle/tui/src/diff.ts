/**
 * Render one file edit as a unified diff (context / removed / added) from the
 * tool/result presentation meta { diffs: FileDiff[] }. The harness hands us
 * per-hunk oldText/newText blobs (context duplicated in both); we re-align them
 * with a line diff and color "-" removed / "+" added.
 *
 * @module @deepseek-ai/dsh-tui/diff
 */

import { ANSI, charWidth } from './term.ts'

/** Structural mirror of dsh-tools FileDiff (imported structurally to avoid a new dependency). */
export interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Narrow an opaque tool/result.meta to a diff payload, or undefined. */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const candidate = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(candidate)) return undefined
  const out: FileDiff[] = []
  for (const entry of candidate) {
    if (entry === null || typeof entry !== 'object') return undefined
    const { path, oldText, newText } = entry as Record<string, unknown>
    if (typeof path !== 'string' || typeof newText !== 'string') return undefined
    if (oldText !== null && typeof oldText !== 'string') return undefined
    out.push({ path, oldText, newText })
  }
  return out
}

type DiffOp = { type: 'equal' | 'delete' | 'insert'; line: string }

/**
 * Line-level diff via LCS with a size cap. Diffs arrive as small hunks, so the
 * quadratic DP is bounded; oversized inputs fall back to a naive all-removed /
 * all-added split (still correct, just less readable).
 */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const cap = 400
  if (oldLines.length * newLines.length > cap * cap) {
    return [
      ...oldLines.map((line): DiffOp => ({ type: 'delete', line })),
      ...newLines.map((line): DiffOp => ({ type: 'insert', line })),
    ]
  }
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]
    const below = dp[i + 1]
    if (row === undefined || below === undefined) continue
    for (let j = m - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) row[j] = (below[j + 1] ?? 0) + 1
      else row[j] = Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal', line: oldLines[i] ?? '' })
      i += 1; j += 1
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ type: 'delete', line: oldLines[i] ?? '' })
      i += 1
    } else {
      ops.push({ type: 'insert', line: newLines[j] ?? '' })
      j += 1
    }
  }
  while (i < n) { ops.push({ type: 'delete', line: oldLines[i] ?? '' }); i += 1 }
  while (j < m) { ops.push({ type: 'insert', line: newLines[j] ?? '' }); j += 1 }
  return ops
}

/** Dark color-block backgrounds (pi/GitHub style) for added/removed rows. */
const BG_ADD = '\x1b[48;5;22m' // dark green
const BG_DEL = '\x1b[48;5;52m' // dark red

/** Visible column width of a plain (ANSI-free) line. */
function visibleWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/** Render one file diff to styled lines (code stays verbatim, clipped to width). */
export function renderDiff(diff: FileDiff, width: number): string[] {
  const inner = Math.max(1, width - 2)
  const clip = (s: string): string => (s.length > inner ? s.slice(0, inner) : s)
  const out: string[] = []
  const oldLines = diff.oldText === null ? [] : diff.oldText.split('\n')
  const newLines = diff.newText.split('\n')
  const ops = diffLines(oldLines, newLines)
  const added = ops.filter(op => op.type === 'insert').length
  const removed = ops.filter(op => op.type === 'delete').length
  const header = ANSI.bold + ANSI.cyan + diff.path + ANSI.reset
  let stats = ANSI.dim
  if (added > 0) stats += ' ' + ANSI.brightGreen + '+' + String(added) + ANSI.reset + ANSI.dim
  if (removed > 0) stats += ' ' + ANSI.brightRed + '-' + String(removed) + ANSI.reset + ANSI.dim
  stats += ANSI.reset
  out.push(header + stats)
  for (const op of ops) {
    if (op.type === 'equal') {
      out.push(ANSI.dim + '  ' + clip(op.line) + ANSI.reset)
    } else if (op.type === 'delete') {
      const line = '- ' + clip(op.line)
      // full-row dark red block: background spans the whole line width
      out.push(BG_DEL + ANSI.red + line + ' '.repeat(Math.max(0, inner - visibleWidth(line))) + ANSI.reset)
    } else {
      const line = '+ ' + clip(op.line)
      out.push(BG_ADD + ANSI.green + line + ' '.repeat(Math.max(0, inner - visibleWidth(line))) + ANSI.reset)
    }
  }
  return out
}

/** Render a whole { diffs: [...] } payload, one file after another. */
export function renderDiffs(diffs: FileDiff[], width: number): string[] {
  const out: string[] = []
  for (const diff of diffs) {
    out.push(...renderDiff(diff, width))
    out.push('')
  }
  return out
}
