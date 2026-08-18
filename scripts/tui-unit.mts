// Offline unit checks for the dsh-tui presentation layer (no engine needed).
// Run: node --experimental-strip-types /tmp/tui-unit.mts   (Node 23.6+ strips by default)
import { EventEmitter } from 'node:events'
import { LineEditor } from '../packages/bundle/tui/src/editor.ts'
import { renderMarkdown } from '../packages/bundle/tui/src/markdown.ts'
import { Term, inverseRange, sliceVisible, wrappedCursor } from '../packages/bundle/tui/src/term.ts'
import { addUsage, billedInput, emptyUsage, formatTokens } from '../packages/bundle/tui/src/usage.ts'
import { readClipboardText, writeClipboardText } from '../packages/bundle/tui/src/clipboard.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log('ok   ' + name) } else { failed++; console.log('FAIL ' + name) }
}

interface Rig { editor: InstanceType<typeof LineEditor>; stdin: EventEmitter & { isTTY: boolean; resume(): void; pause(): void }; written: string[]; submitted: string[] }
function makeEditor(withSuggest = false): Rig {
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const written: string[] = []
  const submitted: string[] = []
  const stdout = { write(chunk: string) { written.push(chunk); return true } }
  const catalog = [
    { value: 'help', description: 'h' }, { value: 'model', description: 'm' },
    { value: 'preset', description: 'p' }, { value: 'fork', description: 'f' },
    { value: 'sessions', description: 's' }, { value: 'exit', description: 'e' },
  ] as const
  const editor = new LineEditor({
    onSubmit: (t: string) => { submitted.push(t) },
    onInterrupt() {}, onEof() {}, onChange() {},
    ...(withSuggest ? { onSuggest: () => catalog } : {}),
  }, stdin as never, stdout)
  return { editor, stdin: stdin as Rig['stdin'], written, submitted }
}
function feed(rig: Rig, text: string): void { rig.stdin.emit('data', Buffer.from(text)) }

// 1. startup negotiation bytes
{
  const rig = makeEditor()
  rig.editor.start()
  const boot = rig.written.join('')
  check('start writes bracketed-paste + kitty push + query + DA', boot.includes('\x1b[?2004h') && boot.includes('\x1b[>1u') && boot.includes('\x1b[?u') && boot.includes('\x1b[c'))
  rig.editor.stop()
  const down = rig.written.join('')
  check('stop pops kitty + disables paste', down.includes('\x1b[<u') && down.includes('\x1b[?2004l'))
}

// 2. kitty shift+enter
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, '\x1b[?1u') // kitty flags answer → active
  feed(rig, 'ab')
  feed(rig, '\x1b[13;2u') // shift+enter
  feed(rig, 'cd')
  check('kitty CSI 13;2u inserts newline', rig.editor.value === 'ab\ncd')
  feed(rig, '\n') // bare LF = ghostty shift+enter once kitty active
  check('kitty-active bare LF inserts newline', rig.editor.value === 'ab\ncd\n')
  feed(rig, 'x')
  feed(rig, '\r') // CR still submits
  check('kitty-active CR submits full text', rig.submitted.length === 1 && rig.submitted[0] === 'ab\ncd\nx')
  check('negotiation response not inserted as text', !rig.editor.value.includes('[?'))
}

// 2b. shift+tab fires onShiftTab (plain CSI reverse-tab + modifyOtherKeys)
{
  let hits = 0
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const written: string[] = []
  const stdout = { write(chunk: string) { written.push(chunk); return true } }
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {}, onShiftTab: () => { hits++ },
  }, stdin as never, stdout)
  editor.start()
  feed({ editor, stdin: stdin as never, written, submitted: [] }, '\x1b[Z')
  check('CSI Z fires onShiftTab', hits === 1)
  feed({ editor, stdin: stdin as never, written, submitted: [] }, '\x1b[27;2;9~')
  check('modifyOtherKeys shift+tab fires onShiftTab', hits === 2)
  feed({ editor, stdin: stdin as never, written, submitted: [] }, '\x1b[C') // plain arrow: no shift-tab
  check('plain escape does not fire onShiftTab', hits === 2)
}

