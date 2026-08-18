/**
 * @deepseek-ai/dsh-tui — full-screen interactive terminal Agent driver.
 * Renders the session stream as markdown (with inline file diffs and a live
 * todo readout) over an alternate-screen buffer, with raw-mode line editing,
 * scrollback, inline approval / user-question prompts, a session resume
 * picker, turn-level fork, and a multi-session switcher. The engine (agent /
 * session / llm / tools / presets) is untouched: this bundle is a
 * presentation layer only.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap, TodoItem } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ANSI, Term, ansiLength, inverseRange, sliceVisible, stripAnsi, truncateAnsi, wrapAnsi, wrappedCursor } from './term.ts'
import { renderInline, renderMarkdown } from './markdown.ts'
import { diffsFromMeta, renderDiffs, type FileDiff } from './diff.ts'
import { readClipboardImage, readClipboardText, writeClipboardText } from './clipboard.ts'
import { addUsage, billedInput, emptyUsage, formatCache, formatTokens, type TokenUsageLike, type UsageTotals } from './usage.ts'
import { scanFiles } from './files.ts'
import { LineEditor, type SuggestItem } from './editor.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'userQuestions', 'llm', 'agentPresets']

/** Plugin config: optional initial task, preset, and resume flag. */
export interface Config {
  task?: string
  preset?: string
  resume?: boolean
}

export const Config: z<Config> = z.object({
  task: z.string(),
  preset: z.string(),
  resume: z.boolean(),
})

const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

/** One rendered transcript entry. */
type Block =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning?: string }
  | { kind: 'tool'; name: string; args: string; callId: string; diffs?: FileDiff[]; summary?: string }
  | { kind: 'system'; text: string }

/** One selectable row of a modal picker menu. */
interface MenuItem {
  value: string
  text: string
}

/** Navigable modal picker state attached to a pending prompt. */
interface PendingMenu {
  title: string
  items: readonly MenuItem[]
  index: number
  footer: string
  /** Multi-select mode: space toggles the highlighted row; Enter submits all checked. */
  multi: boolean
  /** Per-row checked state (multi only; the caller initializes it). */
  checked: boolean[]
}

/** An inline prompt awaiting one line of input (approval / user question / picker). */
interface PendingPrompt {
  label: string
  resolve: (answer: string) => void
  /** Present when the prompt doubles as an arrow-navigable picker menu. */
  menu: PendingMenu | undefined
}

/** A live session's rendered view: the agent handle plus its transcript state. */
interface SessionView {
  agent: Agent
  handle: { dispose(): Promise<void> }
  blocks: Block[]
  busy: boolean
  scroll: number
  todos: TodoItem[]
  openAssistant: AssistantBlock | undefined
  /** Follow-ups typed while the agent was busy; auto-sent oldest-first at turn/end. */
  pending: string[]
  /** Cumulative billed tokens across the whole session. */
  usage: UsageTotals
  /** Billed tokens of the currently running (or last) turn. */
  turnUsage: UsageTotals
  /** Live usage snapshot from the current chunk stream (undefined once settled). */
  streamUsage: TokenUsageLike | undefined
  /** Last step's total input tokens (drives the context-occupancy readout). */
  lastInputTokens: number | undefined
  /** Epoch ms when the current turn started (drives the elapsed readout). */
  turnStartedAt: number | undefined
}

/** Mutable runtime shared between sync event listeners and the async driver. */
interface TuiState {
  /** Live sessions keyed by String(session.id); background views keep updating. */
  views: Map<string, SessionView>
  /** Key of the view the terminal currently renders. */
  current: string | undefined
  quitting: boolean
  selectionRef: ModelSelectionRef | undefined
  presetId: string | undefined
  /** Display name of the active agent preset (for the status bar), undefined until resolved. */
  presetName: string | undefined
  term: Term | undefined
  editor: LineEditor | undefined
  prompt: PendingPrompt | undefined
  /** Non-TTY output sink; set when the plain path takes over rendering. */
  plainOut: { write(chunk: string): unknown } | undefined
  /** Non-TTY incremental emit cursor: block index plus chars already written. */
  plainCursor: { block: number; reasoning: number; text: number }
  /** Busy-spinner repaint timer (100ms) and its frame counter. */
  spinnerTimer: ReturnType<typeof setInterval> | undefined
  spinnerFrame: number
  /** Ctrl+O: render tool args/results in full instead of the 8-line digest. */
  expandTools: boolean
  /** /bell: ring the terminal bell when the current view's turn ends. */
  bell: boolean
  /** Current route's context window, when the adapter discloses it. */
  contextWindow: number | undefined
  /** Screen rows the dropdown currently occupies (1-based, for mouse clicks). */
  suggestRows: { start: number; count: number } | undefined
  /** '@' file-completion cache: mapped items plus its build time (TTL 10s). */
  fileCache: { root: string; at: number; items: readonly SuggestItem[] } | undefined
  /** '/model' second-arg cache: provider → model items (filled asynchronously). */
  modelArgsCache: Map<string, readonly SuggestItem[]>
  /** '/preset' arg cache (filled asynchronously). */
  presetArgsCache: readonly SuggestItem[] | undefined
  /** Sessions whose approvals auto-allow (the user chose 'a' at a prompt). */
  autoApprove: Set<string>
  /**
   * Live activity of sub-agent sessions (children of a view's session, e.g.
   * dispatch_task / subagent tool calls). Keyed by String(session.id); the
   * parent view renders a compact panel from it so multi-agent work is not
   * silent. Not full transcripts — a status line per child.
   */
  subagents: Map<string, SubagentView>
  /** Ctrl+T: whether the assistant's reasoning (thinking) blocks are rendered. */
  showReasoning: boolean
  /** Explicit user names for sessions (/name), keyed by String(session.id). */
  titles: Map<string, string>
  /**
   * Ctrl+F transcript search: query, matched block indexes (oldest first),
   * and the currently focused match. Undefined = search closed. While open
   * the editor's input is the query and Enter jumps to the next match.
   */
  search: { query: string; matches: number[]; current: number } | undefined
  /** Last search query, re-offered on the next Ctrl+F. */
  searchMemory: string
  /** First body line index of each block (kept by renderFrame for jump-to-match). */
  blockStarts: number[]
  /** Epoch ms of the last idle Ctrl+C (double-press quits; single clears input). */
  idleInterruptAt: number | undefined
  /** Current git branch of the workspace (read once at boot; shown in the status bar). */
  gitBranch: string | undefined
  /**
   * Render memoization for long-transcript virtualization: block identity →
   * its wrapped lines for given width/expand/reasoning params. Streaming
   * (open) assistant blocks and search mode bypass it; tool/result mutations
   * and expand/reasoning toggles invalidate the affected/all entries.
   */
  renderCache: Map<Block, { width: number; expand: boolean; reasoning: boolean; lines: string[] }>
  /**
   * App-internal mouse text selection: 0-based screen anchor/focus rows and
   * cols (row 0 = status bar, body starts at row 2). Left-drag sets it, the
   * renderer highlights the box, right-click copies it. Undefined = no box.
   */
  selection: { anchor: { row: number; col: number }; focus: { row: number; col: number } } | undefined
  /** Plain-text body window rows of the last render (selection copy source). */
  bodyText: string[] | undefined
  /** Body rows available in the last render (selection click zone). */
  bodyRows: number | undefined
}

/** Process-facing effects. */
interface TuiIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** Frame-rate throttle state shared by every draw call site. */
interface Throttle {
  last: number
  /** The one pending trailing-edge render, if any. */
  timer: ReturnType<typeof setTimeout> | undefined
}

type AssistantBlock = Extract<Block, { kind: 'assistant' }>
type ToolBlock = Extract<Block, { kind: 'tool' }>

/** Compact live status of one sub-agent session (subagent tool / dispatch_task children). */
interface SubagentView {
  parentId: string
  busy: boolean
  turnStartedAt: number | undefined
  turns: number
  lastTool: string | undefined
  lastOutput: string | undefined
  finished: boolean
}

const PROMPT_LABEL = ANSI.green + 'dsh > ' + ANSI.reset

/** Slash-command catalog powering the editor's autocomplete dropdown. */
const SLASH_COMMANDS: readonly SuggestItem[] = [
  { value: 'help', description: 'show the command help' },
  { value: 'model', description: 'pick the model from a menu — /model <provider> <model> [effort] types it out' },
  { value: 'preset', description: 'pick a preset from a menu — /preset <id> types it out' },
  { value: 'mode', description: 'pick a mode from a menu (标准/PTC/极简/创造) — blank session only' },
  { value: 'fork', description: 'branch this session — /fork [turn] rewinds to that turn' },
  { value: 'new', description: 'start a fresh session alongside this one' },
  { value: 'copy', description: 'copy the last reply to the clipboard (Ctrl+X)' },
  { value: 'name', description: 'name the current session — /name <title> (shown in /sessions)' },
  { value: 'tree', description: 'show the session family tree (fork lineage) and switch' },
  { value: 'export', description: 'write the current session transcript to a markdown file' },
  { value: 'compact', description: 'compact the conversation context (engine command)' },
  { value: 'auto', description: 'toggle auto-approve for this session' },
  { value: 'bell', description: 'toggle the turn-end bell' },
  { value: 'sessions', description: 'switch between live sessions or resume a persisted one' },
  { value: 'exit', description: 'flush the session and quit' },
  { value: 'quit', description: 'alias of /exit' },
]

/**
 * Case-fold a slash command's name (arguments keep their case) and drop
 * trailing space, so /MODEL, '/model ' and '/Model deepseek-v4-pro-0813' all work.
 */
/**
 * Read the workspace's current git branch once at boot (spawnSync is too slow
 * for the per-frame status bar; the branch rarely changes mid-session).
 */
function readGitBranch(cwd: string): string | undefined {
  try {
    const out = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true })
    if (out.status === 0 && out.stdout.trim() !== '') return out.stdout.trim()
  } catch { /* not a git repository */ }
  return undefined
}

function normalizeCommand(text: string): string {
  const trimmed = text.trimEnd()
  if (!trimmed.startsWith('/')) return trimmed
  const space = trimmed.search(/\s/)
  if (space === -1) return trimmed.toLowerCase()
  return trimmed.slice(0, space).toLowerCase() + trimmed.slice(space)
}

/** The view the terminal currently renders (undefined before the agent exists). */
function currentView(state: TuiState): SessionView | undefined {
  if (state.current === undefined) return undefined
  return state.views.get(state.current)
}

/** Register a live session view and make it the current one. */
function addView(state: TuiState, agent: Agent, handle: { dispose(): Promise<void> }): SessionView {
  const view: SessionView = {
    agent, handle, blocks: [], busy: false, scroll: 0, todos: [], openAssistant: undefined,
    pending: [], usage: emptyUsage(), turnUsage: emptyUsage(), streamUsage: undefined,
    lastInputTokens: undefined, turnStartedAt: undefined,
  }
  const key = String(agent.session.id)
  state.views.set(key, view)
  closeSearch(state) // a new current view invalidates any open search's match indexes
  state.current = key
  return view
}

/** Braille spinner frames for the busy indicator. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⦾', '⦿']

/** Start the busy-spinner repaint loop (100ms); no-op when already running. */
function startSpinner(state: TuiState, throttle: Throttle): void {
  if (state.spinnerTimer !== undefined) return
  state.spinnerTimer = setInterval(() => {
    state.spinnerFrame += 1
    if (!state.quitting) draw(state, throttle)
  }, 100)
  // Unref'd: the spinner must never hold the process open on its own.
  state.spinnerTimer.unref()
}

/** Stop the spinner repaint loop. */
function stopSpinner(state: TuiState): void {
  if (state.spinnerTimer === undefined) return
  clearInterval(state.spinnerTimer)
  state.spinnerTimer = undefined
}

/** Refresh the window title from the current view (cwd basename + first user message). */
function updateTitle(state: TuiState): void {
  const term = state.term
  if (term === undefined) return
  const view = currentView(state)
  const cwd = view?.agent.session.header.cwd ?? process.cwd()
  const named = state.titles.get(String(view?.agent.session.id))
  const firstUser = view?.blocks.find(b => b.kind === 'user')
  const first = firstUser === undefined ? '' : (firstUser.text.split('\n')[0] ?? '')
  const label = named ?? first
  const short = label.length > 24 ? label.slice(0, 24) + '…' : label
  term.setTitle('dsh — ' + basename(cwd) + (short === '' ? '' : ' — ' + short))
}

