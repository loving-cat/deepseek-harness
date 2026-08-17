/**
 * The terminal app's command-line provider: it parses the optional
 * initial-task positional and `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE}. The runner is an ordinary consumer whose lazy
 * config waits for that service.
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the startup values can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The initial message submitted right after boot, when given. */
  task: string | undefined
  /** The agent preset id from `--preset`, when given. */
  preset: string | undefined
  /** Whether the user asked to pick a persisted session to resume. */
  resume: boolean
}

/**
 * This app's command: an optional initial task positional, its description,
 * and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Start an interactive terminal session with the agent.')
    .helpOption('-h, --help', 'show this help')
    .option('--preset <id>', 'agent preset to compose: standard | code | minimal | cordis')
    .option('--resume', 'pick a persisted session to resume instead of starting fresh')
    .argument('[task...]', 'optional initial task; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile tui                       open an interactive terminal session
  dsh --profile tui "run the tests"       open a session and submit one task
  dsh --profile tui --preset minimal      run the two-tool minimal agent
  dsh --profile tui --preset code         run the Code Mode (PTC) agent
`)
}

/**
 * Parse and provide the startup values as an ordinary Cordis service. The
 * command's action always publishes (the task is optional), so the runner
 * mounts even for a bare `dsh --profile tui`; on `--help` nothing is
 * provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const task = program.args.join(' ')
    const opts = program.opts<{ preset?: string; resume?: boolean }>()
    const rawPreset = opts.preset
    ctx.provide(TUI_STARTUP_SERVICE, {
      task: task.trim() === '' ? undefined : task,
      preset: rawPreset === undefined || rawPreset.trim() === '' ? undefined : rawPreset,
      resume: opts.resume === true,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
