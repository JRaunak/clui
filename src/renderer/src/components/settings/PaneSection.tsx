import { useId } from 'react'
import type { FileLinkTarget } from '../../../../shared/settings'
import { LINK_MOD } from '../../lib/openLink'
import { Dropdown } from '../Dropdown'
import { FieldError } from '../LoginFields'
import { BrowserSection } from './BrowserSection'
import { CheckField, Field, Pane, SAVE_FAILED, SubNav, SubPane, TIMING, useInstantSetting, useSettingsSub } from './shared'

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'browser', label: 'Browser' }
] as const

export function PaneSection({ active }: { active: boolean }): JSX.Element {
  const sub = useSettingsSub('pane', 'general')
  const files = useInstantSetting('fileLinkTarget')
  const uid = useId()
  return (
    <Pane section="pane" active={active} flush>
      <SubNav section="pane" label="Pane sections" tabs={TABS} value={sub} />
      <SubPane section="pane" sub="general" active={sub === 'general'} className="flex flex-col gap-5">
        <CheckField
          setting="surfaceTools"
          ui="surface-tools"
          label="Pane access"
          hint={`Claude can see what the pane shows and open files, folders, browser tabs and changes there. References you send still work with this off. Quick sessions never have it. ${TIMING}`}
          text="Claude can show things in the pane"
        />
        <Field
          label="Open file links in"
          hint={`Applies to file paths in Claude's replies and tool calls. ${LINK_MOD}-click opens the other way.`}
          onReset={files.value && files.value !== 'clui' ? files.reset : undefined}
          note={files.failed && <FieldError id={`${uid}-files-err`} text={SAVE_FAILED} />}
        >
          <Dropdown<FileLinkTarget>
            value={files.value ?? 'clui'}
            ariaLabel="Open file links in"
            options={[
              { value: 'clui', label: 'Clui' },
              { value: 'editor', label: 'Editor' }
            ]}
            onChange={files.set}
          />
        </Field>
        <CheckField
          setting="annotateScreenshots"
          ui="annotate-screenshots"
          label="Point"
          hint="Off sends only the text of what you point at, and its HTML on web pages."
          text="Include a picture with what you point at"
        />
      </SubPane>
      <BrowserSection active={sub === 'browser'} />
    </Pane>
  )
}
