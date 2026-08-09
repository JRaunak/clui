/**
 * IDE integration: open files/diffs in the user's editor.
 *
 * Per the product decision, Clui does NOT ship a bespoke diff viewer; it shells
 * out to the configured editor (default `code`). Changed-file detection is done
 * in the renderer by tracking Write/Edit tool_use paths from the stream; this
 * module just launches the editor for a path.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * Open a file in the editor. `editorCmd` is the CLI command (e.g. `code`,
 * `cursor`, `subl`). Resolved through a login shell so GUI-launched Electron
 * finds editors on the user's real PATH.
 */
export async function openInEditor(editorCmd: string, filePath: string): Promise<void> {
  await runEditor(editorCmd, [filePath])
}

/** Open a two-file diff in the editor (VS Code family supports `--diff a b`). */
export async function openDiff(
  editorCmd: string,
  left: string,
  right: string
): Promise<void> {
  await runEditor(editorCmd, ['--diff', left, right])
}

async function runEditor(editorCmd: string, args: string[]): Promise<void> {
  const shell = process.env.SHELL || '/bin/zsh'
  // Build a login-shell command so PATH is complete; quote args safely.
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  const command = `${editorCmd} ${quoted}`
  try {
    await execFileP(shell, ['-lic', command], { timeout: 8000 })
  } catch (err) {
    throw new Error(
      `Failed to launch editor "${editorCmd}". Is it on your PATH? (${(err as Error).message})`
    )
  }
}
