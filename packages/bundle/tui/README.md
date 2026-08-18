# @deepseek-ai/dsh-tui

The dsh interactive terminal bundle: a full-screen (alternate-buffer) Agent runner over [`dsh-base`](../base/README.md) with no Host, HTTP, or browser layer. Assistant text streams as rendered markdown, file edits show as inline colored diffs, and a session resume picker restores past sessions.

```sh
dsh --profile tui                    # open an interactive terminal session
dsh --profile tui "run the tests"    # open a session and submit one task
dsh --profile tui --preset minimal   # boot on the two-tool minimal (极简模式) agent
dsh --profile tui --preset code      # boot on the Code Mode (PTC 模式) agent
dsh --profile tui --resume            # pick a persisted session to resume
```

[`cordis.patch.yml`](cordis.patch.yml) rides directly over `dsh-base`: it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker, and inserts this package's `tui-runner` plugin (config `{task?}`, resolved from the injected `tuiStartup` provider). The profile template ships as `tui: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui']` and auto-initializes on first use.

After the Loader settles, the runner creates one persisted Agent through `ctx.agents` and relays between the terminal and the session event stream:

- **stdin input** uses a raw-mode line editor with history, cursor movement, and editing keys; a submitted line becomes a user follow-up and `turn/end` hands the prompt back. Shift+Enter inserts a newline — the editor negotiates the Kitty keyboard protocol at startup (falling back to xterm modifyOtherKeys, and to Alt+Enter on terminals with neither); bracketed paste turns a multi-line paste into multi-line input, a large paste (>10 lines or >1000 chars) collapses into an atomic `[paste #N …]` marker whose payload expands on submit, and Ctrl+V / Alt+V pastes a clipboard image (saved to a temp file, path inserted — pi parity). Undo (Ctrl+Z, word-coalesced), a kill ring (Ctrl+K/U/W kill, Ctrl+Y yank), and Ctrl+G ($EDITOR hand-over) round out the editing surface.
- **`assistant/chunk`** streams live into the transcript: reasoning renders dim, answer text renders as markdown (headings, code blocks with language-aware syntax highlighting, lists, tables, inline code/bold).
- **`tool/call`** renders as a one-line `● tool` summary; `tool/result` meta from `dsh-tool-fs` renders as an inline `+`/`-` colored file diff.
- **`todo/write`** feeds a live todo count in the status bar.
- **`approval/request`** and **`ctx.userQuestions`** are answered inline at the prompt (number keys or free text; `y` grants once).

Slash commands: `/help`, `/setup`, `/model`, `/preset`, `/fork [turn]`, `/new`, `/copy`, `/bell`, `/sessions`, `/exit` (also `/quit`). Typing `/` opens an autocomplete dropdown above the input — fuzzy case-insensitive filtering with a typo-tolerant fallback (edit distance ≤ 2, so `/molde` still offers `/model`); ↑/↓ navigate, **mouse click** or Tab completes, Enter applies (and runs slash commands), Esc dismisses. The same dropdown also completes **`@file-paths`** (cwd scan, gitignore-aware) and **command arguments** (`/model` → providers → models → efforts, `/preset`, `/fork` turn numbers). `/fork` branches the current session into a child and switches to it — with a turn number it rewinds the child's seed to that turn's end, with no argument a turn picker opens (or `latest`); the parent session stays live in the background. `/sessions` switches between the live sessions (each rendered with its own transcript/scroll/todos, status bar shows the count) or resumes a persisted one into a new live view. Ctrl+C interrupts the live turn; at an idle prompt it exits. Leaving mid-turn cancels the turn first (a flush of an open turn never resolves), waits bounded for the driver to go idle, flushes every live session, then requests exit through the launcher-provided `ctx.appExit`, with a hard process-exit backstop.

## Models and presets

- **`/model`** prints the current selection and every configurable provider's catalog. **`/model <provider> <model> [off|high|max]`** mutates the live agent's `ModelSelectionRef` (the next step that enters prompt assembly picks it up) and persists the choice through `ctx.agentDefaultModel.saveSelection()`, so future sessions default to it. `/model <model>` keeps the current provider.
- **`/preset`** lists the roster (shipped: `standard`, `code` = PTC 模式, `minimal` = 极简模式, `cordis` = Creator mode, plus user presets under `$DSH_HOME/.agent-presets`). **`/preset <id>`** re-links the blank agent via `ctx.agentPresets.recompose()` and records the durable `agent-preset/selected` event — valid only before the session's first message, after which the preset is fixed (start a new session with `--preset <id>` instead). The roster row mirrors the Web bundle (`default: standard`); agent creation mirrors the Web host: resolve before the session exists, `mount()` inside an async `setup` so failures roll creation back.

Model and credentials come from the shared Harness home (`$DSH_HOME/settings.yaml`, `$DSH_HOME/.credentials.yaml`), same as the Web profile; `DEEPSEEK_API_KEY` in the environment also works. The default route is `deepseek-official / deepseek-v4-flash-0731` unless settings override it.

### `/setup` — configure API key / base URL / model from inside the terminal

For a fresh checkout (or to point the terminal at a different provider or gateway), **`/setup`** walks you through the three fields with the modal prompt and persists each one as you go — no file editing needed:

1. **API key** — written to `$DSH_HOME/.credentials.yaml` through the `credentials` service (`DEEPSEEK_API_KEY` reference), effective for the next request. Leave empty to skip.
2. **API base URL** — written to the `llm-deepseek` section of `$DSH_HOME/settings.yaml` (`baseURL`), effective for the next request. Leave empty to keep the official endpoint.
3. **Provider + model name** — applied and persisted through the same path as `/model` (`ctx.agentDefaultModel.saveSelection`), so future sessions boot on it. Provider is only asked when none is selected yet; a stray model name that the cataloged provider never advertised is refused (same guard as `/model`).

Each step applies immediately; the model change also updates the live selection so the next submitted step uses it. Everything lands in `~/.dsh` (or `$DSH_HOME`), shared with the Web/headless profiles.

## Model Experience

None beyond `dsh-base`: the runner submits terminal input as ordinary user messages; prompts and tools belong to the base and tui bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **Fork rewind is turn-granular** — `/fork <turn>` seeds the child through that turn's `turn/end`; finer (per-event) rewinds are deferred.
- **Preset switching is blank-only** — once the first message logs, the composition is frozen by design (upstream constraint), same as the Web UI.
- **Shift+Enter needs a cooperating terminal** — Kitty-protocol and modifyOtherKeys terminals are detected automatically; elsewhere (plain conhost) use Alt+Enter. Scrollback uses PageUp/PageDown (the alternate buffer has no native terminal scrollback). Clipboard-image paste shells out to the platform tooling (PowerShell / osascript / wl-paste / xclip); whether the model can *see* the pasted image depends on the route's image capability — the `read_image` tool gates that itself.
- **Markdown is light** — tables render without column-span rules, and the syntax highlighter is a single-pass tokenizer (no full grammars).
- **Approvals answer for every live agent** — the one terminal answerer owns subagent requests too; per-agent routing is deferred.
