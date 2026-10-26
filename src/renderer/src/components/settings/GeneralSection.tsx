import { useEffect, useState } from 'react'
import type { CliInfo } from '../../../../shared/ipc'
import { THEME_CHOICES, THEME_LABELS, type CluiSettings } from '../../../../shared/settings'
import { Dropdown } from '../Dropdown'
import { Field, type DraftProps } from './shared'

export function GeneralSection({
  settings,
  set,
  reset,
  isOverridden,
  previewTheme
}: DraftProps & { previewTheme: (t: CluiSettings['theme']) => void }): JSX.Element {
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)

  const checkCli = async (path: string): Promise<void> => {
    setChecking(true)
    const info = await window.clui.detectCliAt(path)
    setCliInfo(info)
    setChecking(false)
  }
  useEffect(() => {
    void checkCli(settings.cliPath)
    // Once on mount, with the saved path; edits are checked on blur or with Check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Field
        label="Theme"
        hint="System matches your Mac's appearance. Light and Dark override it."
        onReset={isOverridden('theme') ? () => reset('theme') : undefined}
      >
        <Dropdown<CluiSettings['theme']>
          value={settings.theme}
          ariaLabel="Theme"
          options={THEME_CHOICES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
          onChange={previewTheme}
        />
      </Field>

      <Field
        label="Claude CLI path"
        hint="Leave blank to detect Claude automatically. Set a path only if it lives somewhere unusual."
        onReset={isOverridden('cliPath') ? () => reset('cliPath') : undefined}
      >
        <div className="flex gap-2">
          <input
            aria-label="Claude CLI path"
            className="flex-1 rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
            placeholder="(auto-detect)"
            value={settings.cliPath}
            onChange={(e) => set('cliPath', e.target.value)}
            onBlur={() => void checkCli(settings.cliPath)}
          />
          <button
            className="rounded border border-border px-3 text-xs text-dim hover:text-content"
            onClick={() => void checkCli(settings.cliPath)}
          >
            Check
          </button>
        </div>
        <div className="mt-1 text-meta">
          {checking ? (
            <span className="text-dim">checking…</span>
          ) : cliInfo?.path ? (
            <span className="text-ok">
              ✓ <span className="font-mono">claude {cliInfo.version ?? '?'}</span> ·{' '}
              {cliInfo.source} · <span className="font-mono">{cliInfo.path}</span>
            </span>
          ) : (
            <span className="text-err">✗ claude not found</span>
          )}
        </div>
      </Field>

      <Field
        label="Editor command"
        hint="The command Clui runs to open changed files and diffs, such as code, cursor or subl."
        onReset={isOverridden('editorCommand') ? () => reset('editorCommand') : undefined}
      >
        <input
          aria-label="Editor command"
          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
          value={settings.editorCommand}
          onChange={(e) => set('editorCommand', e.target.value)}
        />
      </Field>
    </>
  )
}
