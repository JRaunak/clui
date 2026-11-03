import { useEffect, useId } from 'react'
import { DEFAULT_SETTINGS, THEME_CHOICES, THEME_LABELS, type CluiSettings } from '../../../../shared/settings'
import { applyTheme } from '../../lib/theme'
import { Dropdown } from '../Dropdown'
import { FieldError } from '../LoginFields'
import { Field, SAVE_FAILED, describedBy, useInstantSetting, useInstantText } from './shared'

export function GeneralSection(): JSX.Element {
  const uid = useId()
  const theme = useInstantSetting('theme')
  const editor = useInstantText('editorCommand')

  // A pick paints in onChange; this repaints when the shown theme moves on its own, after a failed write or a reset.
  useEffect(() => {
    if (theme.value) applyTheme(theme.value)
  }, [theme.value])

  return (
    <>
      <Field
        label="Theme"
        hint="System matches your Mac's appearance. Light and Dark override it."
        hintId={`${uid}-theme-hint`}
        onReset={theme.overridden ? theme.reset : undefined}
        note={theme.failed && <FieldError id={`${uid}-theme-err`} text={SAVE_FAILED} />}
      >
        <Dropdown<CluiSettings['theme']>
          value={theme.value ?? DEFAULT_SETTINGS.theme}
          ariaLabel="Theme"
          dataUi="theme"
          ariaDescribedBy={describedBy(`${uid}-theme-hint`, theme.failed && `${uid}-theme-err`)}
          options={THEME_CHOICES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
          onChange={(t) => {
            theme.set(t)
            applyTheme(t)
          }}
        />
      </Field>

      <Field
        label="Editor command"
        hint="The command Clui runs to open changed files and diffs, such as code, cursor or subl."
        hintId={editor.hintId}
        onReset={editor.overridden ? editor.reset : undefined}
        note={editor.failed && <FieldError id={editor.errId} text={SAVE_FAILED} />}
      >
        <input
          aria-label="Editor command"
          data-ui="editor-command"
          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-content outline-none focus:border-accent"
          {...editor.inputProps}
        />
      </Field>
    </>
  )
}
