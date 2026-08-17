/**
 * Raw-mode line editor: readline replacement with cursor movement, editing
 * keys, history, and interrupt handling. Owns stdin raw mode; the caller owns
 * the visual rendering and reads value/cursor to place the prompt.
 *
 * Shift+Enter inserts a newline (pi parity). Detecting it needs terminal
 * cooperation, so start() negotiates the Kitty keyboard protocol
 * (`CSI >1u` push + `CSI ?u` query + a device-attributes sentinel) and falls
 * back to xterm modifyOtherKeys (`CSI >4;2m`) when the terminal answers the
 * DA query but not the Kitty flags query. Recognized Shift+Enter encodings:
 *   - `\x1b[13;2u`        Kitty CSI-u (also keypad enter `\x1b[57414;2u`)
 *   - `\x1b[27;2;13~`     xterm modifyOtherKeys
 *   - `\x1b\r` / bare `\n` once Kitty is active (Kitty/Ghostty custom mappings)
 * Terminals with neither protocol (plain conhost) cannot tell Shift+Enter from
 * Enter; there Alt+Enter (`\x1b\r`) keeps working as the newline fallback.
 *
 * Bracketed paste (`\x1b[?2004h`) wraps pasted text in `\x1b[200~` … `\x1b[201~`
 * so a multi-line paste becomes multi-line input instead of an early submit;
 * a large paste collapses into an atomic `[paste #N +lines / chars]` marker
 * (payload expands on submit). Ctrl+V / Alt+V triggers the image-paste
 * shortcut (the caller reads the system clipboard).
 *
 * @module @deepseek-ai/dsh-tui/editor
 */

export interface EditorCallbacks {
  /** A non-empty line was submitted. */
  onSubmit(text: string): void
  /** Ctrl+C. The caller decides interrupt-vs-quit from busy state. */
  onInterrupt(): void
  /** Ctrl+D on an empty line (EOF). */
  onEof(): void
  /** The value or cursor moved; a repaint is wanted. */
  onChange(): void
  /** Scroll the conversation up (PageUp / Ctrl+Up). */
  onScrollUp?(): void
  /** Scroll the conversation down (PageDown / Ctrl+Down). */
  onScrollDown?(): void
  /** Mouse wheel up: scroll the conversation up (small step, unlike PageUp). */
  onWheelUp?(): void
  /** Mouse wheel down: scroll the conversation down (small step, unlike PageDown). */
  onWheelDown?(): void
  /**
   * Ctrl+V / Alt+V image-paste shortcut (pi parity: win32 = Alt+V since the
   * terminal owns Ctrl+V for text; the caller owns the async clipboard read
   * and feeds any text back through pasteText).
   */
  onPasteImage?(): void
  /**
   * Slash-command catalog for the autocomplete dropdown. The editor fuzzy-
   * filters it (case-insensitive subsequence, then a typo-tolerant edit-
   * distance fallback) whenever the input starts with '/' and holds no
   * whitespace before the cursor.
   */
  onSuggest?(): readonly SuggestItem[]
  /**
   * Argument completions for '/cmd …|': `command` is the lowercased command
   * word, `args` the completed arguments, `current` the partial one being
   * typed. Return [] (or undefined) to keep the dropdown closed.
   */
  onSuggestArgs?(command: string, args: readonly string[], current: string): readonly SuggestItem[]
  /** File-path completions after an '@' token (editor fuzzy-filters on top). */
  onSuggestFiles?(prefix: string): readonly SuggestItem[]
  /** Ctrl+O: toggle full tool-output rendering (caller owns the flag). */
  onToggleExpand?(): void
  /** Shift+Tab: cycle the reasoning effort (caller owns the selection). */
  onShiftTab?(): void
  /** Alt+Up: recall queued follow-ups into the editor (caller owns the queue). */
  onRecallPending?(): void
  /** SGR mouse press: 1-based col/row (reporting is always on; the caller only acts while a dropdown is open). */
  onMousePress?(col: number, row: number): void
  /** Ctrl+X: copy the last reply to the clipboard (caller owns it). */
  onCopy?(): void
  /** Ctrl+G: open the external editor (caller owns the terminal hand-over). */
  onExternalEditor?(): void
}