// 3. modifyOtherKeys fallback (flags=0 answer, then DA)
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, '\x1b[?0u')
  check('flags=0 enables modifyOtherKeys', rig.written.join('').includes('\x1b[>4;2m'))
  feed(rig, 'ab')
  feed(rig, '\x1b[27;2;13~')
  feed(rig, 'cd')
  check('modifyOtherKeys CSI 27;2;13~ inserts newline', rig.editor.value === 'ab\ncd')
  feed(rig, '\n')
  check('no-kitty bare LF submits (ctrl+J parity)', rig.submitted.length === 1 && rig.submitted[0] === 'ab\ncd')
}

// 4. DA sentinel without kitty answer → fallback too
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, '\x1b[?1;2c')
  check('DA response enables modifyOtherKeys', rig.written.join('').includes('\x1b[>4;2m'))
}

// 5. alt+enter fallback still works
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, 'a\x1b\rb')
  check('alt+enter inserts newline', rig.editor.value === 'a\nb')
}

// 6. bracketed paste: multi-line paste becomes multi-line input, no submit
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, 'hello ')
  feed(rig, '\x1b[200~line1\r\nline2\rline3\x1b[201~')
  feed(rig, ' world')
  check('bracketed paste normalizes newlines', rig.editor.value === 'hello line1\nline2\nline3 world')
  check('bracketed paste never submits', rig.submitted.length === 0)
}

// 7. escape sequence split across chunks (stash)
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, 'ab')
  feed(rig, '\x1b[1')
  feed(rig, '3;2u')
  check('split CSI 13;2u reassembled via stash', rig.editor.value === 'ab\n')
}

// 8. plain enter submits and resets
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, 'do things\r')
  check('enter submits', rig.submitted.length === 1 && rig.submitted[0] === 'do things')
  check('value reset after submit', rig.editor.value === '')
}

// 9. markdown table rendering
{
  const md = '| Name | Age |\n| --- | ---: |\n| Alice | 30 |\n| Bob | 4 |\n\nafter'
  const out = renderMarkdown(md, 60).join('\n')
  check('table separator uses ┼', out.includes('┼'))
  check('table keeps header cell', out.includes('Name'))
  check('table right-aligns numbers', /Age +30/.test(out.replace(/\x1b\[[0-9;]*m/g, '')) || out.includes('30'))
  check('text after table survives', out.includes('after'))
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '')
  const ageLine = plain.split('\n').find(l => l.includes('30')) ?? ''
  check('table columns aligned (Age pad)', ageLine.includes('Age') === false && /\|\s+30\s+\|/.test(ageLine.replace(/[│]/g, '|')))
}

// 10. language-aware highlighting: python
{
  const md = '```python\n# a comment\ndef f():\n    """doc\n    more doc\n    end"""\n    return 42\n```'
  const out = renderMarkdown(md, 60)
  const joined = out.join('\n')
  check('python fence label shown', joined.includes('python'))
  check('python # comment gray', joined.includes('\x1b[90m# a comment'))
  check('python keyword magenta', joined.includes('\x1b[35mdef\x1b[0m'))
  check('triple-quote continuation stays green', out.some(l => l.includes('more doc') && l.includes('\x1b[32m')))
  check('number yellow', joined.includes('\x1b[93m42\x1b[0m'))
}

// 11. js line comment only for js
{
  const md = '```js\n// note\nconst x = 1\n```'
  const joined = renderMarkdown(md, 40).join('\n')
  check('js // comment gray', joined.includes('\x1b[90m// note'))
  check('js const keyword', joined.includes('\x1b[35mconst\x1b[0m'))
}

// 12. wrappedCursor
{
  const c1 = wrappedCursor('abcde', 3, 2) // ab|cd|e → offset 3 = after 'c' → row1 col1
  check('wrappedCursor wraps', c1.row === 1 && c1.col === 1)
  const c2 = wrappedCursor('ab\ncd', 4, 10) // hard newline
  check('wrappedCursor hard newline', c2.row === 1 && c2.col === 1)
  const c3 = wrappedCursor('\x1b[32mab\x1b[0m', '\x1b[32mab\x1b[0m'.length, 10)
  check('wrappedCursor skips ANSI', c3.row === 0 && c3.col === 2)
}