/** Extract a plain-text summary from a tool-result message (defensive). */
function toolResultText(message: unknown): string {
  const m = message as { content?: unknown } | null | undefined
  if (m === null || m === undefined) return ''
  const first: unknown = Array.isArray(m.content) ? m.content[0] : undefined
  const blocks = (first as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

/**
 * Close an open transcript search. A session switch invalidates the search's
 * match indexes (they are block indexes of the OLD view), so every switch
 * point calls this; the query is remembered for the next Ctrl+F.
 */
function closeSearch(state: TuiState): void {
  if (state.search !== undefined) {
    state.searchMemory = state.search.query
    state.search = undefined
  }
  if (state.editor !== undefined) state.editor.suggestEnabled = true
  state.editor?.reset()
}

/** Parse the command out of a shell tool's JSON args (best effort). */
function shellCommand(args: string): string {
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
function renderShellPanel(block: ToolBlock, width: number, expandTools: boolean): string[] {
  const inner = Math.max(1, width - 2)
  const cmd = shellCommand(block.args)
  const bar = '─'.repeat(Math.max(0, inner))
  const out: string[] = [ANSI.cyan + '╭' + ANSI.reset + ' ' + ANSI.bold + block.name + ANSI.reset + ANSI.dim + ' ' + bar + ANSI.reset]
  out.push(ANSI.cyan + '│' + ANSI.reset + ' ' + ANSI.green + '$ ' + ANSI.reset + truncateAnsi(cmd, inner - 2))
  const summary = block.summary
  if (summary !== undefined && summary !== '') {
    const cap = expandTools ? 60 : 8
    out.push(...wrapAnsi(ANSI.dim + '│ ' + summary + ANSI.reset, inner + 1).slice(0, cap))
  } else {
    out.push(ANSI.dim + '│ (no output)' + ANSI.reset)
  }
  out.push(ANSI.cyan + '╰' + ANSI.reset + ANSI.dim + bar + ANSI.reset)
  return out
}

/**
 * Render one block to wrapped, styled lines, memoized by block identity for
 * the given render params. `streaming` (the open assistant block whose text
 * grows every chunk) and search mode bypass the cache — the former because
 * its content changes each frame, the latter because the caller mutates the
 * returned lines with search markers.
 */
function cachedRender(
  state: TuiState, block: Block, width: number,
  expandTools: boolean, showReasoning: boolean, streaming: boolean,
): string[] {
  if (!streaming) {
    const hit = state.renderCache.get(block)
    if (hit !== undefined && hit.width === width && hit.expand === expandTools && hit.reasoning === showReasoning) {
      return hit.lines
    }
  }
  const lines = renderBlock(block, width, expandTools, showReasoning)
  if (!streaming) state.renderCache.set(block, { width, expand: expandTools, reasoning: showReasoning, lines })
  return lines
}

/** Render one block to wrapped, styled lines. */
function renderBlock(block: Block, width: number, expandTools: boolean, showReasoning: boolean): string[] {
  switch (block.kind) {
    case 'user':
      return wrapAnsi(ANSI.bold + ANSI.cyan + '❯ ' + ANSI.reset + renderInline(block.text), width)
    case 'assistant': {
      const out: string[] = []
      if (block.reasoning !== undefined && block.reasoning !== '' && showReasoning) {
        // Muted light-gray italic thinking block (pi style), inline elements
        // restore the gray base instead of dropping it. wrapAnsi soft-wraps
        // and only the FIRST line carries the base prefix; later lines rely on
        // terminal style inheritance, which row-diff rendering cannot
        // guarantee (a rewrapped line is emitted standalone). Re-apply the
        // base prefix to every line so reasoning never falls back to the
        // reply's default color.
        const base = ANSI.gray + ANSI.italic
        const reasoningLines = wrapAnsi(base + renderInline(block.reasoning, base) + ANSI.reset, width)
        reasoningLines.forEach((line, i) => { out.push(i === 0 ? line : base + line) })
        out.push('')
      }
      out.push(...renderMarkdown(block.text, width))
      return out
    }
    case 'tool': {
      // Shell tools render as a panel (command + output), pi-style.
      if (block.name === 'bash' || block.name === 'pwsh' || block.name === 'shell') {
        return renderShellPanel(block, width, expandTools)
      }
      const preview = truncateAnsi(block.args.replace(/\s+/g, ' ').trim(), Math.max(10, width - 4))
      const out = [ANSI.cyan + '● ' + block.name + ANSI.reset + ' ' + ANSI.dim + preview + ANSI.reset]
      if (expandTools && block.args.trim() !== '') {
        out.push(...wrapAnsi(ANSI.dim + block.args + ANSI.reset, width).slice(0, 40))
      }
      if (block.diffs !== undefined && block.diffs.length > 0) out.push(...renderDiffs(block.diffs, width))
      else if (block.summary !== undefined && block.summary !== '') {
        const summaryLines = wrapAnsi(ANSI.dim + (expandTools ? block.summary : truncateAnsi(block.summary, width * 4)) + ANSI.reset, width)
        out.push(...(expandTools ? summaryLines.slice(0, 60) : summaryLines.slice(0, 8)))
      }
      return out
    }
    case 'system':
      return wrapAnsi(ANSI.yellow + block.text + ANSI.reset, width)
  }
}

/** Build the one-line status bar, width-aware: low-priority segments drop off first. */
function buildStatus(state: TuiState, width: number): string {
  const view = currentView(state)
  const selection = state.selectionRef?.current
  const model = selection === undefined ? '(none)' : selection.provider + ' / ' + selection.model + (selection.reasoningEffort === undefined ? '' : ' (' + selection.reasoningEffort + ')')
  let activity: string
  let stats = ''
  if (view !== undefined && view.busy) {
    const spin = SPINNER[state.spinnerFrame % SPINNER.length] ?? '⠋'
    const elapsed = view.turnStartedAt === undefined ? '' : ' ' + String(Math.floor((Date.now() - view.turnStartedAt) / 1000)) + 's'
    const inTok = billedInput(view.turnUsage)
    const tokens = inTok + view.turnUsage.output === 0 ? '' : ' ↑' + formatTokens(inTok) + ' ↓' + formatTokens(view.turnUsage.output)
    const cache = formatCache(view.turnUsage.cacheRead, billedInput(view.turnUsage))
    const queued = view.pending.length === 0 ? '' : ' · +' + String(view.pending.length) + ' queued'
    activity = ANSI.brightYellow + ' ' + spin + elapsed + tokens + cache + queued + ANSI.reset
  } else {
    const inTok = view === undefined ? 0 : billedInput(view.usage)
    const totals = view === undefined || (inTok === 0 && view.usage.output === 0) ? '' : ' · ↑' + formatTokens(inTok) + ' ↓' + formatTokens(view.usage.output)
    const cache = view === undefined ? '' : formatCache(view.usage.cacheRead, billedInput(view.usage))
    const window = state.contextWindow
    const total = view === undefined ? 0 : billedInput(view.usage)
    // Cumulative billed input over the window (a long conversation must grow
    // past a single step's share); lastInputTokens stayed at ~1% forever.
    const ctxPct = window === undefined || window <= 0 || total <= 0 ? '' : ' · ' + String(Math.min(999, Math.round((total / window) * 100))) + '% ctx'
    activity = ANSI.dim + ' ○ idle' + ANSI.reset
    stats = totals + cache + ctxPct
  }
  const auto = state.current !== undefined && state.autoApprove.has(state.current) ? ' · ' + ANSI.brightGreen + 'auto' + ANSI.reset : ''
  const todos = view === undefined || view.todos.length === 0 ? '' : ' · ' + ANSI.brightMagenta + '☑ ' + String(view.todos.filter(t => t.status === 'completed').length) + '/' + String(view.todos.length) + ANSI.reset
  const sessions = state.views.size > 1 ? ' · ' + ANSI.dim + '⇄ ' + String(state.views.size) + ' sessions' + ANSI.reset : ''
  const preset = state.presetId === undefined ? '' : ' · ' + ANSI.brightCyan + (state.presetName ?? state.presetId) + ANSI.reset
  const branch = state.gitBranch === undefined ? '' : ' · ' + ANSI.cyan + state.gitBranch + ANSI.reset
  // Greedily keep segments by priority: activity > sessions > todos > stats > preset > branch.
  let out = ANSI.bold + 'dsh tui' + ANSI.reset + ' ' + ANSI.dim + model + ANSI.reset + ' ' + activity
  for (const seg of [sessions, auto, todos, stats === '' ? '' : ANSI.dim + stats + ANSI.reset, preset, branch]) {
    if (seg !== '' && ansiLength(out + seg) <= width) out += seg
  }
  return out
}

/** Assemble the full screen frame. */
function renderFrame(state: TuiState): { lines: string[]; cursorRow: number; cursorCol: number } {
  const term = state.term
  if (term === undefined) return { lines: [], cursorRow: 1, cursorCol: 1 }
  const width = term.width
  const height = term.height
  const view = currentView(state)
  const body: string[] = []
  const blockStarts: number[] = []
  const search = state.search
  const blocks = view?.blocks ?? []
  for (let bi = 0; bi < blocks.length; bi += 1) {
    const block = blocks[bi]
    if (block === undefined) continue
    blockStarts.push(body.length)
    // Long-transcript virtualization: settled blocks render once and reuse
    // their wrapped lines; the open streaming block and search mode render
    // fresh (the former changes every chunk, the latter needs mutable rows).
    const streaming = view !== undefined && view.openAssistant === block
    const rendered = search !== undefined
      ? renderBlock(block, width, state.expandTools, state.showReasoning)
      : cachedRender(state, block, width, state.expandTools, state.showReasoning, streaming)
    // Search hits get a gutter marker; the focused one is bright and bold.
    if (search !== undefined && search.query !== '' && search.matches.includes(bi)) {
      const marker = bi === search.matches[search.current]
        ? ANSI.brightCyan + ANSI.bold + '▍' + ANSI.reset
        : ANSI.dim + '·' + ANSI.reset
      rendered[0] = marker + ' ' + (rendered[0] ?? '')
    }
    body.push(...rendered)
    body.push('')
  }
  state.blockStarts = blockStarts
  // Sub-agent activity panel: one compact line per live/recent child, folded
  // after the transcript so multi-agent work (subagent tool, dispatch_task)
  // is visible without cluttering the main blocks.
  const currentKey = state.current
  const subLines: string[] = []
  for (const [id, sv] of state.subagents) {
    // Only children of the current view's session are shown here.
    if (sv.parentId !== currentKey) continue
    if (!sv.busy && sv.turns === 0 && sv.lastTool === undefined) continue
    const spin = sv.busy ? (SPINNER[state.spinnerFrame % SPINNER.length] ?? '⠋') : (sv.finished ? '✓' : '○')
    const elapsed = sv.busy && sv.turnStartedAt !== undefined ? ' ' + String(Math.floor((Date.now() - sv.turnStartedAt) / 1000)) + 's' : ''
    const tool = sv.lastTool === undefined ? '' : ' ' + ANSI.cyan + sv.lastTool + ANSI.reset
    const out = sv.lastOutput === undefined || sv.lastOutput === '' ? '' : ' ' + ANSI.dim + truncateAnsi(sv.lastOutput.replace(/\s+/g, ' ').trim(), 48) + ANSI.reset
    subLines.push(ANSI.dim + '└─ ⚙ ' + ANSI.reset + '#' + id.slice(-6) + (sv.busy ? ANSI.brightYellow + ' ' + spin + elapsed + ANSI.reset : ANSI.dim + ' ' + spin + ' ' + String(sv.turns) + ' turns' + ANSI.reset) + tool + out)
  }
  if (subLines.length > 0) {
    body.push(ANSI.dim + '╭─ subagents ' + '─'.repeat(Math.max(4, Math.min(24, width - 14))) + ANSI.reset)
    body.push(...subLines)
    body.push(ANSI.dim + '╰' + '─'.repeat(Math.max(2, Math.min(26, width - 2))) + ANSI.reset)
  }
  const editor = state.editor
  const label = state.prompt !== undefined ? state.prompt.label
    : search !== undefined
      ? ANSI.brightYellow + '🔍 ' + ANSI.reset
        + (search.matches.length === 0 && search.query !== '' ? ANSI.dim + '(no matches) ' + ANSI.reset : '')
        + (search.matches.length === 0 ? '' : ANSI.dim + String(search.current + 1) + '/' + String(search.matches.length) + ' ' + ANSI.reset)
      : PROMPT_LABEL
  const value = editor === undefined ? '' : editor.value
  // Input area: prompt label + editor value, soft-wrapped to the terminal width
  // (wrapAnsi keeps hard newlines and breaks long lines at `width`).
  const inputText = label + value
  const inputLines = wrapAnsi(inputText, width)
  // Slash-command autocomplete dropdown, rendered directly above the input.
  const suggest = state.prompt === undefined ? editor?.suggest : undefined
  const suggestLines: string[] = []
  if (suggest !== undefined) {
    const maxRows = Math.min(7, suggest.items.length)
    for (let i = 0; i < maxRows; i += 1) {
      const item = suggest.items[i]
      if (item === undefined) continue
      const name = '/' + item.value
      const desc = item.description === undefined ? '' : ' ' + ANSI.dim + item.description + ANSI.reset
      suggestLines.push(i === suggest.index
        ? ANSI.brightCyan + '❯ ' + ANSI.bold + name + ANSI.reset + desc
        : '  ' + ANSI.dim + name + ANSI.reset + desc)
    }
  }
  const bottomRows = suggestLines.length + inputLines.length
  // Remember where the dropdown sits on screen so mouse clicks can map to rows.
  state.suggestRows = suggestLines.length === 0
    ? undefined
    : { start: height - bottomRows + 1, count: suggestLines.length }
  const statusRows = 2
  const avail = Math.max(1, height - statusRows - bottomRows)
  const scroll = view?.scroll ?? 0
  const bodyStart = Math.max(0, body.length - avail - scroll)
  const window = body.slice(bodyStart, bodyStart + avail)
  // Selection copy source: plain text of the rendered body window.
  state.bodyText = window.map(stripAnsi)
  state.bodyRows = avail
  // Normalize the mouse-selection box (0-based screen rows; body starts at 2).
  const sel = state.selection
  const box = sel === undefined ? undefined : {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  }
  const lines: string[] = [truncateAnsi(buildStatus(state, width), width), ANSI.dim + '─'.repeat(Math.max(1, width - 1)) + ANSI.reset]
  for (let i = 0; i < window.length; i += 1) {
    const line = window[i] ?? ''
    // Window row i renders at 0-based screen row statusRows + i (2).
    if (box !== undefined && statusRows + i >= box.top && statusRows + i <= box.bottom) {
      let c1 = box.left
      let c2 = Number.MAX_SAFE_INTEGER
      const single = box.top === box.bottom
      // box.right is inclusive (the last selected column); the range helpers
      // take an exclusive end, so add one.
      if (single) c2 = box.right + 1
      else if (statusRows + i === box.top) c2 = Number.MAX_SAFE_INTEGER
      else if (statusRows + i === box.bottom) { c1 = 0; c2 = box.right + 1 }
      lines.push(inverseRange(line, c1, c2 === Number.MAX_SAFE_INTEGER ? 1e9 : c2))
    } else {
      lines.push(line)
    }
  }
  while (lines.length < height - bottomRows) lines.push('')
  lines.push(...suggestLines)
  lines.push(...inputLines)
  // Cursor: the wrapped (row, col) of label chars + editor cursor in inputText.
  const editorCursor = editor === undefined ? 0 : editor.cursor
  const caret = wrappedCursor(inputText, label.length + editorCursor, width)
  const cursorRow = Math.max(1, Math.min(height, height - inputLines.length + caret.row + 1))
  const cursorCol = Math.max(1, Math.min(width, caret.col + 1))
  return { lines, cursorRow, cursorCol }
}

/** Incremental stdout writer for the non-TTY path: emits only what has not been written yet. */
function plainFlush(state: TuiState): void {
  const out = state.plainOut
  const view = currentView(state)
  if (out === undefined || view === undefined) return
  // A closed pipe (| head, a gone pty) must never crash the driver.
  const write = (chunk: string): void => { try { out.write(chunk) } catch { /* EPIPE: reader gone */ } }
  const cursor = state.plainCursor
  while (cursor.block < view.blocks.length) {
    const block = view.blocks[cursor.block]
    if (block === undefined) { cursor.block += 1; continue }
    const open = cursor.block === view.blocks.length - 1
    if (block.kind === 'assistant') {
      const reasoning = block.reasoning ?? ''
      if (cursor.reasoning < reasoning.length) {
        write(ANSI.gray + ANSI.italic + reasoning.slice(cursor.reasoning) + ANSI.reset)
        cursor.reasoning = reasoning.length
      }
      if (cursor.text < block.text.length) {
        write(block.text.slice(cursor.text))
        cursor.text = block.text.length
      }
      if (open) return
    } else {
      if (block.kind === 'tool') {
        const oneLine = block.args.replace(/\s+/g, ' ').trim()
        const preview = oneLine.length > 160 ? oneLine.slice(0, 157) + '...' : oneLine
        write('\n' + ANSI.cyan + '● ' + block.name + ANSI.reset + ' ' + ANSI.dim + preview + ANSI.reset + '\n')
      } else if (block.kind === 'user') {
        write(ANSI.dim + '> ' + block.text + ANSI.reset + '\n')
      } else {
        write(block.text + '\n')
      }
    }
    cursor.block += 1
    cursor.reasoning = 0
    cursor.text = 0
  }
}

/** Repaint now (throttled at ~30fps); plain path flushes incrementally. */
function draw(state: TuiState, throttle: Throttle): void {
  const term = state.term
  if (term === undefined) { plainFlush(state); return }
  const now = Date.now()
  if (now - throttle.last < 16) {
    // Coalesce the trailing edge into a single timer, and never paint after
    // quit tore the terminal down (a dead pty makes the write throw EPIPE).
    if (throttle.timer === undefined) {
      throttle.timer = setTimeout(() => {
        throttle.timer = undefined
        if (!state.quitting) term.render(renderFrame(state))
      }, 16)
    }
    return
  }
  throttle.last = now
  term.render(renderFrame(state))
}

/** Append a system notice to the current view's transcript and repaint. */
function addSystem(state: TuiState, text: string, throttle: Throttle): void {
  currentView(state)?.blocks.push({ kind: 'system', text })
  draw(state, throttle)
}

/**
 * Image-paste shortcut handler (Ctrl+V / Alt+V, pi parity): read the system
 * clipboard; an image is written to a temp file and its path is pasted at the
 * cursor (the agent picks it up from there, same lifecycle as pi's paste),
 * otherwise the clipboard text goes through the normal paste pipeline.
 */
async function pasteFromClipboard(state: TuiState): Promise<void> {
  const editor = state.editor
  if (editor === undefined || state.quitting) return
  try {
    const image = await readClipboardImage()
    if (image !== undefined) {
      const file = join(tmpdir(), 'dsh-clipboard-' + randomUUID() + '.png')
      writeFileSync(file, image.bytes)
      editor.pasteText(file)
      return
    }
    const text = await readClipboardText()
    if (text !== undefined && text.trim() !== '') editor.pasteText(text)
  } catch {
    // Clipboard access is best-effort; a locked or empty clipboard stays silent.
  }
}

/** Ctrl+X / /copy: write the current view's last assistant reply to the clipboard. */
function copyLastReply(state: TuiState, notify: (text: string) => void): void {
  const view = currentView(state)
  let text = ''
  for (let i = (view?.blocks.length ?? 0) - 1; i >= 0; i -= 1) {
    const b = view?.blocks[i]
    if (b !== undefined && b.kind === 'assistant') { text = b.text; break }
  }
  if (text === '') { notify('nothing to copy yet'); return }
  void writeClipboardText(text).then((ok) => {
    notify(ok ? 'copied the last reply (' + String(text.length) + ' chars)' : 'clipboard write failed (no clip/pbcopy/wl-copy/xclip)')
  })
}

/**
 * Copy the current mouse-selection box (from the last rendered body window)
 * to the clipboard and dismiss it. Rows/cols are 0-based screen coordinates;
 * the body starts at screen row 2, so body window row = screen row - 2.
 */
function copySelection(state: TuiState, notify: (text: string) => void): void {
  const sel = state.selection
  const body = state.bodyText
  if (sel === undefined || body === undefined) { notify('no selection to copy — drag with the left button to select'); return }
  const top = Math.min(sel.anchor.row, sel.focus.row) - 2
  const bottom = Math.max(sel.anchor.row, sel.focus.row) - 2
  const left = Math.min(sel.anchor.col, sel.focus.col)
  const right = Math.max(sel.anchor.col, sel.focus.col)
  const parts: string[] = []
  for (let r = top; r <= bottom; r += 1) {
    const line = body[r]
    if (line === undefined) continue
    let c1 = left
    let c2 = Number.MAX_SAFE_INTEGER
    if (top === bottom) c2 = right + 1 // right is inclusive; sliceVisible takes exclusive
    else if (r === top) c2 = Number.MAX_SAFE_INTEGER
    else if (r === bottom) { c1 = 0; c2 = right + 1 }
    parts.push(sliceVisible(line, c1, c2 === Number.MAX_SAFE_INTEGER ? 1e9 : c2).trimEnd())
  }
  const text = parts.join('\n')
  state.selection = undefined
  if (text.trim() === '') { notify('selection was empty'); return }
  void writeClipboardText(text).then((ok) => {
    notify(ok ? 'copied selection (' + String(text.length) + ' chars)' : 'clipboard write failed (no clip/pbcopy/wl-copy/xclip)')
  })
}

/**
 * Extract a markdown code block from the rendered body rows when the clicked
 * row is its top bar (`┌ …⧉`). Rows are the plain-text body window; the bar
 * opens the block and the `└` row closes it; code rows drop their `│` border.
 */
function extractCodeAt(state: TuiState, bodyRow: number): string | undefined {
  const body = state.bodyText
  if (body === undefined) return undefined
  const topLine = body[bodyRow]
  if (topLine === undefined || !topLine.trimStart().startsWith('┌')) return undefined
  const parts: string[] = []
  for (let r = bodyRow + 1; r < body.length; r += 1) {
    const line = body[r] ?? ''
    if (line.trimStart().startsWith('└')) break
    if (line.startsWith('│')) parts.push(line.slice(1))
    else parts.push(line)
  }
  return parts.join('\n')
}

/** Block indexes whose stripped text contains the query (case-insensitive), oldest first. */
function computeMatches(view: SessionView | undefined, query: string): number[] {
  const q = query.toLowerCase()
  if (q === '' || view === undefined) return []
  const out: number[] = []
  view.blocks.forEach((b, i) => {
    const text = (b.kind === 'tool' ? b.name + ' ' + b.args : b.text).toLowerCase()
    if (text.includes(q)) out.push(i)
  })
  return out
}

/** Scroll the current match's block into view (its first line near the top of the body window). */
function jumpToMatch(state: TuiState): void {
  const s = state.search
  const view = currentView(state)
  if (s === undefined || view === undefined) return
  const bi = s.matches[s.current]
  if (bi === undefined) return
  const start = state.blockStarts[bi]
  if (start === undefined) return
  view.scroll = Math.max(0, start - 2)
}

/** Move the search focus by delta (wrapping) and scroll to the hit. */
function moveMatch(state: TuiState, delta: number, throttle: Throttle): void {
  const s = state.search
  if (s === undefined || s.matches.length === 0) return
  const n = s.matches.length
  s.current = ((s.current + delta) % n + n) % n
  jumpToMatch(state)
  draw(state, throttle)
}

/** Ctrl+G: hand the terminal to $EDITOR (notepad on win32) and take the file back as input. */
function openExternalEditor(state: TuiState, throttle: Throttle): void {
  const editor = state.editor
  const term = state.term
  if (editor === undefined || term === undefined || state.quitting) return
  const file = join(tmpdir(), 'dsh-edit-' + randomUUID() + '.md')
  writeFileSync(file, editor.value)
  editor.stop()
  term.leave()
  const command = process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi')
  spawnSync(command, [file], { stdio: 'inherit', shell: process.platform === 'win32' })
  term.enter()
  editor.start()
  let text = ''
  try {
    text = readFileSync(file, 'utf8').trim()
  } catch { /* vanished temp file: nothing to take back */ }
  try { unlinkSync(file) } catch { /* best effort */ }
  // Long drafts collapse into paste markers through the normal pipeline.
  if (text !== '') editor.pasteText(text)
  draw(state, throttle)
}

/** Ask one line of input through the modal prompt. */
function askUser(state: TuiState, label: string): Promise<string> {
  return new Promise((resolve) => {
    state.prompt = { label, resolve, menu: undefined }
    // A modal prompt owns the input: no slash-command dropdown on top of it.
    if (state.editor !== undefined) state.editor.suggestEnabled = false
    state.editor?.reset()
    state.term?.render(renderFrame(state))
  })
}

/** Render a picker menu into a prompt label with the highlighted row marked. */
function menuLabel(menu: PendingMenu): string {
  let out = ANSI.bold + menu.title + ANSI.reset + '\n'
  menu.items.forEach((item, i) => {
    const box = menu.multi
      ? (menu.checked[i] === true ? ANSI.brightGreen + '☑ ' + ANSI.reset : ANSI.dim + '☐ ' + ANSI.reset)
      : ''
    out += i === menu.index
      ? ANSI.brightCyan + '❯ ' + ANSI.reset + box + ANSI.bold + item.text + ANSI.reset + '\n'
      : '  ' + box + ANSI.dim + item.text + ANSI.reset + '\n'
  })
  out += ANSI.dim + menu.footer + ANSI.reset
  return out
}

/**
 * Ask one of several choices through an arrow-navigable modal menu. The
 * highlighted item's value is returned on an empty Enter (multi-select
 * resolves the checked items' values, '\n'-joined); typing a value (or a
 * number, or '0') still works exactly like the previous plain prompt.
 */
function askUserMenu(state: TuiState, menu: PendingMenu): Promise<string> {
  return new Promise((resolve) => {
    // A modal prompt owns the input: no search overlay, no slash-command dropdown.
    state.search = undefined
    state.prompt = { label: menuLabel(menu), resolve, menu }
    if (state.editor !== undefined) state.editor.suggestEnabled = false
    state.editor?.reset()
    state.term?.render(renderFrame(state))
  })
}

/** Move the open prompt menu's highlight by ±1 (wrapping); true = key consumed. */
function navigatePromptMenu(state: TuiState, delta: -1 | 1): boolean {
  const prompt = state.prompt
  if (prompt === undefined) return false
  const menu = prompt.menu
  if (menu === undefined || menu.items.length === 0) return false
  const n = menu.items.length
  menu.index = ((menu.index + delta) % n + n) % n
  prompt.label = menuLabel(menu)
  state.term?.render(renderFrame(state))
  return true
}

/**
 * Ask one line through the modal prompt, reserving the prompt immediately and
 * filling the label once `label` settles. Reserving first closes the race
 * where an interactive picker's async roster load leaves the editor in normal
 * mode, so a fast answer would be submitted to the session as a chat message;
 * callers must await their own `label` promise before interpreting the answer
 * so an early reply still maps onto the final roster.
 */
function askUserDeferred(state: TuiState, label: Promise<string>): Promise<string> {
  return new Promise((resolve) => {
    state.search = undefined // a modal owns the input; search overlay off
    state.prompt = { label: '', resolve, menu: undefined }
    // A modal prompt owns the input: no slash-command dropdown on top of it.
    if (state.editor !== undefined) state.editor.suggestEnabled = false
    state.editor?.reset()
    state.term?.render(renderFrame(state))
    void label.then(
      (text) => {
        if (state.prompt !== undefined) state.prompt.label = text
        if (!state.quitting) state.term?.render(renderFrame(state))
      },
      (error: unknown) => {
        if (state.prompt !== undefined) {
          state.prompt.label = ANSI.brightRed + 'picker failed: ' + (error instanceof Error ? error.message : String(error)) + ANSI.reset + ' — Enter to cancel'
        }
        if (!state.quitting) state.term?.render(renderFrame(state))
      },
    )
  })
}

/** Ensure an assistant block is open for streaming, creating one as needed. */
function ensureAssistant(view: SessionView): AssistantBlock {
  if (view.openAssistant === undefined) {
    view.openAssistant = { kind: 'assistant', text: '' }
    view.blocks.push(view.openAssistant)
  }
  return view.openAssistant
}

/** Extract visible text from a message's content blocks (defensive). */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

/** Rebuild a view's transcript from its session's existing events (resume/fork replay). */
function replayHistory(view: SessionView): void {
  view.blocks = []
  view.todos = []
  view.openAssistant = undefined
  for (const event of view.agent.session.events) {
    switch (event.type) {
      case 'user/message':
        if (event.data.source.kind === 'user') view.blocks.push({ kind: 'user', text: messageText(event.data.content) })
        break
      case 'assistant/message': {
        const text = messageText(event.data.message.content)
        if (text !== '') view.blocks.push({ kind: 'assistant', text })
        const usage = event.data.usage
        if (usage !== undefined) {
          addUsage(view.usage, usage)
          view.lastInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        }
        break
      }
      case 'tool/call':
        view.blocks.push({ kind: 'tool', name: event.data.name, args: event.data.arguments, callId: String(event.data.callId) })
        break
      case 'tool/result': {
        const callId = String(event.data.message.source.callId)
        const block = findToolBlock(view, callId)
        if (block !== undefined) {
          const diffs = diffsFromMeta(event.data.meta)
          if (diffs !== undefined) block.diffs = diffs
          else block.summary = toolResultText(event.data.message)
        }
        break
      }
      case 'todo/write':
        view.todos = event.data.todos
        break
      default:
        break
    }
  }
}

/** Answer one approval request inline, labelled with its owning session. */
async function answerApproval(state: TuiState, req: ApprovalRequest): Promise<ApprovalOutcome> {
  if (state.quitting) return 'unavailable'
  if (req.signal?.aborted) return 'cancelled'
  const ownerKey = String(req.agent.session.id)
  // The user already chose auto-allow for this session: answer without asking.
  if (state.autoApprove.has(ownerKey)) return 'allowed-once'
  const reason = req.reason === undefined ? '' : ANSI.dim + '  ' + req.reason + ANSI.reset + '\n'
  // Route attribution: the answerer is global, but the question belongs to one
  // agent. When that agent's view is not on screen the label still says whose
  // ask this is (sub-agent approvals would otherwise look like the current
  // session's own ask).
  const ownerTag = ownerKey === state.current ? '' : ANSI.dim + '  [agent #' + ownerKey.slice(-6) + ']' + ANSI.reset + '\n'
  const question = ANSI.brightYellow + '⚠ approve ' + ANSI.bold + req.toolName + ANSI.reset + ANSI.brightYellow + '?' + ANSI.reset + '\n' + ownerTag + reason + ANSI.dim + '[y] allow once / [a] always allow this session / [Enter] reject' + ANSI.reset
  const answerPromise = askUser(state, question + ': ').then(a => a.trim().toLowerCase())
  const signal = req.signal
  const cancelled = signal === undefined ? undefined : new Promise<'cancelled'>((resolve) => { signal.addEventListener('abort', () => { resolve('cancelled') }, { once: true }) })
  const answer = cancelled === undefined ? await answerPromise : await Promise.race([answerPromise, cancelled])
  state.prompt = undefined
  if (answer === 'cancelled') return 'cancelled'
  if (answer === 'y') return 'allowed-once'
  if (answer === 'a') {
    state.autoApprove.add(ownerKey)
    const view = currentView(state)
    view?.blocks.push({ kind: 'system', text: 'auto-approve on for this session — future approval prompts are allowed automatically (/auto toggles)' })
    state.term?.render(renderFrame(state))
    return 'allowed-once'
  }
  return 'rejected'
}

/** Answer a batch of user questions inline. */
async function answerQuestions(state: TuiState, request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswer['answers'] = []
  for (const q of request.questions) {
    if (q.intent?.kind === 'plan-review') {
      const view = currentView(state)
      view?.blocks.push({ kind: 'system', text: 'plan review' })
      if (q.detail !== undefined && q.detail !== '') view?.blocks.push({ kind: 'assistant', text: q.detail })
      state.term?.render(renderFrame(state))
    }
    const options = q.options ?? []
    // Questions with a fixed option list get the arrow-navigable picker:
    // single-select keeps the existing highlight+Enter, multi-select toggles
    // rows with space and submits all checked on Enter.
    if (options.length > 0) {
      const multi = q.multiSelect === true
      const items: MenuItem[] = options.map(opt => ({
        value: opt.label,
        text: opt.label + (opt.description === undefined ? '' : ' ' + ANSI.dim + '— ' + opt.description + ANSI.reset),
      }))
      const title = ANSI.cyan + '? ' + q.question + ANSI.reset + (q.detail === undefined || q.detail === '' ? '' : ANSI.dim + ' — ' + q.detail + ANSI.reset)
      const raw = (await askUserMenu(state, {
        title,
        items,
        index: 0,
        multi,
        checked: multi ? items.map(() => false) : [],
        footer: multi ? 'space toggles · Enter submits · Esc cancels' : '↑/↓ highlight · Enter picks · Esc cancels',
      })).trim()
      state.prompt = undefined
      const picked = multi ? raw.split('\n').filter(s => s !== '') : (raw === '' ? [] : [raw])
      if (multi || picked.length > 0) {
        answers.push({ id: q.id, selected: picked })
      } else {
        answers.push({ id: q.id, selected: [], custom: raw })
      }
      continue
    }
    let text = ANSI.cyan + '? ' + q.question + ANSI.reset + '\n'
    if (q.detail !== undefined) text += ANSI.dim + q.detail + ANSI.reset + '\n'
    const label = text + ': '
    const raw = (await askUser(state, label)).trim()
    state.prompt = undefined
    if (raw === '') {
      answers.push({ id: q.id, selected: [] })
    } else {
      answers.push({ id: q.id, selected: [], custom: raw })
    }
  }
  return { answers }
}

/** Minimal structural contract for the session-query service the pickers need. */
interface SessionQueryLike {
  listSessions(): Promise<Array<{ header: { id: string; createdAt: number; cwd?: string }; live: boolean; persisted: boolean }>>
  readTitleSnapshots(ids: string[]): Promise<Array<{ sessionId?: string; status?: string; value?: { title?: { title?: string } } }>>
}

/** Fetch id → title map for the given session records (best effort). */
async function fetchTitles(query: SessionQueryLike, ids: string[]): Promise<Map<string, string>> {
  const titleById = new Map<string, string>()
  const titlesRaw = await query.readTitleSnapshots(ids).catch(() => [])
  for (const t of titlesRaw) {
    if (t.status === 'fulfilled' && typeof t.sessionId === 'string' && typeof t.value?.title?.title === 'string') {
      titleById.set(t.sessionId, t.value.title.title)
    }
  }
  return titleById
}

/** Render the resume picker list and return the chosen session id, or undefined to start fresh. */
async function pickResume(ctx: Context, state: TuiState, throttle: Throttle): Promise<string | undefined> {
  const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (query === undefined) {
    addSystem(state, 'session resume unavailable: sessionQuery is not mounted', throttle)
    return undefined
  }
  let records: { id: string; title: string | undefined; createdAt: number; cwd: string | undefined }[]
  try {
    const sessions = await query.listSessions()
    const titleById = await fetchTitles(query, sessions.map(s => s.header.id))
    records = sessions.map(s => ({
      id: s.header.id,
      createdAt: s.header.createdAt,
      cwd: s.header.cwd,
      title: titleById.get(s.header.id),
    }))
  } catch (error: unknown) {
    addSystem(state, 'resume list failed: ' + (error instanceof Error ? error.message : String(error)), throttle)
    return undefined
  }
  if (records.length === 0) {
    addSystem(state, 'no persisted sessions to resume', throttle)
    return undefined
  }
  const max = Math.min(20, records.length)
  const items: MenuItem[] = records.slice(0, max).map((r, i) => {
    const when = new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    const title = r.title === undefined ? '(untitled)' : r.title
    return {
      value: String(i + 1),
      text: title + ' ' + ANSI.dim + when + (r.cwd === undefined ? '' : ' · ' + r.cwd) + ANSI.reset,
    }
  })
  const raw = (await askUserMenu(state, {
    title: 'resume a session',
    items,
    index: 0,
    multi: false, checked: [],
    footer: '0) start fresh · ↑/↓ highlight · Enter picks',
  })).trim()
  state.prompt = undefined
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 1 && n <= max) return records[n - 1]?.id
  return undefined
}

/** Find the tool block matching a call id (most recent match wins). */
function findToolBlock(view: SessionView, callId: string): ToolBlock | undefined {
  for (let i = view.blocks.length - 1; i >= 0; i -= 1) {
    const b = view.blocks[i]
    if (b !== undefined && b.kind === 'tool' && b.callId === callId) return b
  }
  return undefined
}

const HELP_TEXT = [
  'Commands:',
  '  /help                          show this help',
  '  /model                         pick a provider and model from the menu (current marked)',
  '  /model <provider> <model> [effort]   switch model directly (effort: off | high | max); /model <model> keeps the provider',
  '  /preset                        pick an agent preset from the menu (current marked)',
  '  /preset <id>                   switch preset directly — only before the session\'s first message',
  '  /mode                          pick a mode from the menu (标准 → PTC → 极简 → 创造) — blank session only',
  '  Shift+Tab                      cycle reasoning effort (high → max → off → high)',
  '  /fork [turn]                   branch into a child session and switch to it; [turn] rewinds to that turn',
  '  /new                           start a fresh session alongside this one',
  '  /bell                          toggle the turn-end bell',
  '  /name <title>                  name the current session (shown in /sessions)',
  '  /tree                          show the session family tree (fork lineage); Enter switches',
  '  /export                        write the current session transcript to dsh-export-<id>.md',
  '  Ctrl+T                          toggle the thinking (reasoning) display',
  '  Ctrl+P                          cycle to the next model (provider catalog)',
  '  Ctrl+L                          open the model picker menu',
  '  /auto                          toggle auto-approve for this session (approval prompts answer themselves)',
  '  /sessions                      switch between live sessions or resume a persisted one',
  '  /exit                          flush the session and quit (Ctrl+C at idle: clears input, double-press quits)',
  '  Ctrl+F                          search the transcript (Enter/↑↓ next, Esc closes)',
  'While the agent works, Ctrl+C interrupts; typing then Enter queues a follow-up (Alt+Up recalls it); Ctrl+O expands tool output.',
  'Editor: / opens command autocomplete (also completes @file-paths and command args); click or Tab completes; Enter runs.',
  'Ctrl+Z undo · Ctrl+Y yank · Ctrl+X copy last reply · Ctrl+G external editor ($EDITOR).',
  'While the agent works, Ctrl+C interrupts; drag with the left button to select text and right-click or Ctrl+C copies it (Shift+drag selects natively); PageUp/PageDown or the wheel scroll the history; Shift+Enter inserts a newline (Alt+Enter works too).',
  'Typing / opens command autocomplete (fuzzy, case-insensitive); Tab completes, Enter runs, Esc closes.',
  'Large pastes collapse into [paste #N …] markers; Ctrl+V / Alt+V pastes an image from the clipboard (path inserted).',
].join('\n')

/**
 * /model with no argument: arrow-navigable picker over the provider catalog,
 * then over that provider's advertised models. A lone provider skips straight
 * to the model menu. The choice applies through switchModel, which keeps the
 * current reasoning effort when none is given (Shift+Tab owns the effort).
 */
async function pickModel(ctx: Context, state: TuiState, write: (text: string) => void): Promise<void> {
  const llm = ctx.get('llm')
  if (llm === undefined) { write('no llm roster composed'); return }
  const providers = llm.listConfigurableProviders()
  if (providers.length === 0) { write('no configurable providers'); return }
  const current = state.selectionRef?.current
  let provider: string
  if (providers.length === 1) {
    provider = providers[0]?.provider ?? ''
  } else {
    const items: MenuItem[] = providers.map(p => ({
      value: p.provider,
      text: p.provider + (p.displayName === p.provider ? '' : ' — ' + p.displayName)
        + (current?.provider === p.provider ? ' ' + ANSI.green + '(current)' + ANSI.reset : ''),
    }))
    const picked = (await askUserMenu(state, {
      title: 'model provider',
      items,
      index: Math.max(0, items.findIndex(i => i.value === current?.provider)),
      multi: false, checked: [],
      footer: '0) cancel · ↑/↓ highlight · Enter picks',
    })).trim()
    state.prompt = undefined
    if (picked === '' || !items.some(i => i.value === picked)) return
    provider = picked
  }
  // Resolve the model roster up front so the second menu paints fully formed
  // (it is a network call; a modal menu cannot repaint mid-answer).
  const models = await llm.listModels(provider).catch(() => [])
  if (models.length === 0) { write('no models advertised by ' + provider); return }
  const items: MenuItem[] = models.map(m => ({
    value: m.id,
    text: m.id + (m.name === m.id ? '' : ' — ' + m.name)
      + (current?.provider === provider && current.model === m.id ? ' ' + ANSI.green + '(current)' + ANSI.reset : ''),
  }))
  const picked = (await askUserMenu(state, {
    title: 'model — ' + provider,
    items,
    index: Math.max(0, items.findIndex(i => current?.provider === provider && i.value === current.model)),
    multi: false, checked: [],
    footer: '0) cancel · ↑/↓ highlight · Enter picks',
  })).trim()
  state.prompt = undefined
  if (picked === '' || !items.some(i => i.value === picked)) return
  switchModel(ctx, state, write, provider + ' ' + picked)
}

/** /model <provider> <model> [effort]: validate against the catalog, then mutate the live selection and persist. */
function switchModel(ctx: Context, state: TuiState, write: (text: string) => void, arg: string): void {
  const [one, two, three] = arg.split(/\s+/).filter(part => part !== '')
  const current = state.selectionRef?.current
  let provider: string | undefined
  let model: string | undefined
  let effort: string | undefined
  // A missing effort inherits the current selection's effort, so a picker-
  // driven model switch never silently drops the reasoning level.
  if (two === undefined) { provider = current?.provider; model = one }
  else { provider = one; model = two; effort = three === undefined ? current?.reasoningEffort : three }
  if (provider === undefined || model === undefined) { write('dsh: usage /model <provider> <model> [effort]'); return }
  if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) { write('dsh: effort must be one of off | low | high | max'); return }
  const llm = ctx.get('llm')
  const known = (llm?.listConfigurableProviders() ?? []).map(entry => entry.provider)
  const applySwitch = (): void => {
    const next: ModelSelection = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort as ReasoningEffortId }) }
    if (state.selectionRef !== undefined) state.selectionRef.current = next
    state.contextWindow = undefined
    void llm?.resolveModelInfo(provider, model)
      .then((info) => { state.contextWindow = info.context?.contextWindow })
      .catch(() => undefined)
    void ctx.get('agentDefaultModel')?.saveSelection(next).catch((error: unknown) => { write('dsh: saving default failed: ' + (error instanceof Error ? error.message : String(error))) })
    const effortText = effort === undefined ? '' : ' (' + effort + ')'
    const warn = known.length > 0 && !known.includes(provider) ? ' ' + ANSI.yellow + '(provider not in catalog; passing through anyway)' + ANSI.reset : ''
    write('model → ' + provider + ' / ' + model + effortText + warn)
  }
  // A cataloged provider can name its models: refuse to persist a model it
  // never advertised (a stray token once became the saved default and 400'd
  // every later boot). Unknown/uncataloged providers pass through as before.
  if (llm !== undefined && known.includes(provider)) {
    void llm.listModels(provider).then((models) => {
      if (models.length > 0 && !models.some(m => m.id === model)) {
        write('dsh: unknown model "' + model + '" for ' + provider + ' — not applied. Known: ' + models.slice(0, 8).map(m => m.id).join(', ') + (models.length > 8 ? ', …' : ''))
        return
      }
      applySwitch()
    }).catch(() => { applySwitch() })
    return
  }
  applySwitch()
}