/** One slash-command suggestion row. */
export interface SuggestItem {
  /** Command name without the leading slash, e.g. 'model'. */
  value: string
  description?: string
}

/**
 * Subsequence match score, lower is better (undefined = no match). Exact and
 * prefix matches rank highest; gaps between matched characters are penalized.
 */
function fuzzyScore(query: string, value: string): number | undefined {
  const q = query.toLowerCase()
  const t = value.toLowerCase()
  if (q === '') return 0
  if (q === t) return -100
  if (t.startsWith(q)) return -50 + (t.length - q.length) * 0.1
  let qi = 0
  let score = 0
  let last = -2
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      score += i === last + 1 ? -5 : i
      last = i
      qi += 1
    }
  }
  return qi === q.length ? score + 10 : undefined
}

/** Edit distance with a hard cap (returns cap+1 once exceeded); drives typo tolerance like /molde → /model. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      curr.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > cap) return cap + 1
    prev = curr
  }
  return prev[b.length] ?? cap + 1
}

/** How long an incomplete escape sequence waits for its remaining bytes. */
const STASH_TIMEOUT_MS = 25

/** A paste collapses into a marker above this many lines or characters (pi parity). */
const PASTE_COLLAPSE_LINES = 10
const PASTE_COLLAPSE_CHARS = 1000

/** Matches collapsed paste markers anywhere in the value: `[paste #1 +12 lines]` / `[paste #2 1001 chars]`. */
const PASTE_MARKER_GLOBAL = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g
/** Matches one marker ending exactly at the string's end (atomic backspace / left-move). */
const PASTE_MARKER_AT_END = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/
/** Matches one marker starting exactly at the string's start (atomic right-move). */
const PASTE_MARKER_AT_START = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/

/** What the dropdown is completing and where the token starts. */
export interface SuggestState {
  items: readonly SuggestItem[]
  index: number
  /** Offset in `value` where the completable token starts ('/' for slash, the '@' for files). */
  start: number
  kind: 'slash' | 'arg' | 'file'
}

export class LineEditor {
  value = ''
  cursor = 0
  history: string[] = []
  /** Slash-command dropdown state, refreshed on every keystroke (read by the renderer). */
  suggest: SuggestState | undefined
  /** Master switch for the dropdown (the caller disables it while a modal prompt owns the input). */
  suggestEnabled = true
  /** Set by an explicit Esc-close; the next non-Esc keystroke clears it (re-arms auto-open). */
  private suggestDismissed = false
  /** Set by Tab/Enter/click applies: the trailing refresh must not instantly reopen the dropdown. */
  private suggestJustApplied = false
  /** SGR mouse reporting is enabled only while the dropdown is open. */
  private mouseActive = false
  /** Undo snapshots (value + cursor), capped; coalesced per pi's typing rules. */
  private readonly undoStack: Array<{ value: string; cursor: number }> = []
  private lastAction: string | undefined
  /** Kill ring: most-recent-first; consecutive Ctrl+K kills chain into the top entry. */
  private readonly killRing: string[] = []
  private killChain = false
  private histIndex = -1
  private saved = ''
  private readonly stdin: NodeJS.ReadStream
  private readonly stdout: { write(chunk: string): unknown }
  private readonly callbacks: EditorCallbacks
  private started = false
  /** Kitty keyboard protocol state: negotiated active / we pushed flags. */
  private kittyActive = false
  private kittyPushed = false
  /** xterm modifyOtherKeys fallback enabled. */
  private modifyOtherKeys = false
  /** Inside a bracketed paste (`\x1b[200~` seen, `\x1b[201~` pending). */
  private pasting = false
  /** Payloads behind collapsed paste markers, keyed by marker id. */
  private readonly pastes = new Map<number, string>()
  private pasteCounter = 0
  /** Raw bracketed-paste bytes accumulated until the end marker arrives. */
  private pasteBuffer = ''
  /** Incomplete escape sequence carried over to the next chunk. */
  private stash = ''
  private stashTimer: ReturnType<typeof setTimeout> | undefined
  private readonly dataHandler = (chunk: Buffer): void => { this.handleData(chunk.toString()) }