// 13. large paste collapses into a marker (>10 lines)
{
  const rig = makeEditor()
  rig.editor.start()
  const big = Array.from({ length: 12 }, (_, i) => 'line' + String(i)).join('\n')
  feed(rig, '\x1b[200~' + big + '\x1b[201~')
  check('12-line paste collapses to marker', rig.editor.value === '[paste #1 +12 lines]')
  feed(rig, '\r')
  check('submit expands marker to payload', rig.submitted.length === 1 && rig.submitted[0] === big)
}

// 14. large single-line paste collapses by chars (>1000)
{
  const rig = makeEditor()
  rig.editor.start()
  const big = 'x'.repeat(1500)
  feed(rig, '\x1b[200~' + big + '\x1b[201~')
  check('1500-char paste collapses to chars marker', rig.editor.value === '[paste #1 1500 chars]')
}

// 15. thresholds are exclusive: 10 lines / 1000 chars stay verbatim
{
  const rig = makeEditor()
  rig.editor.start()
  const ten = Array.from({ length: 10 }, (_, i) => 'l' + String(i)).join('\n')
  rig.editor.pasteText(ten)
  check('10-line paste stays verbatim', rig.editor.value === ten)
  const rig2 = makeEditor()
  rig2.editor.start()
  rig2.editor.pasteText('y'.repeat(1000))
  check('1000-char paste stays verbatim', rig2.editor.value.length === 1000)
}

// 16. marker is atomic: backspace removes it whole with its payload
{
  const rig = makeEditor()
  rig.editor.start()
  rig.editor.pasteText('z'.repeat(1200))
  feed(rig, 'ab')
  feed(rig, '\x7f') // backspace: removes 'b'
  feed(rig, '\x7f') // backspace: removes 'a'
  check('plain backspaces still work', rig.editor.value === '[paste #1 1200 chars]')
  feed(rig, '\x7f') // backspace at marker edge: whole marker gone
  check('backspace removes whole marker', rig.editor.value === '')
  feed(rig, '\r')
  check('marker payload not submitted after deletion', rig.submitted.length === 1 && rig.submitted[0] === '')
}

// 17. cursor skips markers atomically; ctrl+W respects marker edges
{
  const rig = makeEditor()
  rig.editor.start()
  rig.editor.pasteText('q'.repeat(1200))
  feed(rig, 'x')
  feed(rig, '\x1b[D') // left over 'x'
  feed(rig, '\x1b[D') // left: jumps over whole marker
  check('moveLeft jumps marker', rig.editor.cursor === 0)
  feed(rig, '\x1b[C') // right: jumps over whole marker
  check('moveRight jumps marker', rig.editor.cursor === '[paste #1 1200 chars]'.length)
}
{
  const rig = makeEditor()
  rig.editor.start()
  rig.editor.pasteText('q'.repeat(1200))
  feed(rig, ' hello')
  feed(rig, '\x17') // ctrl+W deletes the ' hello' word
  check('ctrl+W deletes word after marker', rig.editor.value === '[paste #1 1200 chars]')
  feed(rig, '\x17') // ctrl+W at the marker edge deletes the marker whole
  check('ctrl+W at marker edge deletes marker', rig.editor.value === '')
}

// 18. Ctrl+U clears markers and payloads
{
  const rig = makeEditor()
  rig.editor.start()
  rig.editor.pasteText('w'.repeat(1200))
  feed(rig, '\x15')
  check('ctrl+U clears marker', rig.editor.value === '')
  feed(rig, '\r')
  check('no submission after ctrl+U', rig.submitted.length === 1 && rig.submitted[0] === '')
}

// 19. image-paste shortcut fires callback (Ctrl+V and Alt+V), inserts nothing
{
  let hits = 0
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {},
    onPasteImage() { hits += 1 },
  }, stdin as never, { write() { return true } })
  editor.start()
  stdin.emit('data', Buffer.from('\x16'))
  stdin.emit('data', Buffer.from('\x1bv'))
  check('Ctrl+V and Alt+V fire onPasteImage', hits === 2 && editor.value === '')
}

