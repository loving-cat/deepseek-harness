/**
 * System-clipboard access for the image-paste shortcut, with zero added
 * dependencies — each platform is queried through its built-in tooling:
 * PowerShell (win32), osascript/pbpaste (darwin), wl-paste/xclip (linux).
 * Every probe is best-effort with a timeout: any failure reads as "no image"
 * and the caller falls back to text (pi's clipboard flow, minus pi's native
 * helper binaries, which this zero-dependency bundle cannot ship).
 *
 * @module @deepseek-ai/dsh-tui/clipboard
 */

import { execFile } from 'node:child_process'

/** One raster image read from the clipboard. */
export interface ClipboardImage {
  bytes: Buffer
  mediaType: 'image/png'
}

const TIMEOUT_MS = 5000
const MAX_BUFFER_BYTES = 50 * 1024 * 1024

/** Run one probe, resolving to stdout text, or undefined on any failure. */
function probe(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true }, (error, stdout) => {
      if (error !== null) { resolve(undefined); return }
      resolve(stdout)
    })
  })
}

/** Decode a base64 payload into an image, or undefined when empty/invalid. */
function decodeImage(base64: string | undefined): ClipboardImage | undefined {
  const trimmed = base64?.trim() ?? ''
  if (trimmed === '') return undefined
  try {
    const bytes = Buffer.from(trimmed, 'base64')
    // Magic-byte sanity: PNG starts with 0x89 'PNG'.
    if (bytes.length < 8 || bytes[0] !== 0x89) return undefined
    return { bytes, mediaType: 'image/png' }
  } catch {
    return undefined
  }
}

/**
 * PowerShell one-liner: print the clipboard image as base64 PNG, or nothing.
 * System.Windows.Forms.Clipboard needs an STA thread; -Sta is the default for
 * Windows PowerShell 5.1 but must be explicit on PowerShell 7+.
 */
const PS_IMAGE_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms | Out-Null; '
  + 'Add-Type -AssemblyName System.Drawing | Out-Null; '
  + '$i = [System.Windows.Forms.Clipboard]::GetImage(); '
  + 'if ($null -ne $i) { $m = New-Object System.IO.MemoryStream; $i.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($m.ToArray())) }'

/** Read the clipboard's image, or undefined when there is none (or no probe works). */
export async function readClipboardImage(): Promise<ClipboardImage | undefined> {
  if (process.platform === 'win32') {
    for (const shell of ['powershell', 'pwsh']) {
      const out = await probe(shell, ['-NoProfile', '-NonInteractive', '-Sta', '-Command', PS_IMAGE_SCRIPT])
      const image = decodeImage(out)
      if (image !== undefined) return image
    }
    return undefined
  }
  if (process.platform === 'darwin') {
    // osascript renders «class PNGf» as a hex dump inside «data PNGf…».
    const out = await probe('osascript', ['-e', 'get the clipboard as «class PNGf»'])
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(out ?? '')?.[1]
    if (hex === undefined) return undefined
    try {
      const bytes = Buffer.from(hex, 'hex')
      return bytes.length > 8 ? { bytes, mediaType: 'image/png' } : undefined
    } catch {
      return undefined
    }
  }
  // Linux: Wayland first, then X11; pipe through base64 to keep stdout textual.
  const wayland = await probe('sh', ['-c', 'wl-paste --list-types 2>/dev/null | grep -qx "image/png" && wl-paste -t image/png 2>/dev/null | base64 -w0'])
  const image = decodeImage(wayland)
  if (image !== undefined) return image
  const x11 = await probe('sh', ['-c', 'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -qx "image/png" && xclip -selection clipboard -t image/png -o 2>/dev/null | base64 -w0'])
  return decodeImage(x11)
}

/** Read the clipboard's text, or undefined when empty / unreadable. */
export async function readClipboardText(): Promise<string | undefined> {
  if (process.platform === 'win32') {
    for (const shell of ['powershell', 'pwsh']) {
      const out = await probe(shell, ['-NoProfile', '-NonInteractive', '-Sta', '-Command', 'Get-Clipboard -Raw'])
      if (out !== undefined) return out === '' ? undefined : out
    }
    return undefined
  }
  if (process.platform === 'darwin') {
    const out = await probe('pbpaste', [])
    return out === undefined || out === '' ? undefined : out
  }
  const out = await probe('sh', ['-c', 'wl-paste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null'])
  return out === undefined || out === '' ? undefined : out
}

/** Write text to the system clipboard (clip / pbcopy / wl-copy / xclip via stdin). */
export function writeClipboardText(text: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> = process.platform === 'win32'
    ? [['clip', []]]
    : process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
  const tryNext = (index: number): Promise<boolean> => {
    const candidate = candidates[index]
    if (candidate === undefined) return Promise.resolve(false)
    const [command, args] = candidate
    return new Promise((resolve) => {
      const child = execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error === null) { resolve(true); return }
        // Missing binary (wl-copy on an xclip box) falls through to the next candidate.
        if ((error as { code?: unknown }).code === 'ENOENT') { resolve(tryNext(index + 1)); return }
        resolve(false)
      })
      try {
        child.stdin?.write(text)
        child.stdin?.end()
      } catch {
        resolve(false)
      }
    })
  }
  return tryNext(0)
}