/** Shift+Tab: cycle the reasoning effort (high → max → off → high), keeping provider/model. */
function cycleEffort(ctx: Context, state: TuiState, write: (text: string) => void): void {
  const ref = state.selectionRef
  const current = ref?.current
  if (ref === undefined || current === undefined) { write('dsh: no model selection to cycle effort on'); return }
  // Cycle order is high → max → off so a fresh (unset) selection boosts to
  // high first; off lands on the next press, then loops back to high.
  const cycle = ['high', 'max', 'off'] as const
  const cur = current.reasoningEffort
  const idx = cur === undefined ? -1 : cycle.indexOf(cur as (typeof cycle)[number])
  const next = cycle[(idx + 1) % cycle.length]
  if (next === undefined) return
  const updated: ModelSelection = { provider: current.provider, model: current.model, reasoningEffort: next as ReasoningEffortId }
  ref.current = updated
  void ctx.get('agentDefaultModel')?.saveSelection(updated).catch((error: unknown) => {
    write('dsh: saving default failed: ' + (error instanceof Error ? error.message : String(error)))
  })
  write('effort → ' + next + (next === 'off' ? ' (reasoning disabled)' : ''))
}

/**
 * Ctrl+P: cycle to the next model in the flattened provider catalog (wraps
 * around), applying and persisting it through switchModel. The current model
 * is located by provider+id; a model that disappeared from the catalog
 * starts the cycle at the first entry.
 */