// 20. slash autocomplete: open, filter, case-insensitive, typo-tolerant
{
  const rig = makeEditor(true)
  rig.editor.start()
  feed(rig, '/')
  check('typing / opens the dropdown', rig.editor.suggest !== undefined && (rig.editor.suggest?.items.length ?? 0) > 1)
  feed(rig, 'm')
  check('/m filters to /model first', rig.editor.suggest?.items[0]?.value === 'model')
  feed(rig, '\x15') // clear
  feed(rig, '/MO')
  check('/MO case-insensitive → /model first', rig.editor.suggest?.items[0]?.value === 'model')
  feed(rig, '\x15')
  feed(rig, '/molde')
  const values = rig.editor.suggest?.items.map(i => i.value) ?? []
  check('/molde typo-tolerant → /model present', values.includes('model'))
}

// 21. dropdown keys: navigate / Tab apply / Enter apply+submit / Esc close
{
  const rig = makeEditor(true)
  rig.editor.start()
  feed(rig, '/')
  feed(rig, '\x1b[B') // down → second item
  const second = rig.editor.suggest?.items[1]?.value
  check('down moves highlight', rig.editor.suggest?.index === 1 && second !== undefined)
  feed(rig, '\x1b[A') // up → back to first
  check('up moves highlight back', rig.editor.suggest?.index === 0)
  feed(rig, '\x1b[A') // up wraps to last
  check('up wraps to last', (rig.editor.suggest?.index ?? 0) === (rig.editor.suggest?.items.length ?? 1) - 1)
  feed(rig, '\x1b') // esc: stashed as a potential sequence, flushed after 25ms
  await new Promise(r => setTimeout(r, 60))
  check('esc closes dropdown (after stash flush)', rig.editor.suggest === undefined)
  feed(rig, 'mo')
  feed(rig, '\t') // tab applies
  check('tab fills /model ', rig.editor.value === '/model ' && rig.editor.suggest === undefined)
  feed(rig, '\x15')
  feed(rig, '/mo')
  feed(rig, '\r') // enter applies then submits
  check('enter applies+submits /model', rig.submitted.length === 1 && rig.submitted[0] === '/model ')
}

// 21b. Esc: closes the dropdown first (no interrupt); with no dropdown it fires onEsc
{
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const stdout = { write() { return true } }
  let escs = 0
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {},
    onSuggest: () => [{ value: 'help' }, { value: 'model' }],
    onEsc() { escs++ },
  }, stdin as never, stdout)
  editor.start()
  stdin.emit('data', Buffer.from('/'))
  stdin.emit('data', Buffer.from('\x1b')) // stashed as a possible sequence, flushed after 25ms
  await new Promise(r => setTimeout(r, 60))
  check('esc closes dropdown without firing onEsc', editor.suggest === undefined && escs === 0)
  stdin.emit('data', Buffer.from('\x1b'))
  await new Promise(r => setTimeout(r, 60))
  check('esc with no dropdown fires onEsc', escs === 1)
}

// 22. dropdown closes on whitespace and stays shut with suggestEnabled=false
{
  const rig = makeEditor(true)
  rig.editor.start()
  feed(rig, '/mo')
  check('open before space', rig.editor.suggest !== undefined)
  feed(rig, ' deep')
  check('space closes dropdown', rig.editor.suggest === undefined)
  const rig2 = makeEditor(true)
  rig2.editor.start()
  rig2.editor.suggestEnabled = false
  feed(rig2, '/mo')
  check('suggestEnabled=false keeps it shut', rig2.editor.suggest === undefined)
}

// 23. arrows with open dropdown never touch history
{
  const rig = makeEditor(true)
  rig.editor.start()
  feed(rig, 'hello\r')
  feed(rig, '/')
  feed(rig, '\x1b[A') // up navigates dropdown, not history
  check('up with dropdown open ignores history', rig.editor.value === '/')
}

