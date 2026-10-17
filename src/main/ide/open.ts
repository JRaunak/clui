/**
 * IDE integration: open files/diffs in the user's editor.
 *
 * Per the product decision, Clui does NOT ship a bespoke diff viewer; it shells
 * out to the configured editor (default `code`). Changed-file detection is done
 * in the renderer by tracking Write/Edit tool_use paths from the stream; this
 * module just launches the editor for a path.
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { editorLineStyle } from '../../shared/settings'

const execFileP = promisify(execFile)

/**
 * Open a file in the editor. `editorCmd` is the CLI command (e.g. `code`,
 * `cursor`, `subl`). Resolved through a login shell so GUI-launched Electron
 * finds editors on the user's real PATH.
 */
export async function openInEditor(editorCmd: string, filePath: string, line?: number): Promise<void> {
  await runEditor(editorCmd, editorArgs(editorCmd, filePath, line))
}

/** An editor that doesn't take a line is given the file alone, rather than a path it would read as a new file's name. */
export function editorArgs(editorCmd: string, filePath: string, line?: number): string[] {
  const style = line ? editorLineStyle(editorCmd) : null
  if (style === 'goto') return ['-g', `${filePath}:${line}:1`]
  return style === 'suffix' ? [`${filePath}:${line}:1`] : [filePath]
}

/** Open a two-file diff in the editor (VS Code family supports `--diff a b`). */
export async function openDiff(
  editorCmd: string,
  left: string,
  right: string
): Promise<void> {
  await runEditor(editorCmd, ['--diff', left, right])
}

/** Split the editor setting into words, honouring quotes, so `open -a "Visual Studio Code"` works. */
export function editorArgv(cmd: string): string[] {
  const words = [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
  return words.map((w) => (w.startsWith('~/') ? homedir() + w.slice(1) : w))
}

async function runEditor(editorCmd: string, args: string[]): Promise<void> {
  const shell = process.env.SHELL || '/bin/zsh'
  const argv = editorArgv(editorCmd)
  if (!argv.length) throw new Error('No editor command is set.')
  // The login shell supplies the user's PATH; the setting reaches it as arguments, never as script
  // text, so a renderer-writable value can't inject shell syntax.
  try {
    await execFileP(shell, ['-lic', '"$@"', 'clui-editor', ...argv, ...args], { timeout: 8000 })
  } catch (err) {
    throw new Error(
      `Failed to launch editor "${editorCmd}". Is it on your PATH? (${(err as Error).message})`
    )
  }
}
