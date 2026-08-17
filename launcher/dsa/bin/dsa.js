#!/usr/bin/env node
/**
 * `dsa` — global launcher for the local deepseek-harness terminal UI.
 *
 * Spawns the built dsh CLI (apps/cli/lib/bin.js inside the repo) with the
 * `tui` profile, forwarding every extra argument after it, so:
 *
 *   dsa                      →  dsh --profile tui
 *   dsa "fix the tests"      →  dsh --profile tui "fix the tests"
 *
 * The child inherits the caller's working directory — that directory becomes
 * the agent's workspace — and its stdio, so the terminal session is direct.
 * After pulling repo updates, rebuild with: pnpm run build:lib:host.
 */

const { spawn } = require('node:child_process')
const { join } = require('node:path')

const REPO = join(__dirname, '..', '..', '..')
const BIN = join(REPO, 'apps', 'cli', 'lib', 'bin.js')

const child = spawn(process.execPath, [BIN, '--profile', 'tui', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  windowsHide: true,
})

child.on('error', (error) => {
  console.error(`dsa: failed to start dsh: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code)
  console.error(`dsa: dsh terminated by ${signal ?? 'unknown signal'}`)
  process.exit(1)
})