// 23b. modal-menu arrows: callbacks returning true consume the key (history untouched)
{
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  let up = 0
  let down = 0
  const submitted: string[] = []
  const editor = new LineEditor({
    onSubmit(t: string) { submitted.push(t) },
    onInterrupt() {}, onEof() {}, onChange() {},
    onArrowUp() { up++; return true },
    onArrowDown() { down++; return true },
  }, stdin as never, { write() { return true } })
  editor.start()
  stdin.emit('data', Buffer.from('hello\r'))
  stdin.emit('data', Buffer.from('\x1b[A'))
  check('onArrowUp true consumes up arrow', up === 1 && editor.value === '')
  stdin.emit('data', Buffer.from('\x1b[B'))
  check('onArrowDown true consumes down arrow', down === 1 && editor.value === '')
  check('menu arrows never submit', submitted.length === 1 && submitted[0] === 'hello')
}

// 23c. modal-menu arrows: callbacks returning false fall back to history
{
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {},
    onArrowUp() { return false },
    onArrowDown() { return false },
  }, stdin as never, { write() { return true } })
  editor.start()
  stdin.emit('data', Buffer.from('hello\r'))
  stdin.emit('data', Buffer.from('\x1b[A'))
  check('onArrowUp false falls back to history', editor.value === 'hello')
  stdin.emit('data', Buffer.from('\x1b[B'))
  check('onArrowDown false falls back to history', editor.value === '')
}

// 24. usage accumulation + formatting
{
  const t = emptyUsage()
  addUsage(t, { inputTokens: 100, outputTokens: 20 })
  addUsage(t, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 30 })
  check('usage accumulates disjoint fields', t.input === 150 && t.output === 30 && t.cacheRead === 800 && t.cacheWrite === 30)
  check('billed input sums cache sides', billedInput(t) === 980)
  check('formatTokens boundaries', formatTokens(0) === '0' && formatTokens(999) === '999' && formatTokens(1000) === '1k' && formatTokens(1200) === '1.2k' && formatTokens(1500000) === '1.5M')
}

// 25. Term window title / progress / bell / alt-screen bytes
{
  const writes: string[] = []
  const fakeOut = {
    columns: 80, rows: 24, isTTY: true,
    write(c: string) { writes.push(c); return true },
    on() { return fakeOut }, off() { return fakeOut },
  }
  const term = new Term(fakeOut as never)
  term.setTitle('dsh — proj')
  check('title OSC 0 written', writes.join('').includes('\x1b]0;dsh — proj\x07'))
  term.setTitle('bad\x07title')
  check('title strips control bytes', writes.join('').includes('\x1b]0;badtitle\x07'))
  term.setProgress(true)
  check('progress on OSC 9;4;3', writes.join('').includes('\x1b]9;4;3\x07'))
  term.bell()
  check('bell byte', writes.join('').includes('\x07'))
  term.enter()
  term.leave()
  check('leave clears progress + alt-screen', writes.join('').includes('\x1b]9;4;0\x07') && writes.join('').includes('\x1b[?1049l'))
}

// 26. undo: word-coalesced snapshots; ctrl+U and fill are single undo steps
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, 'hello world')
  feed(rig, '\x1a') // ctrl+z → removes ' world'
  check('undo step 1 removes last word', rig.editor.value === 'hello')
  feed(rig, '\x1a')
  check('undo step 2 clears', rig.editor.value === '')
  feed(rig, '\x1a') // empty stack: no-op
  check('undo on empty stack is a no-op', rig.editor.value === '')
  feed(rig, 'abc')
  feed(rig, '\x15') // ctrl+u clears
  feed(rig, '\x1a')
  check('ctrl+u then undo restores', rig.editor.value === 'abc')
  rig.editor.fill('pasted back')
  feed(rig, '\x1a')
  check('fill is one undo step', rig.editor.value === 'abc')
}

