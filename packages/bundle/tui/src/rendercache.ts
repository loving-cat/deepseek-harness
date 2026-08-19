/**
 * Render memoization for long-transcript virtualization (see index.ts
 * `renderFrame`). Keyed by block object identity; a hit requires identical
 * render params AND content version. Entries past the cap evict the oldest
 * (Map insertion order; re-setting a key refreshes its recency).
 *
 * Zero-dependency leaf module so the offline unit suite can import it.
 */

export interface RenderParams {
  /** Terminal columns the lines were wrapped to. */
  width: number
  /** Ctrl+O tool expansion. */
  expand: boolean
  /** Ctrl+T reasoning visibility. */
  reasoning: boolean
  /**
   * Content version of mutable blocks (streaming text / tool args / image
   * count). Settled blocks use 0. A mismatch re-renders and overwrites.
   */
  version: number
}

interface Entry extends RenderParams {
  lines: string[]
}

export class RenderCache {
  private readonly map = new Map<object, Entry>()
  private readonly cap: number

  constructor(cap = 2000) {
    this.cap = Math.max(1, cap)
  }

  get(block: object, params: RenderParams): string[] | undefined {
    const hit = this.map.get(block)
    if (hit === undefined) return undefined
    if (hit.width !== params.width) return undefined
    if (hit.expand !== params.expand) return undefined
    if (hit.reasoning !== params.reasoning) return undefined
    if (hit.version !== params.version) return undefined
    return hit.lines
  }

  set(block: object, params: RenderParams, lines: string[]): void {
    // Re-insert to refresh recency: a streaming block re-set every chunk must
    // not look "old" to the eviction pass.
    if (this.map.has(block)) this.map.delete(block)
    this.map.set(block, { ...params, lines })
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  delete(block: object): void {
    this.map.delete(block)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