async function cycleModel(ctx: Context, state: TuiState, write: (text: string) => void, reverse = false): Promise<void> {
  const llm = ctx.get('llm')
  const current = state.selectionRef?.current
  if (llm === undefined || current === undefined) { write('dsh: no model selection to cycle'); return }
  const models: Array<{ provider: string; id: string }> = []
  for (const entry of llm.listConfigurableProviders()) {
    const list = await llm.listModels(entry.provider).catch(() => [])
    for (const model of list) models.push({ provider: entry.provider, id: model.id })
  }
  if (models.length === 0) { write('dsh: no models advertised'); return }
  const idx = models.findIndex(m => m.provider === current.provider && m.id === current.model)
  const next = models[(((idx + (reverse ? -1 : 1)) % models.length) + models.length) % models.length]
  if (next === undefined) return
  switchModel(ctx, state, write, next.provider + ' ' + next.id)
}

/** /name <title>: pin an explicit user title on the current session (shown in /sessions). */
function nameSession(state: TuiState, write: (text: string) => void, title: string): void {
  const key = state.current
  const view = currentView(state)
  if (key === undefined || view === undefined) { write('dsh: no current session'); return }
  const t = title.trim()
  if (t === '') { write('usage: /name <title>'); return }
  state.titles.set(key, t)
  try {
    // Explicit user rename: the source pins the title against regeneration.
    // The session-title package extends SessionEventMap via a declare-module
    // patch that this bundle cannot import (no build product), so the event
    // type is asserted structurally.
    const payload = { title: t, messageSeqs: [] as number[], source: { kind: 'user' as const } }
    view.agent.session.append('session/title' as keyof SessionEventMap, payload as never)
  } catch (error: unknown) {
    write('dsh: ' + (error instanceof Error ? error.message : String(error)))
  }
  updateTitle(state)
  write('session named → ' + t)
}