// 27. kill ring: ctrl+w / ctrl+k / ctrl+u feed it; ctrl+y yanks back
{
  const rig = makeEditor()
  rig.editor.start()
  feed(rig, 'hello world')
  feed(rig, '\x17') // ctrl+w kills ' world'
  check('ctrl+w deletes word', rig.editor.value === 'hello')
  feed(rig, '\x19') // ctrl+y yanks
  check('ctrl+y yanks killed word', rig.editor.value === 'hello world')
  feed(rig, '\x01') // home
  feed(rig, '\x0b') // ctrl+k kills the line
  check('ctrl+k clears to end', rig.editor.value === '')
  feed(rig, '\x19')
  check('ctrl+y yanks killed line', rig.editor.value === 'hello world')
}

// 28. arg completion mode: '/model |' offers providers via onSuggestArgs
{
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {},
    onSuggest: () => [{ value: 'model' }, { value: 'fork' }],
    onSuggestArgs: (command, args) => {
      if (command === 'model' && args.length === 0) return [{ value: 'deepseek-official' }, { value: 'zai-coding-cn' }]
      if (command === 'model' && args.length === 1) return [{ value: 'deepseek-v4-pro' }]
      return []
    },
  }, stdin as never, { write() { return true } })
  editor.start()
  stdin.emit('data', Buffer.from('/model '))
  check('arg mode opens with providers', editor.suggest?.kind === 'arg' && editor.suggest.items.length === 2)
  stdin.emit('data', Buffer.from('de'))
  check('arg filters by prefix', editor.suggest?.items[0]?.value === 'deepseek-official')
  stdin.emit('data', Buffer.from('\t'))
  check('tab fills provider arg', editor.value === '/model deepseek-official ')
  check('dropdown stays closed right after an apply', editor.suggest === undefined)
  stdin.emit('data', Buffer.from('d'))
  check('second arg offers models after typing', editor.suggest?.items[0]?.value === 'deepseek-v4-pro')
}

// 29. file completion mode: '@pa' fuzzy-matches and applies the path (dropping the @)
{
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {},
    onSuggest: () => [],
    onSuggestFiles: () => [{ value: 'package.json' }, { value: 'packages/bundle/tui/src/editor.ts' }],
  }, stdin as never, { write() { return true } })
  editor.start()
  stdin.emit('data', Buffer.from('read @pa'))
  check('file mode opens on @', editor.suggest?.kind === 'file' && (editor.suggest.items.length ?? 0) > 0)
  stdin.emit('data', Buffer.from('\t'))
  check('apply drops @ and adds space', editor.value === 'read package.json ')
}

// 30. mouse: SGR press fires onMousePress, release ignored; reporting is on for the
// whole session (wheel scrolls anywhere), stop() restores it
{
  const events: string[] = []
  const wheels: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} })
  const written: string[] = []
  const stdout = { write(c: string) { written.push(c); return true } }
  const editor = new LineEditor({
    onSubmit() {}, onInterrupt() {}, onEof() {}, onChange() {},
    onSuggest: () => [{ value: 'model' }, { value: 'fork' }],
    onMousePress(col, row) { events.push(`${col},${row}`) },
    onWheelUp() { wheels.push('up') },
    onWheelDown() { wheels.push('down') },
  }, stdin as never, stdout)
  editor.start()
  check('start enables mouse reporting', written.join('').includes('\x1b[?1000h') && written.join('').includes('\x1b[?1006h'))
  stdin.emit('data', Buffer.from('/'))
  check('dropdown open keeps mouse reporting on', written.join('').includes('\x1b[?1000h') && written.join('').includes('\x1b[?1006h'))
  stdin.emit('data', Buffer.from('\x1b[<0;7;23M'))
  stdin.emit('data', Buffer.from('\x1b[<0;7;23m'))
  check('press parsed, release ignored', events.length === 1 && events[0] === '7,23')
  editor.applySuggestAt(1)
  check('applySuggestAt applies row', editor.value === '/fork ')
  stdin.emit('data', Buffer.from('\x1b[<64;1;1M'))
  stdin.emit('data', Buffer.from('\x1b[<65;1;1M'))
  check('wheel up/down fire wheel callbacks', wheels.join(',') === 'up,down')
  check('dropdown close does not disable mouse (always-on)', !written.join('').includes('\x1b[?1000l'))
  editor.stop()
  check('stop restores mouse reporting', written.join('').includes('\x1b[?1006l\x1b[?1000l'))
}

