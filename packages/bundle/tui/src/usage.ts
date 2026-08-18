/**
 * Token-usage accumulation and formatting for the status bar. The engine emits
 * per-call TokenUsage on `assistant/message`; the TUI accumulates them per
 * session view (session totals + current-turn totals) without touching the
 * engine. Counts are disjoint upstream: billed input = input + cacheRead +
 * cacheWrite.
 *
 * @module @deepseek-ai/dsh-tui/usage
 */

/** Cumulative token counters for one view (or one turn). */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Structural mirror of llm TokenUsage (kept local to avoid a new import edge). */
export interface TokenUsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** A zeroed counter set. */
export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Fold one per-call usage record into the totals (missing cache fields count as zero). */
export function addUsage(totals: UsageTotals, usage: TokenUsageLike): void {
  totals.input += usage.inputTokens
  totals.output += usage.outputTokens
  totals.cacheRead += usage.cacheReadTokens ?? 0
  totals.cacheWrite += usage.cacheWriteTokens ?? 0
}

/** Billed input: uncached input plus both cache sides (upstream counts are disjoint). */
export function billedInput(totals: UsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite
}

/** Compact token count: 999 → "999", 1200 → "1.2k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/**
 * Status-bar segment for prompt-cache hits: `' · 缓存 45k (84%)'` (percentage
 * of billed input served from cache when `total` is given), or '' when the
 * counter is zero (a first call with no cache reads shows nothing).
 */
export function formatCache(n: number, total?: number): string {
  if (n <= 0) return ''
  const pct = total === undefined || total <= 0 ? '' : ' (' + String(Math.min(100, Math.round((n / total) * 100))) + '%)'
  return ' · 缓存 ' + formatTokens(n) + pct
}