interface PresetPickerOpts { title: string; verb: string }

/** Shared picker menu over the preset roster; /preset and /mode both use it. */
async function pickPresetMenu(ctx: Context, state: TuiState, write: (text: string) => void, opts: PresetPickerOpts): Promise<void> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) { write('no preset roster composed'); return }
  const list = await presets.list()
  if (list.length === 0) { write('no presets composed'); return }
  const currentId = state.presetId
  const items: MenuItem[] = list.map(p => ({
    value: p.id,
    text: p.id + (p.name === undefined ? '' : ' — ' + p.name)
      + (p.id === currentId ? ' ' + ANSI.green + '(current)' + ANSI.reset : ''),
  }))
  const picked = (await askUserMenu(state, {
    title: opts.title,
    items,
    index: Math.max(0, items.findIndex(i => i.value === currentId)),
    multi: false, checked: [],
    footer: '0) cancel · ↑/↓ highlight · Enter picks',
  })).trim()
  state.prompt = undefined
  if (picked === '' || !items.some(i => i.value === picked)) return
  await switchPreset(ctx, state, write, picked, opts.verb)
}

/** /preset <id>: re-link the agent while it has produced nothing. */
async function switchPreset(ctx: Context, state: TuiState, write: (text: string) => void, id: string, verb = 'preset'): Promise<void> {
  const presets = ctx.get('agentPresets')
  const view = currentView(state)
  if (presets === undefined || view === undefined) return
  const started = view.agent.session.events.some(event => event.type === 'user/message')
  if (started) { write(ANSI.yellow + 'the ' + verb + ' is fixed once the session has messages — start a new session with: dsh --profile tui --preset ' + id + ANSI.reset); return }
  try {
    const mounted = await presets.recompose(view.agent.ctx, id)
    view.agent.session.append('agent-preset/selected', { agentPreset: mounted.id })
    state.presetId = mounted.id
    state.presetName = mounted.name
    write(verb + ' → ' + mounted.id + (mounted.name === undefined ? '' : ' — ' + mounted.name))
  } catch (error: unknown) {
    write('dsh: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/** Handle a slash command, returning true when consumed. */
async function handleCommand(ctx: Context, state: TuiState, write: (text: string) => void, text: string): Promise<boolean> {
  if (text === '/help') { write(HELP_TEXT); return true }
  if (text === '/model') { await pickModel(ctx, state, write); return true }
  if (text.startsWith('/model ')) { switchModel(ctx, state, write, text.slice('/model '.length)); return true }
  if (text === '/preset') { await pickPresetMenu(ctx, state, write, { title: 'agent preset', verb: 'preset' }); return true }
  if (text.startsWith('/preset ')) { await switchPreset(ctx, state, write, text.slice('/preset '.length)); return true }
  if (text === '/mode') { await pickPresetMenu(ctx, state, write, { title: 'mode', verb: 'mode' }); return true }
  if (text === '/bell') { state.bell = !state.bell; write('turn-end bell: ' + (state.bell ? 'on' : 'off')); return true }
  if (text === '/auto') {
    const key = state.current
    if (key === undefined) { write('auto-approve: no current session'); return true }
    const on = state.autoApprove.has(key)
    if (on) state.autoApprove.delete(key)
    else state.autoApprove.add(key)
    write('auto-approve for this session: ' + (on ? 'off' : 'on') + ' (approval prompts are answered automatically)')
    return true
  }
  if (text === '/copy') { copyLastReply(state, write); return true }
  if (text.startsWith('/name ')) { nameSession(state, write, text.slice('/name '.length)); return true }
  if (text === '/tree') { await showSessionTree(state, write); return true }
  if (text === '/export') { exportSession(state, write); return true }
  // Unknown slash command: forward to the engine's command runtime so host
  // commands (/compact, /goal, …) stay reachable from the TUI instead of
  // being shadowed by our own catalog.
  if (text.startsWith('/')) {
    const view = currentView(state)
    const commands = ctx.get('commands') as CommandRuntimeLike | undefined
    if (view !== undefined && commands !== undefined) {
      try {
        const exec = await commands.execute(view.agent, text, new AbortController().signal)
        if (exec !== undefined) {
          const r = exec.result
          if (r.kind === 'success') {
            if (r.text !== undefined && r.text !== '') write(r.text)
          } else {
            write('dsh: ' + (r.text ?? ''))
          }
          return true
        }
      } catch (error: unknown) {
        write('dsh: ' + (error instanceof Error ? error.message : String(error)))
        return true
      }
    }
    write('unknown command — /help lists them all')
    return true
  }
  return false
}

/** Structural mirror of the engine command runtime (avoid a new import edge). */
interface CommandRuntimeLike {
  execute(agent: Agent, line: string, signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>
}

/** /export: write the current session's transcript to a readable markdown file. */
function exportSession(state: TuiState, write: (text: string) => void): void {
  const view = currentView(state)
  if (view === undefined) { write('no current session'); return }
  const parts: string[] = []
  for (const b of view.blocks) {
    switch (b.kind) {
      case 'user':
        parts.push('## You\n\n' + b.text)
        break
      case 'assistant':
        if (b.reasoning !== undefined && b.reasoning !== '') parts.push('### thinking\n\n' + b.reasoning)
        parts.push('## Assistant\n\n' + b.text)
        break
      case 'tool':
        parts.push('### tool: ' + b.name + '\n\n```json\n' + b.args + '\n```')
        break
      case 'system':
        parts.push('> ' + b.text)
        break
      default:
        break
    }
    parts.push('')
  }
  const content = parts.join('\n')
  const file = join(process.cwd(), 'dsh-export-' + (state.current ?? 'session').slice(-6) + '.md')
  try {
    writeFileSync(file, content, 'utf8')
    write('exported → ' + file + ' (' + String(content.length) + ' chars)')
  } catch (error: unknown) {
    write('dsh: export failed: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * /tree: the live session family tree (fork lineage via parentSession). Rows
 * are indented by depth; Enter switches to the highlighted session.
 */
async function showSessionTree(state: TuiState, write: (text: string) => void): Promise<void> {
  interface Node { id: string; depth: number; label: string }
  const byId = new Map<string, { parent: string | undefined; label: string }>()
  for (const [id, v] of state.views) {
    const header = v.agent.session.header
    const firstUser = v.blocks.find(b => b.kind === 'user')
    const first = firstUser === undefined ? '' : (firstUser.text.split('\n')[0] ?? '')
    const title = state.titles.get(id) ?? first
    byId.set(id, {
      parent: header.parentSession === undefined ? undefined : String(header.parentSession),
      label: (state.titles.has(id) ? ANSI.brightGreen + '✦ ' + ANSI.reset : '')
        + truncateAnsi(title === '' ? '(no user message yet)' : title, 40)
        + ' ' + ANSI.dim + '#' + id.slice(-6) + ANSI.reset
        + (id === state.current ? ' ' + ANSI.dim + '(current)' + ANSI.reset : '')
        + (v.busy ? ' ' + ANSI.brightYellow + 'working' + ANSI.reset : ''),
    })
  }
  if (byId.size === 0) { write('no sessions yet'); return }
  const roots = [...byId.keys()].filter((id) => {
    const parent = byId.get(id)?.parent
    return parent === undefined || !byId.has(parent)
  }).sort()
  const nodes: Node[] = []
  const walk = (id: string, depth: number): void => {
    const n = byId.get(id)
    if (n === undefined) return
    nodes.push({ id, depth, label: n.label })
    const children = [...byId.keys()].filter(c => byId.get(c)?.parent === id).sort()
    for (const c of children) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  const items: MenuItem[] = nodes.map(n => ({
    value: n.id,
    text: (n.depth === 0 ? '' : ANSI.dim + '└─ '.repeat(n.depth) + ANSI.reset) + n.label,
  }))
  const currentIdx = nodes.findIndex(n => n.id === state.current)
  const picked = (await askUserMenu(state, {
    title: 'session tree' + ANSI.dim + ' (fork lineage — Enter switches)' + ANSI.reset,
    items,
    index: currentIdx === -1 ? 0 : currentIdx,
    multi: false, checked: [],
    footer: '↑/↓ highlight · Enter switches · Esc cancels',
  })).trim()
  state.prompt = undefined
  if (picked === '' || !byId.has(picked) || picked === state.current) return
  closeSearch(state)
  state.current = picked
  updateTitle(state)
  write('switched → ' + picked)
}

/** One completed turn of a session: turn number plus its first user message. */
interface TurnSummary {
  turn: number
  snippet: string
}

/** Completed turns of a session with the first user message of each, oldest first. */
function listTurns(agent: Agent): TurnSummary[] {
  const out: TurnSummary[] = []
  let snippet = ''
  for (const event of agent.session.events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user' && snippet === '') {
      snippet = messageText(event.data.content).split('\n')[0] ?? ''
    } else if (event.type === 'turn/end') {
      out.push({ turn: event.data.turn, snippet })
      snippet = ''
    }
  }
  return out
}

/** Full-screen-only commands handed to the driver by run(). */
interface FullScreenCommands {
  fork(text: string): Promise<void>
  sessions(): Promise<void>
  fresh(): Promise<void>
}

/**
 * Drive the interactive session: create (or resume) the Agent, then relay between
 * the terminal and the session event stream until the user exits.
 */
async function run(ctx: Context, config: Config, io: TuiIo, state: TuiState, throttle: Throttle): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
  state.selectionRef = selectionRef

  const presets = ctx.get('agentPresets')
  let agentPreset: string | undefined
  let setup: (agentCtx: Context) => Promise<void>
  if (presets === undefined) {
    setup = (agentCtx) => { installModelSelection(agentCtx, selectionRef); return Promise.resolve() }
  } else {
    const resolvedId = (await presets.resolve(config.preset)).id
    agentPreset = resolvedId
    setup = async (agentCtx) => { installModelSelection(agentCtx, selectionRef); await presets.mount(agentCtx, resolvedId) }
  }
  state.presetId = agentPreset
  state.presetName = undefined // resolved lazily by the first /preset | /mode roster read
  state.gitBranch = readGitBranch(process.cwd())

  const agentOptions = { provider: selection.provider, model: selection.model }
  const meta = { cwd: process.cwd(), ...(agentPreset === undefined ? {} : { agentPreset }) }
  // Resolve the route's context window for the status-bar occupancy readout.
  void ctx.get('llm')?.resolveModelInfo(selection.provider, selection.model)
    .then((info) => { state.contextWindow = info.context?.contextWindow })
    .catch(() => undefined)
  // Define quit before the terminal comes up: setupFullScreen hands it to the
  // editor callbacks, and --resume's picker can only run after term+editor exist.
  const quit = (code: number): void => {
    if (state.quitting) return
    state.quitting = true
    stopSpinner(state)
    if (throttle.timer !== undefined) { clearTimeout(throttle.timer); throttle.timer = undefined }
    state.editor?.stop()
    state.term?.leave()
    const settle = async (): Promise<void> => {
      for (const v of state.views.values()) {
        if (v.busy) {
          v.agent.cancel({ kind: 'user' })
          await Promise.race([
            v.agent.whenIdle(),
            new Promise<void>((resolve) => { setTimeout(resolve, 5000) }),
          ]).catch(() => undefined)
        }
        await sessions.flush(v.agent.session).catch(() => undefined)
        // NOTE: handles are intentionally not disposed here — process exit reclaims them.
      }
    }
    void settle().finally(() => { io.exit(code) })
    // Hard backstop only matters when graceful shutdown wedges the event loop;
    // unref'd so a clean drain is not held open by the timer itself.
    setTimeout(() => { process.exit(code) }, 8000).unref()
  }
  // The full-screen slash commands close over the agent handle created below;
  // the editor only calls them later, so backfill this placeholder once they exist.
  const commands: FullScreenCommands = {
    fork: () => Promise.resolve(),
    sessions: () => Promise.resolve(),
    fresh: () => Promise.resolve(),
  }
  // Terminal + raw-mode editor come up BEFORE any modal picker. Previously
  // --resume's picker ran first and its askUser had no term/editor to render
  // into or read from, so the await could never settle on a TTY.
  if (process.stdout.isTTY) setupFullScreen(ctx, state, throttle, quit, commands)

  let handle: { agent: Agent; dispose(): Promise<void> }
  if (config.resume === true && process.stdout.isTTY) {
    const id = await pickResume(ctx, state, throttle)
    if (id !== undefined) handle = await agents.resume({ resumeSessionId: SessionId(id), agentOptions, setup })
    else handle = await agents.create({ sessionId: SessionId('session-' + randomUUID()), meta, agentOptions, setup })
  } else {
    if (config.resume === true && !process.stdout.isTTY) {
      io.stderr.write('dsh: --resume needs an interactive terminal; starting a new session\n')
    }
    handle = await agents.create({ sessionId: SessionId('session-' + randomUUID()), meta, agentOptions, setup })
  }
  const view = addView(state, handle.agent, handle)
  await view.agent.whenIdle()
  replayHistory(view)

  /** Fork the current session into a live child; [turn] rewinds the seed to that turn's end. */
  const fork = async (turn?: number): Promise<void> => {
    const source = currentView(state)
    if (source === undefined) return
    if (source.busy) { addSystem(state, 'cannot fork mid-turn — wait for the turn to finish', throttle); return }
    const events = source.agent.session.events
    let seed = events.slice(0)
    if (turn !== undefined) {
      let idx = -1
      for (let i = 0; i < events.length; i += 1) {
        const e = events[i]
        if (e !== undefined && e.type === 'turn/end' && e.data.turn === turn) { idx = i; break }
      }
      if (idx === -1) { addSystem(state, 'no completed turn ' + String(turn) + ' in this session', throttle); return }
      seed = events.slice(0, idx + 1)
    }
    try {
      const sourceCwd = source.agent.session.header.cwd
      const forkMeta = {
        ...(sourceCwd === undefined ? {} : { cwd: sourceCwd }),
        parentSession: source.agent.id,
        seedLength: seed.length,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      }
      const child = await agents.create({ sessionId: SessionId('session-' + randomUUID()), meta: forkMeta, seed, agentOptions, setup })
      const childView = addView(state, child.agent, child)
      await child.agent.whenIdle()
      replayHistory(childView)
      updateTitle(state)
      const where = turn === undefined ? 'latest point' : 'turn ' + String(turn)
      addSystem(state, 'forked @ ' + where + ' → ' + String(child.agent.id) + ANSI.dim + ' (parent kept alive — /sessions to switch)' + ANSI.reset, throttle)
    } catch (error: unknown) {
      addSystem(state, 'fork failed: ' + (error instanceof Error ? error.message : String(error)), throttle)
    }
  }

  /** Modal picker over the current session's completed turns; 'latest' forks at the head. */
  const pickForkTurn = async (turns: TurnSummary[]): Promise<number | 'latest' | undefined> => {
    const items: MenuItem[] = turns.map((t, i) => ({
      value: String(i + 1),
      text: 'turn ' + String(t.turn) + (t.snippet === '' ? '' : ' — ' + truncateAnsi(t.snippet, 60)),
    }))
    items.push({ value: 'latest', text: 'latest point (forks at the current point)' })
    const raw = (await askUserMenu(state, {
      title: 'fork at a past turn' + ANSI.dim + ' (later turns are dropped from the child)' + ANSI.reset,
      items,
      index: 0,
      multi: false, checked: [],
      footer: '0) cancel · ↑/↓ highlight · Enter picks',
    })).trim()
    state.prompt = undefined
    if (raw.toLowerCase() === 'latest') return 'latest'
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > turns.length) return undefined
    return turns[n - 1]?.turn
  }

  /** /fork [turn]: with no argument, offer the turn picker (or fork directly when turnless). */
  const forkCommand = async (text: string): Promise<void> => {
    const arg = text.slice('/fork'.length).trim()
    if (arg !== '') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1) { addSystem(state, 'usage: /fork [turn-number]', throttle); return }
      await fork(n)
      return
    }
    const source = currentView(state)
    if (source === undefined) return
    const turns = listTurns(source.agent)
    if (turns.length === 0) { await fork(); return }
    const picked = await pickForkTurn(turns)
    if (picked === undefined) return
    if (picked === 'latest') await fork()
    else await fork(picked)
  }

  /** /sessions: switch between live views or resume a persisted session into one. */
  const browseSessions = async (): Promise<void> => {
    interface Entry { kind: 'live' | 'stored'; id: string; label: string }
    const entries: Entry[] = []
    for (const [id, v] of state.views) {
      const firstUser = v.blocks.find(b => b.kind === 'user')
      const first = firstUser === undefined ? '' : (firstUser.text.split('\n')[0] ?? '')
      const title = state.titles.get(id) ?? first
      entries.push({
        kind: 'live',
        id,
        // A /name label wins; otherwise the first user message plus a short
        // id tail distinguishes forked siblings with identical titles.
        label: (state.titles.has(id) ? ANSI.brightGreen + '✦ ' + ANSI.reset : '') + truncateAnsi(title === '' ? '(no user message yet)' : title, 48)
          + ' ' + ANSI.dim + '#' + id.slice(-6) + ANSI.reset
          + (id === state.current ? ' ' + ANSI.dim + '(current)' + ANSI.reset : '')
          + (v.busy ? ' ' + ANSI.brightYellow + 'working' + ANSI.reset : ''),
      })
    }
    // The stored roster loads asynchronously; reserve the modal prompt NOW so
    // a fast answer cannot be submitted to the session as a chat message, and
    // let the menu paint once the roster settles.
    const listing = (async (): Promise<string> => {
      const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
      if (query !== undefined) {
        try {
          const persisted = await query.listSessions()
          const stored = persisted.filter(s => !state.views.has(s.header.id)).slice(0, 15)
          const titleById = await fetchTitles(query, stored.map(s => s.header.id))
          for (const s of stored) {
            const when = new Date(s.header.createdAt).toISOString().slice(0, 16).replace('T', ' ')
            const title = titleById.get(s.header.id) ?? '(untitled)'
            entries.push({ kind: 'stored', id: s.header.id, label: truncateAnsi(title, 60) + ' ' + ANSI.dim + when + ANSI.reset })
          }
        } catch { /* a listing failure still leaves the live entries */ }
      }
      if (entries.length === 0) return 'no sessions to switch to'
      let menu = ANSI.bold + 'sessions' + ANSI.reset + ANSI.dim + ' — ● live, others resume from disk' + ANSI.reset + '\n'
      entries.forEach((e, i) => {
        const marker = e.kind === 'live' ? ANSI.green + '●' + ANSI.reset : ANSI.dim + '○' + ANSI.reset
        menu += '  ' + ANSI.bold + String(i + 1) + ')' + ANSI.reset + ' ' + marker + ' ' + e.label + '\n'
      })
      menu += ANSI.dim + '0) cancel' + ANSI.reset
      return menu + '\nchoose: '
    })()
    const raw = (await askUserDeferred(state, listing)).trim()
    await listing.catch(() => undefined) // roster settled before mapping the answer
    state.prompt = undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > entries.length) return
    const entry = entries[n - 1]
    if (entry === undefined) return
    if (entry.kind === 'live') {
      if (entry.id !== state.current) {
        closeSearch(state)
        state.current = entry.id
        updateTitle(state)
        addSystem(state, 'switched → ' + entry.id, throttle)
      }
      return
    }
    try {
      const resumed = await agents.resume({ resumeSessionId: SessionId(entry.id), agentOptions, setup })
      const resumedView = addView(state, resumed.agent, resumed)
      await resumed.agent.whenIdle()
      replayHistory(resumedView)
      updateTitle(state)
      addSystem(state, 'resumed → ' + entry.id, throttle)
    } catch (error: unknown) {
      addSystem(state, 'resume failed: ' + (error instanceof Error ? error.message : String(error)), throttle)
    }
  }

  /** /new: spin up a fresh session alongside the current one and switch to it. */
  const fresh = async (): Promise<void> => {
    try {
      const created = await agents.create({ sessionId: SessionId('session-' + randomUUID()), meta, agentOptions, setup })
      const freshView = addView(state, created.agent, created)
      await created.agent.whenIdle()
      replayHistory(freshView)
      updateTitle(state)
      addSystem(state, 'new session → ' + String(created.agent.id), throttle)
    } catch (error: unknown) {
      addSystem(state, 'new session failed: ' + (error instanceof Error ? error.message : String(error)), throttle)
    }
  }

  // The slash commands close over the agent handle; backfill them now that
  // fork/sessions/fresh exist, then light the full-screen UI (or the plain path).
  commands.fork = forkCommand
  commands.sessions = browseSessions
  commands.fresh = fresh
  if (process.stdout.isTTY) {
    addSystem(state, 'dsh tui — ' + (view.agent.options.provider ?? '') + ' / ' + (view.agent.options.model ?? '') + (state.presetId === undefined ? '' : ' · preset ' + state.presetId) + ' — /help for commands', throttle)
    updateTitle(state)
    const initial = config.task
    if (initial !== undefined) {
      view.blocks.push({ kind: 'user', text: initial })
      view.busy = true
      view.agent.followup(createUserMessage({ content: [{ type: 'text', text: initial }], source: { kind: 'user' } }))
    }
    draw(state, throttle)
  } else {
    runPlain(config, io, state, view, quit)
  }
}

/** Full-screen path: alternate buffer + raw-mode editor + block rendering. */
function setupFullScreen(
  ctx: Context, state: TuiState,
  throttle: Throttle, quit: (code: number) => void, commands: FullScreenCommands,
): void {
  const term = new Term(process.stdout)
  term.onResize = () => { draw(state, throttle) }
  term.enter()
  state.term = term

  const editor = new LineEditor({
    onSubmit(text) {
      // Search mode: Enter jumps to the next match instead of submitting.
      if (state.search !== undefined) { moveMatch(state, 1, throttle); return }
      if (state.prompt !== undefined) {
        const p = state.prompt
        state.prompt = undefined
        editor.suggestEnabled = true
        editor.reset()
        // Empty Enter on a picker menu selects the highlighted row (multi-
        // select resolves the checked rows, '\n'-joined); a typed answer
        // (number, 'latest', custom text) keeps the legacy behavior.
        if (p.menu !== undefined && text.trim() === '') {
          const menu = p.menu
          if (menu.multi) {
            p.resolve(menu.items.filter((_, i) => menu.checked[i] === true).map(i => i.value).join('\n'))
          } else {
            p.resolve(menu.items[menu.index]?.value ?? '')
          }
        } else {
          p.resolve(text)
        }
        draw(state, throttle)
        return
      }
      const command = normalizeCommand(text)
      if (command === '/exit' || command === '/quit') { quit(0); return }
      if (command === '/new') {
        void commands.fresh().catch((error: unknown) => { addSystem(state, 'dsh: ' + (error instanceof Error ? error.message : String(error)), throttle) })
        return
      }
      if (command === '/fork' || command.startsWith('/fork ')) {
        void commands.fork(command).catch((error: unknown) => { addSystem(state, 'dsh: ' + (error instanceof Error ? error.message : String(error)), throttle) })
        return
      }
      if (command === '/sessions') {
        void commands.sessions().catch((error: unknown) => { addSystem(state, 'dsh: ' + (error instanceof Error ? error.message : String(error)), throttle) })
        return
      }
      if (command.startsWith('/')) {
        void handleCommand(ctx, state, (t) => { addSystem(state, t, throttle) }, command)
          .then((consumed) => { if (!consumed) addSystem(state, 'unknown command — /help lists them all', throttle) })
          .catch((error: unknown) => { addSystem(state, 'dsh: ' + (error instanceof Error ? error.message : String(error)), throttle) })
        return
      }
      const target = currentView(state)
      if (target === undefined || command === '') return
      if (target.busy) {
        // Busy: queue the follow-up (pi semantics); turn/end auto-sends it.
        target.pending.push(command)
        addSystem(state, 'queued (' + String(target.pending.length) + ') — Alt+↑ takes it back for editing', throttle)
        return
      }
      target.blocks.push({ kind: 'user', text: command })
      state.selection = undefined
      target.busy = true
      target.agent.followup(createUserMessage({ content: [{ type: 'text', text: command }], source: { kind: 'user' } }))
      draw(state, throttle)
    },
    onInterrupt() {
      // Ctrl+C with a live selection copies it (the terminal-native copy
      // habit) instead of interrupting the model or quitting the app.
      if (state.selection !== undefined) {
        copySelection(state, (t) => { addSystem(state, t, throttle) })
        return
      }
      const current = currentView(state)
      if (current !== undefined && current.busy) { current.agent.cancel({ kind: 'user' }); addSystem(state, '(interrupting…)', throttle); return }
      // Idle Ctrl+C: a first press clears any typed input; with an empty
      // editor a second press within 2s quits. One accidental press must
      // never close the app (the copy habit from other terminals).
      if (editor.value !== '') { editor.reset(); addSystem(state, '(input cleared — Ctrl+C again to quit)', throttle); return }
      const now = Date.now()
      if (state.idleInterruptAt !== undefined && now - state.idleInterruptAt < 2000) { quit(0); return }
      state.idleInterruptAt = now
      addSystem(state, '(press Ctrl+C again to quit)', throttle)
    },
    // Lone Esc: search closes first, then a modal prompt/picker (close and
    // resolve an empty answer = cancel / reject); only with neither open does
    // Esc interrupt the running model. Esc never quits, unlike Ctrl+C's
    // double-press at idle.
    onEsc() {
      if (state.search !== undefined) {
        state.searchMemory = state.search.query
        state.search = undefined
        state.editor?.reset()
        if (state.editor !== undefined) state.editor.suggestEnabled = true
        state.selection = undefined
        draw(state, throttle)
        return
      }
      if (state.prompt !== undefined) {
        const p = state.prompt
        state.prompt = undefined
        if (state.editor !== undefined) state.editor.suggestEnabled = true
        state.editor?.reset()
        p.resolve('')
        draw(state, throttle)
        return
      }
      const current = currentView(state)
      if (current !== undefined && current.busy) { current.agent.cancel({ kind: 'user' }); addSystem(state, '(interrupting…)', throttle) }
    },
    onEof() { quit(0) },
    onChange() {
      // Search mode: the editor input is the query, recomputed live.
      if (state.search !== undefined) {
        state.search.query = editor.value
        state.search.matches = computeMatches(currentView(state), editor.value)
        state.search.current = 0
        jumpToMatch(state)
      }
      draw(state, throttle)
    },
    onSearch() {
      if (state.search !== undefined) {
        // Ctrl+F while open restarts the query empty.
        state.search.query = ''
        state.search.matches = []
        state.search.current = 0
        editor.fill('')
        draw(state, throttle)
        return
      }
      state.search = {
        query: state.searchMemory,
        matches: computeMatches(currentView(state), state.searchMemory),
        current: 0,
      }
      // The editor owns the query; suggest is off so '/' and '@' type literally.
      editor.suggestEnabled = false
      editor.fill(state.searchMemory)
      jumpToMatch(state)
      draw(state, throttle)
    },
    onPasteImage() { void pasteFromClipboard(state) },
    onSuggest: () => SLASH_COMMANDS,
    onSuggestFiles: () => {
      const cache = state.fileCache
      if (cache === undefined || cache.root !== process.cwd() || Date.now() - cache.at > 10_000) {
        const items: readonly SuggestItem[] = scanFiles(process.cwd()).map(path => ({ value: path }))
        state.fileCache = { root: process.cwd(), at: Date.now(), items }
      }
      return state.fileCache?.items ?? []
    },
    onSuggestArgs: (command, args, _current) => {
      if (command === 'model') {
        if (args.length === 0) {
          return (ctx.get('llm')?.listConfigurableProviders() ?? []).map(entry => ({ value: entry.provider, ...(entry.displayName === entry.provider ? {} : { description: entry.displayName }) }))
        }
        if (args.length === 1) {
          const provider = args[0] ?? ''
          const hit = state.modelArgsCache.get(provider)
          if (hit === undefined) {
            state.modelArgsCache.set(provider, [])
            void ctx.get('llm')?.listModels(provider).then((models) => {
              state.modelArgsCache.set(provider, models.map(m => ({ value: m.id, ...(m.name === m.id ? {} : { description: m.name }) })))
              state.editor?.refreshCompletions()
            }).catch(() => undefined)
            return []
          }
          return hit
        }
        if (args.length === 2) return REASONING_EFFORTS.map(effort => ({ value: effort }))
        return []
      }
      if (command === 'preset') {
        if (args.length > 0) return []
        const hit = state.presetArgsCache
        if (hit !== undefined) return hit
        void ctx.get('agentPresets')?.list().then((list) => {
          state.presetArgsCache = list.map(p => ({ value: p.id, ...(p.name === undefined ? {} : { description: p.name }) }))
          state.editor?.refreshCompletions()
        }).catch(() => undefined)
        return []
      }
      if (command === 'fork') {
        if (args.length > 0) return []
        const view = currentView(state)
        if (view === undefined) return []
        return listTurns(view.agent).map(t => ({ value: String(t.turn), ...(t.snippet === '' ? {} : { description: t.snippet }) }))
      }
      return []
    },
    onMousePress(col, row) {
      if (state.search !== undefined) { state.selection = undefined; draw(state, throttle); return }
      const rows = state.suggestRows
      if (rows !== undefined && row >= rows.start && row < rows.start + rows.count) {
        editor.applySuggestAt(row - rows.start)
        return
      }
      // Body zone (0-based screen row 2..2+bodyRows): a click on a code
      // block's top bar copies the block; otherwise it starts a selection.
      // Columns are 1-based SGR.
      const bodyRows = state.bodyRows ?? 0
      if (row - 1 >= 2 && row - 1 < 2 + bodyRows) {
        const code = extractCodeAt(state, row - 3)
        if (code !== undefined && code.trim() !== '') {
          state.selection = undefined
          void writeClipboardText(code).then((ok) => {
            addSystem(state, ok ? 'copied code block (' + String(code.length) + ' chars)' : 'clipboard write failed', throttle)
          })
          return
        }
        state.selection = { anchor: { row: row - 1, col: col - 1 }, focus: { row: row - 1, col: col - 1 } }
      } else {
        state.selection = undefined
      }
      draw(state, throttle)
    },
    onMouseMove(col, row) {
      if (state.selection === undefined) return
      state.selection.focus = { row: row - 1, col: col - 1 }
      draw(state, throttle)
    },
    onMouseUp() {
      // The box stays rendered until copied or dismissed (right-click copies).
    },
    onRightClick(_col, _row) {
      copySelection(state, (t) => { addSystem(state, t, throttle) })
    },
    onCopy() { copyLastReply(state, (t) => { addSystem(state, t, throttle) }) },
    onToggleReasoning() {
      state.showReasoning = !state.showReasoning
      state.renderCache.clear() // reasoning visibility changes every block's rows
      addSystem(state, 'thinking: ' + (state.showReasoning ? 'shown (Ctrl+T hides)' : 'hidden (Ctrl+T shows)'), throttle)
    },
    onCycleModel() { void cycleModel(ctx, state, (t) => { addSystem(state, t, throttle) }) },
    onCycleModelReverse() { void cycleModel(ctx, state, (t) => { addSystem(state, t, throttle) }, true) },
    onModelPicker() { void pickModel(ctx, state, (t) => { addSystem(state, t, throttle) }) },
    onExternalEditor() {
      // The external-editor hand-over swaps the whole terminal; refuse while a
      // modal prompt, search, or selection owns the screen (state would leak).
      if (state.prompt !== undefined || state.search !== undefined || state.selection !== undefined) {
        addSystem(state, 'close the current prompt/search before using the external editor (Ctrl+G)', throttle)
        return
      }
      openExternalEditor(state, throttle)
    },
    onToggleExpand() {
      state.expandTools = !state.expandTools
      state.renderCache.clear() // tool expansion changes every tool block's rows
      addSystem(state, state.expandTools ? 'tool output: expanded (Ctrl+O collapses)' : 'tool output: collapsed', throttle)
    },
    onShiftTab() {
      cycleEffort(ctx, state, (t) => { addSystem(state, t, throttle) })
    },
    onRecallPending() {
      const target = currentView(state)
      if (target === undefined || state.prompt !== undefined || target.pending.length === 0) return
      const all = target.pending.join('\n')
      target.pending = []
      editor.fill(all)
      addSystem(state, 'recalled the queue into the editor', throttle)
    },
    onScrollUp() {
      state.selection = undefined
      const current = currentView(state)
      if (current !== undefined) current.scroll += Math.max(1, term.height - 4)
      draw(state, throttle)
    },
    onScrollDown() {
      state.selection = undefined
      const current = currentView(state)
      if (current !== undefined) current.scroll = Math.max(0, current.scroll - Math.max(1, term.height - 4))
      draw(state, throttle)
    },
    // Wheel: a few lines per notch (unlike PageUp/PageDown's page step).
    onWheelUp() {
      state.selection = undefined
      const current = currentView(state)
      if (current !== undefined) current.scroll += 3
      draw(state, throttle)
    },
    onWheelDown() {
      state.selection = undefined
      const current = currentView(state)
      if (current !== undefined) current.scroll = Math.max(0, current.scroll - 3)
      draw(state, throttle)
    },
    // Modal picker menus consume the arrows; with no menu open the editor
    // falls back to its own history navigation.
    // Search mode: arrows move between matches; modal pickers consume them;
    // otherwise the editor falls back to its own history navigation.
    onArrowUp() {
      if (state.search !== undefined) { moveMatch(state, -1, throttle); return true }
      return navigatePromptMenu(state, -1)
    },
    onArrowDown() {
      if (state.search !== undefined) { moveMatch(state, 1, throttle); return true }
      return navigatePromptMenu(state, 1)
    },
    // Space in a multi-select modal menu toggles the highlighted row.
    onMenuToggle() {
      const prompt = state.prompt
      if (prompt === undefined || prompt.menu === undefined || !prompt.menu.multi) return false
      const idx = prompt.menu.index
      prompt.menu.checked[idx] = !(prompt.menu.checked[idx] === true)
      prompt.label = menuLabel(prompt.menu)
      state.term?.render(renderFrame(state))
      return true
    },
  })
  state.editor = editor
  editor.start()
}

/** Plain (non-TTY) path: line-stream text to stdout, read stdin via readline. */
function runPlain(config: Config, io: TuiIo, state: TuiState, view: SessionView, quit: (code: number) => void): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  rl.on('line', (line) => {
    const text = line.trim()
    if (text === '/exit' || text === '/quit') { quit(0); return }
    if (text.startsWith('/')) { io.stdout.write('dsh: commands are only available in a terminal (not piped)\n'); return }
    if (text !== '') { view.busy = true; view.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })) }
  })
  rl.on('SIGINT', () => {
    const current = currentView(state)
    if (current !== undefined && current.busy) current.agent.cancel({ kind: 'user' })
    else quit(0)
  })

  state.plainOut = io.stdout
  const initial = config.task
  if (initial !== undefined) {
    view.blocks.push({ kind: 'user', text: initial })
    view.busy = true
    view.agent.followup(createUserMessage({ content: [{ type: 'text', text: initial }], source: { kind: 'user' } }))
  }
  plainFlush(state)
}

