/**
 * Working-directory file walker for '@' path completion. Zero dependencies:
 * a bounded recursive scan (skip-list + basename-level .gitignore rules) that
 * returns posix-style relative paths. The caller caches the result.
 *
 * @module @deepseek-ai/dsh-tui/files
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Directories never worth completing into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'target',
  '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'obj', '.idea', '.vscode',
])

/**
 * Read top-level .gitignore into a basename matcher (best effort: plain names
 * and `*.ext` suffixes only; path-qualified and negation rules are ignored).
 */
function loadGitignore(root: string): (name: string) => boolean {
  let lines: string[]
  try {
    lines = readFileSync(join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
  } catch {
    return () => false
  }
  const exact = new Set(lines.filter(l => !l.includes('*') && !l.includes('/')).map(l => l.replace(/\/$/, '')))
  const suffixes = lines.filter(l => l.startsWith('*.')).map(l => l.slice(1))
  return (name: string) => exact.has(name.replace(/\/$/, '')) || suffixes.some(s => name.endsWith(s))
}

export interface ScanOptions {
  maxDepth?: number
  maxEntries?: number
}

/**
 * Scan `root` for files, returning posix-relative paths sorted ascending.
 * Bounded by maxDepth (default 6) and maxEntries (default 4000); huge repos
 * simply truncate, which still leaves the fuzzy filter useful.
 */
export function scanFiles(root: string, opts: ScanOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? 6
  const maxEntries = opts.maxEntries ?? 4000
  const ignored = loadGitignore(root)
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.github') continue
        if (ignored(entry.name + '/')) continue
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (ignored(entry.name)) continue
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  walk(root, 0)
  return out.sort()
}