// 31. clipboard write/read roundtrip (real system clipboard)
{
  const probe = 'DSA_CLIP_' + String(Date.now())
  const ok = await writeClipboardText(probe)
  const back = await readClipboardText()
  check('clipboard write/read roundtrip', ok && back !== undefined && back.includes(probe))
}

// 32. diff rendering: color blocks (green add / red delete / dim context)
{
  const { renderDiff, renderDiffs, diffsFromMeta } = await import('../packages/bundle/tui/src/diff.ts')
  const add = '\x1b[48;5;22m' // dark green block
  const del = '\x1b[48;5;52m' // dark red block

  // new-file create (oldText null): every line is an added green block
  const created = renderDiff({ path: 'a.md', oldText: null, newText: 'one\ntwo' }, 40)
  check('create header shows path', created[0]?.includes('a.md') === true)
  check('create header stats +2', created[0]?.includes('+2') === true && created[0]?.includes('-') === false)
  check('create lines all green blocks', created.slice(1).every(l => l.includes(add) && l.includes('+ ') && !l.includes(del)))
  const plain = created[1]?.replace(/\x1b\[[0-9;]*m/g, '') ?? ''
  check('create blocks span full width', plain.length >= 38)

  // edit change: delete + insert + context
  const edited = renderDiff({ path: 'b.md', oldText: 'ctx\nold line\nctx2', newText: 'ctx\nnew line\nctx2' }, 40)
  check('edit header stats +1 -1', edited[0]?.includes('+1') === true && edited[0]?.includes('-1') === true)
  const hasDel = edited.some(l => l.includes(del) && l.includes('- '))
  const hasAdd = edited.some(l => l.includes(add) && l.includes('+ '))
  check('edit has red delete block', hasDel)
  check('edit has green add block', hasAdd)
  const ctxLine = edited.find(l => l.includes('ctx') && !l.includes('old line') && !l.includes('new line'))
  check('edit context dim, no block', ctxLine?.includes('\x1b[2m') === true && ctxLine?.includes(add) === false && ctxLine?.includes(del) === false)

  // diffsFromMeta narrowing
  check('meta diffs parsed', diffsFromMeta({ diffs: [{ path: 'x', oldText: 'a', newText: 'b' }] })?.[0]?.path === 'x')
  check('meta bad shape rejected', diffsFromMeta({ diffs: 'nope' }) === undefined)
  const multi = renderDiffs([{ path: 'a', oldText: null, newText: 'x' }], 20)
  check('renderDiffs ends with blank row', multi.at(-1) === '')
}

// 24. mouse-selection helpers: inverse-range highlight and visible-column slice
{
  check('inverseRange single cols', inverseRange('abcdef', 1, 4) === 'a\x1b[7mbcd\x1b[27mef')
  check('inverseRange empty range', inverseRange('abcdef', 3, 3) === 'abcdef')
  check('inverseRange out of range clamps', inverseRange('abc', 0, 100) === '\x1b[7mabc\x1b[27m')
  check('inverseRange wide CJK boundary', inverseRange('a你b', 0, 2) === '\x1b[7ma你\x1b[27mb')
  check('inverseRange keeps ANSI passthrough', inverseRange('\x1b[1mab\x1b[22m', 1, 2) === '\x1b[1ma\x1b[7mb\x1b[27m\x1b[22m')
  check('inverseRange negative start clamps to 0', inverseRange('abc', -1, 2) === '\x1b[7mab\x1b[27mc')
  check('sliceVisible basic', sliceVisible('abcdef', 1, 4) === 'bcd')
  check('sliceVisible strips ANSI', sliceVisible('\x1b[31mab\x1b[0mcd', 0, 4) === 'abcd')
  check('sliceVisible wide CJK', sliceVisible('a你b', 1, 3) === '你')
  check('sliceVisible end clamp', sliceVisible('abc', 0, 99) === 'abc')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