/** Report an unexpected driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  io.stderr.write('dsh: ' + (error instanceof Error ? error.message : String(error)) + '\n')
  io.exit(1)
}

/**
 * Mount the interactive terminal driver. Listeners register synchronously so
 * they bind to this plugin's effect scope; the async driver shares state with
 * them through TuiState.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io: TuiIo = { stdout: process.stdout, stderr: process.stderr, exit }
  const state: TuiState = {
    views: new Map(), current: undefined, quitting: false,
    selectionRef: undefined, presetId: undefined, presetName: undefined, term: undefined,
    editor: undefined, prompt: undefined,
    plainOut: undefined, plainCursor: { block: 0, reasoning: 0, text: 0 },
    spinnerTimer: undefined, spinnerFrame: 0, expandTools: false, bell: true, contextWindow: undefined,
    suggestRows: undefined, fileCache: undefined, modelArgsCache: new Map(), presetArgsCache: undefined,
    autoApprove: new Set(),
    showReasoning: true, titles: new Map(),
    subagents: new Map(),
    renderCache: new Map(),
    search: undefined, searchMemory: '', blockStarts: [], idleInterruptAt: undefined,
    gitBranch: undefined,
    selection: undefined, bodyText: undefined, bodyRows: undefined,
  }
  const throttle: Throttle = { last: 0, timer: undefined }

  ctx.on('session/event', (session, event) => {
    const key = String(session.id)
    const view = state.views.get(key)
    if (state.quitting) return
    const isCurrent = state.current === key
    // A session that is not one of our views is a sub-agent (subagent tool /
    // dispatch_task child): fold a compact status line so multi-agent work is
    // visible instead of silent. Keyed by its own id; the parent view renders
    // the panel.
    if (view === undefined) {
      const header = session.header
      if (header.parentSession !== undefined) {
        const parentId = String(header.parentSession)
        const sv = state.subagents.get(key) ?? {
          parentId, busy: false, turnStartedAt: undefined, turns: 0,
          lastTool: undefined, lastOutput: undefined, finished: false,
        }
        sv.parentId = parentId
        switch (event.type) {
          case 'turn/start':
            sv.busy = true
            sv.turnStartedAt = Date.now()
            sv.finished = false
            break
          case 'turn/end':
            sv.busy = false
            sv.turns += 1
            sv.finished = true
            break
          case 'tool/call':
            sv.lastTool = event.data.name
            sv.lastOutput = undefined
            break
          case 'tool/result': {
            const text = toolResultText(event.data.message)
            if (text !== '') sv.lastOutput = text.slice(0, 120)
            break
          }
          case 'assistant/chunk': {
            const chunk = event.data.chunk
            if (chunk.type === 'text-delta') {
              sv.lastOutput = ((sv.lastOutput ?? '') + chunk.text).slice(0, 120)
            }
            break
          }
          default:
            break
        }
        state.subagents.set(key, sv)
        // Cap the panel so a long-running multi-agent session cannot grow it
        // without bound (oldest child drops first).
        if (state.subagents.size > 100) {
          const oldest = state.subagents.keys().next().value
          if (oldest !== undefined) state.subagents.delete(oldest)
        }
        // Repaint only when the current view is the parent (or we are viewing
        // a session whose children these are).
        if (isCurrent || (state.current !== undefined && parentId === state.current)) {
          draw(state, throttle)
        }
      }
      return
    }
    // Engine-extension event outside SessionEventMap (the compaction package's
    // declare-module patch is not importable here): fold the summary inline.
    if (event.type === 'compaction/summary' as never) {
      const data = (event as { data?: unknown }).data as { shadowedTokenCount?: number; summary?: unknown }
      const compacted = data.shadowedTokenCount ?? 0
      view.blocks.push({ kind: 'system', text: '⎘ context compacted' + (compacted > 0 ? ' (' + formatTokens(compacted) + ' tokens shadowed)' : '') })
      const summary = messageText(data.summary)
      if (summary !== '') view.blocks.push({ kind: 'assistant', text: summary })
      if (isCurrent) draw(state, throttle)
      return
    }
    switch (event.type) {
      case 'turn/start':
        view.busy = true
        view.turnStartedAt = Date.now()
        view.turnUsage = emptyUsage()
        view.streamUsage = undefined
        state.selection = undefined // a fresh turn shifts the body window
        if (isCurrent) {
          startSpinner(state, throttle)
          state.term?.setProgress(true)
        }
        break
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'reasoning-delta') { const b = ensureAssistant(view); b.reasoning = (b.reasoning ?? '') + chunk.text }
        else if (chunk.type === 'text-delta') { const b = ensureAssistant(view); b.text += chunk.text }
        else if (chunk.type === 'tool-call-delta') {
          // Stream the raw JSON arguments as they arrive (pi parity): create a
          // live tool block and grow its args; the settled tool/call event
          // replaces it with the authoritative block later.
          const callId = String(chunk.id)
          if (callId === '') break
          view.openAssistant = undefined
          const pending = findToolBlock(view, callId)
          if (pending === undefined) {
            view.blocks.push({ kind: 'tool', name: chunk.name ?? '', args: chunk.argumentsDelta, callId })
          } else {
            if (chunk.name !== undefined && chunk.name !== '') pending.name = chunk.name
            pending.args += chunk.argumentsDelta
          }
        }
        else if (chunk.type === 'usage') {
          // Adapters emit the request's RUNNING totals, not deltas: snapshot
          // (replace) them so the busy readout counts up live, and let
          // assistant/message settle the authoritative total afterwards.
          const usage = chunk.usage
          view.streamUsage = usage
          view.turnUsage = {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
          view.lastInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        }
        break
      }
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) {
          addUsage(view.usage, usage)
          // Message usage is the settled total for the step. It is NOT
          // additive with the chunk-level usage snapshots already displayed, so
          // turnUsage is replaced rather than accumulated; session totals still
          // accumulate once per message (unchanged).
          view.turnUsage = {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
          view.streamUsage = undefined
          view.lastInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        }
        break
      }
      case 'tool/call': {
        view.openAssistant = undefined
        const callId = String(event.data.callId)
        // If tool-call-delta streaming already created a live block, replace
        // its partial name/args with the settled authoritative values instead
        // of pushing a duplicate block.
        const pending = findToolBlock(view, callId)
        if (pending !== undefined) {
          pending.name = event.data.name
          pending.args = event.data.arguments
        } else {
          view.blocks.push({ kind: 'tool', name: event.data.name, args: event.data.arguments, callId })
        }
        break
      }
      case 'tool/result': {
        const callId = String(event.data.message.source.callId)
        const diffs = diffsFromMeta(event.data.meta)
        const block = findToolBlock(view, callId)
        if (block !== undefined) {
          if (diffs !== undefined) block.diffs = diffs
          else block.summary = toolResultText(event.data.message)
          // The tool block mutated; its memoized rows are stale.
          state.renderCache.delete(block)
        }
        break
      }
      case 'todo/write':
        view.todos = event.data.todos
        break
      case 'turn/end': {
        view.openAssistant = undefined
        view.busy = false
        view.turnStartedAt = undefined
        if (isCurrent && state.term === undefined) state.plainOut?.write('\n')
        const reason = event.data.reason
        if (reason.kind === 'error') view.blocks.push({ kind: 'system', text: 'error ' + reason.error.code + ': ' + reason.error.message })
        else if (reason.kind === 'aborted') view.blocks.push({ kind: 'system', text: '(interrupted)' })
        else if (reason.kind === 'max-tokens') view.blocks.push({ kind: 'system', text: '(max tokens reached)' })
        if (isCurrent) {
          stopSpinner(state)
          state.term?.setProgress(false)
          if (state.bell) state.term?.bell()
        }
        // Auto-send queued follow-ups (pi queue semantics), oldest first. The
        // flush is deferred to whenIdle: a followup fired synchronously from
        // inside the turn/end dispatch lands before the driver settles and its
        // wake is lost (PTY e2e #5 caught this).
        if (view.pending.length > 0) {
          void view.agent.whenIdle().then(() => {
            if (state.quitting || view.busy) return
            const next = view.pending.shift()
            if (next === undefined) return
            view.blocks.push({ kind: 'user', text: next })
            view.busy = true
            view.agent.followup(createUserMessage({ content: [{ type: 'text', text: next }], source: { kind: 'user' } }))
            if (state.current === key) draw(state, throttle)
          }).catch(() => undefined)
        }
        break
      }
      default:
        break
    }
    if (isCurrent) draw(state, throttle)
  })

  ctx.on('approval/request', (req, next) => {
    if (state.editor === undefined || state.quitting) return next()
    // Route the prompt to the owning session's view when it is tracked, so the
    // user answers with that session's transcript on screen; untracked agents
    // (sub-agents) are still labelled inside answerApproval.
    const ownerKey = String(req.agent.session.id)
    if (state.views.has(ownerKey) && state.current !== ownerKey) {
      closeSearch(state)
      state.current = ownerKey
      // Match the spinner/progress state to the view now on screen.
      if (state.views.get(ownerKey)?.busy === true) startSpinner(state, throttle)
      else stopSpinner(state)
      updateTitle(state)
      draw(state, throttle)
    }
    return answerApproval(state, req)
  })

  // Only register an interactive answerer when we have a terminal to ask on; a
  // piped (non-TTY) run leaves the questions answerer absent so the model fails closed.
  if (process.stdout.isTTY) ctx.userQuestions.registerProvider({ ask: request => answerQuestions(state, request) })

  void run(ctx, config, io, state, throttle).catch((error: unknown) => { fail(io, error) })
}
