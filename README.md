# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## About this fork

This repository is a **fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** that adds an interactive **terminal profile (`tui`)** — a full-screen, alternate-buffer agent runner you launch from a plain terminal (no browser, no HTTP server). It is built directly over the official `dsh-base` and shares the same `~/.dsh` configuration home.

### Quick start (terminal mode)

```sh
git clone <your-fork-url>
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh --profile tui
```

Then configure your API credentials from inside the terminal:

```
/setup     # interactive: API key → base URL → model (all persisted to ~/.dsh)
```

Or set them by hand in `~/.dsh`:

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-0731
llm-deepseek:
  baseURL: https://api.deepseek.com/v1   # optional; official endpoint by default
```

```yaml
# ~/.dsh/.credentials.yaml
DEEPSEEK_API_KEY: sk-...
```

### Hard dependencies for the terminal profile

| Dependency | Version | Required? | Notes |
|---|---|---|---|
| Node.js | ^22.19.0 或 ≥ 24 | ✅ | 官方 engines 要求（zstd、类型剥离）。 |
| pnpm | ≥ 9 (corepack) | ✅ | Monorepo package manager; `corepack enable` then `pnpm install`. |
| API key | — | ✅ | `~/.dsh/.credentials.yaml` or `DEEPSEEK_API_KEY` env var; without it requests fail `MISSING_CREDENTIAL`. |
| `~/.dsh/settings.yaml` | — | ⚠️ optional | Only needed to override the default model / endpoint. |
| node-pty | bundled | ⚠️ Windows | Full-screen TUI needs a real pty; on Windows the build needs the VS Build Tools (C++ toolchain). |
| kitty / WezTerm | — | ⚠️ optional | Inline image rendering (kitty graphics); Windows Terminal lacks it. |

What was added on top of upstream:

- `packages/bundle/tui` — the terminal profile (`tui-runner` plugin + editor + renderer)
- `/setup` command for interactive API key / base URL / model configuration
- `scripts/tui-unit.mts` + `scripts/tui-pty-e2e*.cjs` — offline and pty test assets

See [`packages/bundle/tui/README.md`](packages/bundle/tui/README.md) for the full terminal guide.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