  constructor(
    callbacks: EditorCallbacks,
    stdin: NodeJS.ReadStream = process.stdin,
    stdout: { write(chunk: string): unknown } = process.stdout,
  ) {
    this.callbacks = callbacks
    this.stdin = stdin
    this.stdout = stdout
  }

  /** Enter raw mode and start reading keystrokes. */
  start(): void {
    if (this.started) return
    this.started = true
    if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on('data', this.dataHandler)
    // Bracketed paste on; Kitty push + query + DA sentinel (see module docs).
    // SGR mouse reporting is on for the whole session: the wheel scrolls the
    // transcript and clicks drive the dropdown from anywhere (Shift+drag still
    // selects text in Windows Terminal / WezTerm / kitty).
    this.kittyPushed = true
    this.mouseActive = true
    this.stdout.write('\x1b[?1000h\x1b[?1006h' + '\x1b[?2004h' + '\x1b[>1u' + '\x1b[?u' + '\x1b[c')
  }

  /** Restore raw mode and stop reading. */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.stdin.off('data', this.dataHandler)
    this.clearStashTimer()
    this.stash = ''
    this.pasting = false
    this.pasteBuffer = ''
    if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') this.stdin.setRawMode(false)
    this.stdin.pause()
    // Unwind terminal modes in reverse order: Kitty flags pop, modifyOtherKeys
    // off, bracketed paste off.
    let out = ''
    if (this.kittyPushed) { out += '\x1b[<u'; this.kittyPushed = false }
    if (this.modifyOtherKeys) { out += '\x1b[>4;0m'; this.modifyOtherKeys = false }
    this.kittyActive = false
    if (this.mouseActive) { out += '\x1b[?1006l\x1b[?1000l'; this.mouseActive = false }
    out += '\x1b[?2004l'
    this.stdout.write(out)
  }

  /** Reset the editor for a fresh prompt. */
  reset(): void {
    this.value = ''
    this.cursor = 0
    this.histIndex = -1
    this.saved = ''
  }

  /** Replace the input wholesale (queue recall / external editor hand-back). One undo step. */
  fill(text: string): void {
    this.pushUndo()
    this.lastAction = 'other'
    this.killChain = false
    this.value = text
    this.cursor = text.length
    this.callbacks.onChange()
  }

  private handleData(text: string, final = false): void {
    const input = this.stash + text
    this.stash = ''
    this.clearStashTimer()
    // Any real keystroke re-arms the dropdown's auto-open after an Esc-close.
    if (input !== '\x1b') this.suggestDismissed = false
    let i = 0
    while (i < input.length) {
      // Bracketed paste: buffer everything until the end marker, then run the
      // paste pipeline once (the collapse decision needs the whole payload).
      if (this.pasting) {
        const end = input.indexOf('\x1b[201~', i)
        this.pasteBuffer += end === -1 ? input.slice(i) : input.slice(i, end)
        this.pasting = end === -1
        i = end === -1 ? input.length : end + '\x1b[201~'.length
        if (!this.pasting) {
          const content = this.pasteBuffer
          this.pasteBuffer = ''
          this.pasteText(content)
        }
        continue
      }
      const ch = input[i] ?? ''
      if (ch === '\x1b' && (input[i + 1] === '\r' || input[i + 1] === '\n')) {
        // Alt+Enter (also Kitty's/Ghostty's shift+enter send_text mapping).
        this.insert('\n')
        i += 2
        continue
      }
      if (ch === '\x1b' && (input[i + 1] === 'v' || input[i + 1] === 'V')) {
        // Alt+V: image-paste shortcut (win32 default in pi).
        this.callbacks.onPasteImage?.()
        i += 2
        continue
      }
      if (ch === '\x1b') {
        const seq = this.readEscape(input, i, final)
        if (seq === undefined) {
          // Incomplete escape at the end of the chunk: wait for more bytes.
          this.stash = input.slice(i)
          this.scheduleStashFlush()
          return
        }
        i += seq.length
        this.applyEscape(seq)
        continue
      }
      if (ch === '\r') {
        // Dropdown open: Enter applies the highlight. Slash commands then fall
        // through to submit (pi parity); arg/file completions stop there.
        const open = this.suggest
        if (open !== undefined) {
          const kind = open.kind
          this.applySuggest()
          if (kind !== 'slash') { i += 1; continue }
        }
        this.submit()
        i += 1
        continue
      }
      if (ch === '\n') {
        // Bare LF is Ghostty's shift+enter mapping once Kitty is active;
        // without the protocol it is an ordinary submit (also Ctrl+J).
        if (this.kittyActive) this.insert('\n')
        else this.submit()
        i += 1
        continue
      }
      if (ch === '\t') {
        // Tab applies the highlighted completion (no submit); closed + a
        // '/' prefix opens the dropdown; otherwise a no-op.
        if (this.suggest !== undefined) this.applySuggest()
        else if (this.value.startsWith('/') && this.suggestEnabled) this.refreshSuggest()
        i += 1
        continue
      }
      if (ch === '\x03') { this.callbacks.onInterrupt(); i += 1; continue }
      if (ch === '\x04') {
        if (this.value.length === 0) { this.callbacks.onEof() }
        else { this.deleteForward() }
        i += 1
        continue
      }
      if (ch === '\x7f' || ch === '\x08') { this.deleteBackward(); i += 1; continue }
      if (ch === '\x01') { this.moveHome(); i += 1; continue }
      if (ch === '\x05') { this.moveEnd(); i += 1; continue }
      if (ch === '\x0b') { this.killToEnd(); i += 1; continue }
      if (ch === '\x15') { this.killChain = false; this.kill(this.value); this.pushUndo(); this.lastAction = 'other'; this.value = ''; this.cursor = 0; this.pastes.clear(); this.pasteCounter = 0; this.callbacks.onChange(); i += 1; continue }
      if (ch === '\x16') { this.callbacks.onPasteImage?.(); i += 1; continue }
      if (ch === '\x17') { this.deleteWordBackward(); i += 1; continue }
      if (ch === '\x0c') { this.callbacks.onChange(); i += 1; continue }
      if (ch === '\x0f') { this.callbacks.onToggleExpand?.(); i += 1; continue }
      if (ch === '\x07') { this.callbacks.onExternalEditor?.(); i += 1; continue }
      if (ch === '\x18') { this.callbacks.onCopy?.(); i += 1; continue }
      if (ch === '\x19') { this.yank(); i += 1; continue }
      if (ch === '\x1a') { this.undo(); i += 1; continue }
      // Printable character (also covers pasted multi-byte text).
      this.insert(ch)
      i += 1
    }
    if (this.suggestJustApplied) { this.suggestJustApplied = false } else { this.refreshSuggest() }
  }

  /** Recompute the dropdown against the text before the cursor (slash / arg / file modes). */
  private refreshSuggest(): void {
    if (!this.suggestEnabled || this.suggestDismissed) { this.setSuggest(undefined); return }
    const before = this.value.slice(0, this.cursor)
    let items: readonly SuggestItem[] | undefined
    let start = 0
    let kind: SuggestState['kind'] = 'slash'
    let query = ''
    if (before.startsWith('/') && !/\s/.test(before)) {
      // Slash mode: '/mod|' completes the command name.
      query = before.slice(1)
      items = this.callbacks.onSuggest?.()
    } else if (before.startsWith('/') && !before.includes('\n')) {
      // Arg mode: '/model deepseek-|' completes the current argument.
      const m = /^\/(\S+) +(.*)$/.exec(before)
      if (m !== null && this.callbacks.onSuggestArgs !== undefined) {
        const argText = m[2] ?? ''
        const parts = argText.split(/ +/)
        const current = parts[parts.length - 1] ?? ''
        query = current
        start = before.length - current.length
        kind = 'arg'
        items = this.callbacks.onSuggestArgs((m[1] ?? '').toLowerCase(), parts.slice(0, -1), current)
      }
    }
    if (items === undefined) {
      // File mode: an '@' token at a word boundary completes file paths.
      const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
      if (at !== null && this.callbacks.onSuggestFiles !== undefined) {
        query = at[1] ?? ''
        start = before.length - query.length - 1 // points at the '@' itself
        kind = 'file'
        items = this.callbacks.onSuggestFiles(query)
      }
    }
    if (items === undefined || items.length === 0) { this.setSuggest(undefined); return }
    const scored: Array<{ item: SuggestItem; score: number }> = []
    for (const item of items) {
      const score = fuzzyScore(query, item.value)
      if (score !== undefined) scored.push({ item, score })
    }
    if (scored.length === 0 && query !== '') {
      // Typo tolerance: /molde still offers /model (edit distance ≤ 2, ranked last).
      for (const item of items) {
        const distance = editDistance(query, item.value, 2)
        if (distance <= 2) scored.push({ item, score: 100 + distance })
      }
    }
    if (scored.length === 0) { this.setSuggest(undefined); return }
    scored.sort((a, b) => a.score - b.score)
    const filtered = scored.map(s => s.item)
    // Keep the highlight on the same entry across refilters when possible.
    const current = this.suggest?.items[this.suggest.index]?.value
    const kept = current === undefined ? -1 : filtered.findIndex(item => item.value === current)
    this.setSuggest({ items: filtered, index: kept === -1 ? 0 : kept, start, kind })
  }

  /** Update the dropdown, toggling mouse reporting on open/close transitions. */
  private setSuggest(next: SuggestState | undefined): void {
    const wasOpen = this.suggest !== undefined
    this.suggest = next
    const isOpen = next !== undefined
    if (isOpen !== wasOpen) {
      // Mouse reporting stays on for the whole session (wheel scrolls everywhere);
      // the renderer still needs repainting on an open/close so the keystroke's
      // own onChange (which can fire before refreshSuggest runs) can't strand the
      // screen on the pre-dropdown frame.
      this.callbacks.onChange()
    }
  }

  /** Fill the highlighted item into the input and close the dropdown. */
  private applySuggest(): void {
    const s = this.suggest
    const item = s?.items[s.index]
    if (s === undefined || item === undefined) { this.setSuggest(undefined); return }
    this.pushUndo()
    this.lastAction = 'other'
    let insert = item.value
    if (s.kind === 'slash') insert = '/' + item.value + ' '
    else {
      if (/ /.test(insert)) insert = '"' + insert + '"'
      if (!insert.endsWith('/')) insert += ' '
    }
    this.value = this.value.slice(0, s.start) + insert + this.value.slice(this.cursor)
    this.cursor = s.start + insert.length
    this.suggestJustApplied = true
    this.setSuggest(undefined)
    this.callbacks.onChange()
  }

  /** Apply the dropdown item at `index` (mouse click). */
  applySuggestAt(index: number): void {
    const s = this.suggest
    if (s === undefined || index < 0 || index >= s.items.length) return
    this.suggest = { ...s, index }
    this.applySuggest()
  }

  /** Re-run completion filtering (async catalog fills call this). */
  refreshCompletions(): void {
    this.refreshSuggest()
    this.callbacks.onChange()
  }

  /** Move the dropdown highlight, wrapping at both ends. */
  private moveSuggest(delta: number): void {
    const s = this.suggest
    if (s === undefined || s.items.length === 0) return
    const n = s.items.length
    this.suggest = { ...s, index: ((s.index + delta) % n + n) % n }
    this.callbacks.onChange()
  }

  /** Read an escape sequence starting at text[index]; undefined = incomplete tail. */
  private readEscape(text: string, index: number, final: boolean): string | undefined {
    const rest = text.slice(index)
    // CSI: ESC [ … final byte in @-~ (params include < = > ? for SGR mouse/kitty).
    const csi = /^\x1b\[[0-9;:<=>?]*[a-zA-Z~]/.exec(rest)
    if (csi?.[0] !== undefined) return csi[0]
    const ss3 = /^\x1bO[a-zA-Z]/.exec(rest)
    if (ss3?.[0] !== undefined) return ss3[0]
    if (!final) {
      // A possible sequence prefix that runs to the end of the chunk (also a
      // trailing lone ESC, which could begin a split sequence) waits for more.
      if (/^\x1b\[[0-9;:<=>?]*$/.test(rest) || /^\x1bO$/.test(rest) || rest === '\x1b') return undefined
    }
    // Lone ESC or unknown — consume just it.
    return '\x1b'
  }

  private applyEscape(seq: string): void {
    // Kitty flags answer: nonzero means the protocol is now active; zero means
    // the terminal knows the query but grants nothing — fall back.
    const kitty = /^\x1b\[\?(\d+)u$/.exec(seq)
    if (kitty !== null) {
      if (Number(kitty[1] ?? '0') !== 0) this.kittyActive = true
      else this.enableModifyOtherKeys()
      return
    }
    // Primary device-attributes answer: the DA sentinel came back without a
    // Kitty flags answer, so the terminal speaks no Kitty — fall back.
    if (/^\x1b\[\?[\d;]*c$/.test(seq)) {
      if (!this.kittyActive) this.enableModifyOtherKeys()
      return
    }
    // SGR mouse: \x1b[<<btn>;<col>;<row>M (press) / m (release). Left press goes
    // to the dropdown; the wheel scrolls the transcript (reporting is always on).
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq)
    if (mouse !== null) {
      if (mouse[4] === 'M') {
        const btn = Number(mouse[1] ?? '0')
        if (btn === 0) this.callbacks.onMousePress?.(Number(mouse[2] ?? '0'), Number(mouse[3] ?? '0'))
        else if (btn === 64) (this.callbacks.onWheelUp ?? this.callbacks.onScrollUp)?.()
        else if (btn === 65) (this.callbacks.onWheelDown ?? this.callbacks.onScrollDown)?.()
      }
      return
    }
    switch (seq) {
      case '\x1b[200~': this.pasting = true; return
      case '\x1b[201~': this.pasting = false; return
      // Shift+Enter: Kitty CSI-u (main + keypad) and modifyOtherKeys.
      case '\x1b[13;2u': case '\x1b[57414;2u': case '\x1b[27;2;13~': this.insert('\n'); return
      // Shift+Tab: plain reverse-tab CSI and modifyOtherKeys (shift+tab 9).
      case '\x1b[Z': case '\x1b[27;2;9~': this.callbacks.onShiftTab?.(); return
      case '\x1b[A':
        if (this.suggest !== undefined) { this.moveSuggest(-1); return }
        this.historyUp(); return
      case '\x1b[B':
        if (this.suggest !== undefined) { this.moveSuggest(1); return }
        this.historyDown(); return
      case '\x1b[C': this.moveRight(); return
      case '\x1b[D': this.moveLeft(); return
      case '\x1b':
        // Lone ESC closes the dropdown first; a second ESC is ignored.
        if (this.suggest !== undefined) { this.suggestDismissed = true; this.setSuggest(undefined); this.callbacks.onChange() }
        return
      case '\x1b[H': case '\x1b[1~': case '\x1bOH': this.moveHome(); return
      case '\x1b[F': case '\x1b[4~': case '\x1bOF': this.moveEnd(); return
      case '\x1b[3~': this.deleteForward(); return
      case '\x1b[5~': case '\x1b[1;5A': this.callbacks.onScrollUp?.(); return
      case '\x1b[6~': case '\x1b[1;5B': this.callbacks.onScrollDown?.(); return
      case '\x1b[1;3A': this.callbacks.onRecallPending?.(); return
      default: return
    }
  }

  /** Enable the modifyOtherKeys fallback (Shift+Enter arrives as CSI 27;2;13~). */
  private enableModifyOtherKeys(): void {
    if (this.kittyActive || this.modifyOtherKeys) return
    this.modifyOtherKeys = true
    this.stdout.write('\x1b[>4;2m')
  }

  private scheduleStashFlush(): void {
    this.clearStashTimer()
    this.stashTimer = setTimeout(() => {
      this.stashTimer = undefined
      const pending = this.stash
      this.stash = ''
      if (pending !== '') this.handleData(pending, true)
    }, STASH_TIMEOUT_MS)
    this.stashTimer.unref()
  }

  private clearStashTimer(): void {
    if (this.stashTimer === undefined) return
    clearTimeout(this.stashTimer)
    this.stashTimer = undefined
  }

  /** Submit the current value when it is non-blank (history + reset). Markers expand first. */
  private submit(): void {
    if (this.value.trim() !== '') {
      const text0 = this.expandMarkers(this.value)
      if (this.history.at(-1) !== this.value) this.history.push(this.value)
      this.pastes.clear()
      this.pasteCounter = 0
      this.undoStack.length = 0
      this.lastAction = undefined
      this.killChain = false
      this.reset()
      this.callbacks.onSubmit(text0)
    } else {
      this.callbacks.onChange()
    }
  }

  /**
   * Paste pipeline shared by bracketed paste and the clipboard-text fallback:
   * strip control bytes (tabs to spaces), then collapse a large paste into an
   * atomic `[paste #N …]` marker whose payload lives in `pastes` (pi parity:
   * >10 lines or >1000 chars).
   */
  pasteText(raw: string): void {
    const clean = raw.replace(/\x1b/g, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    // Code-point iteration keeps astral chars whole while dropping control bytes.
    let filtered = ''
    for (const c of clean) { if (c === '\n' || (c >= ' ' && c !== '\x7f')) filtered += c }
    if (filtered === '') return
    const lines = filtered.split('\n')
    if (lines.length > PASTE_COLLAPSE_LINES || filtered.length > PASTE_COLLAPSE_CHARS) {
      this.pasteCounter += 1
      const id = this.pasteCounter
      this.pastes.set(id, filtered)
      this.insert(lines.length > PASTE_COLLAPSE_LINES ? `[paste #${id} +${lines.length} lines]` : `[paste #${id} ${filtered.length} chars]`)
      return
    }
    this.insert(filtered)
  }

  /** Replace collapsed paste markers with their stored payloads (dead markers stay literal). */
  private expandMarkers(text: string): string {
    return text.replace(PASTE_MARKER_GLOBAL, (marker, id: string) => this.pastes.get(Number(id)) ?? marker)
  }

  /** Push an undo snapshot of the current value/cursor (cap 100). */
  private pushUndo(): void {
    this.undoStack.push({ value: this.value, cursor: this.cursor })
    if (this.undoStack.length > 100) this.undoStack.shift()
  }

  /** Ctrl+Z: restore the previous snapshot. */
  private undo(): void {
    const snap = this.undoStack.pop()
    if (snap === undefined) return
    this.value = snap.value
    this.cursor = snap.cursor
    this.lastAction = undefined
    this.killChain = false
    this.callbacks.onChange()
  }

  /** Kill-ring push; consecutive Ctrl+K kills chain into the top entry. */
  private kill(text: string): void {
    if (text === '') return
    if (this.killChain && this.killRing.length > 0) this.killRing[0] = (this.killRing[0] ?? '') + text
    else this.killRing.unshift(text)
    if (this.killRing.length > 20) this.killRing.pop()
    this.killChain = true
  }

  /** Ctrl+Y: yank the kill-ring top into the input. */
  private yank(): void {
    const top = this.killRing[0]
    if (top === undefined || top === '') return
    this.pushUndo()
    this.lastAction = 'other'
    this.killChain = false
    this.insertText(top)
  }

  private insert(ch: string): void {
    // pi-style undo coalescing: one snapshot per word of typing; a whitespace
    // char always snapshots; multi-char inserts (paste/yank) are their own step.
    if (ch.length === 1) {
      if (/\s/.test(ch) || this.lastAction !== 'type') this.pushUndo()
      this.lastAction = 'type'
    } else {
      this.pushUndo()
      this.lastAction = 'other'
    }
    this.killChain = false
    this.insertText(ch)
  }

  /** Raw insert with no undo/kill bookkeeping (the callers above own that). */
  private insertText(ch: string): void {
    this.value = this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor)
    this.cursor += ch.length
    this.callbacks.onChange()
  }

  private deleteBackward(): void {
    if (this.cursor <= 0) return
    if (this.lastAction !== 'delete') this.pushUndo()
    this.lastAction = 'delete'
    this.killChain = false
    const before = this.value.slice(0, this.cursor)
    const marker = PASTE_MARKER_AT_END.exec(before)
    if (marker !== null) {
      // Markers are atomic: one backspace removes the whole marker and its payload.
      this.pastes.delete(Number(marker[1] ?? '0'))
      this.value = before.slice(0, before.length - marker[0].length) + this.value.slice(this.cursor)
      this.cursor -= marker[0].length
      this.callbacks.onChange()
      return
    }
    const ch = this.value[this.cursor - 1] ?? ''
    const width = this.cursor - ch.length
    this.value = this.value.slice(0, width) + this.value.slice(this.cursor)
    this.cursor = width
    this.callbacks.onChange()
  }

  private deleteForward(): void {
    if (this.cursor >= this.value.length) return
    if (this.lastAction !== 'delete') this.pushUndo()
    this.lastAction = 'delete'
    this.killChain = false
    const ch = this.value[this.cursor] ?? ''
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + ch.length)
    this.callbacks.onChange()
  }

  private moveLeft(): void {
    if (this.cursor <= 0) return
    const marker = PASTE_MARKER_AT_END.exec(this.value.slice(0, this.cursor))
    if (marker !== null) { this.cursor -= marker[0].length }
    else { this.cursor -= (this.value[this.cursor - 1] ?? '').length }
    this.callbacks.onChange()
  }

  private moveRight(): void {
    if (this.cursor >= this.value.length) return
    const marker = PASTE_MARKER_AT_START.exec(this.value.slice(this.cursor))
    if (marker !== null) { this.cursor += marker[0].length }
    else { this.cursor += (this.value[this.cursor] ?? '').length }
    this.callbacks.onChange()
  }

  private moveHome(): void { this.cursor = 0; this.callbacks.onChange() }

  private moveEnd(): void { this.cursor = this.value.length; this.callbacks.onChange() }

  private killToEnd(): void {
    const killed = this.value.slice(this.cursor)
    if (killed === '') return
    this.pushUndo()
    this.lastAction = 'other'
    this.kill(killed)
    this.value = this.value.slice(0, this.cursor)
    this.callbacks.onChange()
  }

  private deleteWordBackward(): void {
    const before = this.value.slice(0, this.cursor)
    // Never carve through a marker: word-delete at its edge removes it whole.
    if (PASTE_MARKER_AT_END.test(before)) { this.deleteBackward(); return }
    const trimmed = before.replace(/\s+\S*$/, '')
    if (trimmed === before) return
    this.pushUndo()
    this.lastAction = 'other'
    this.killChain = false
    this.kill(before.slice(trimmed.length))
    this.value = trimmed + this.value.slice(this.cursor)
    this.cursor = trimmed.length
    this.callbacks.onChange()
  }

  private historyUp(): void {
    if (this.history.length === 0) return
    if (this.histIndex === -1) { this.saved = this.value }
    if (this.histIndex < this.history.length - 1) this.histIndex += 1
    this.value = this.history[this.history.length - 1 - this.histIndex] ?? ''
    this.cursor = this.value.length
    this.callbacks.onChange()
  }

  private historyDown(): void {
    if (this.histIndex === -1) return
    if (this.histIndex > 0) { this.histIndex -= 1; this.value = this.history[this.history.length - 1 - this.histIndex] ?? '' }
    else { this.histIndex = -1; this.value = this.saved }
    this.cursor = this.value.length
    this.callbacks.onChange()
  }
}
