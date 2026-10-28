import { useId } from 'react'
import type { FileLinkTarget } from '../../../../shared/settings'
import { LINK_MOD } from '../../lib/openLink'
import { Dropdown } from '../Dropdown'
import { FieldError } from '../LoginFields'
import { BrowserSection } from './BrowserSection'
import { CheckField, Field, Pane, SAVE_FAILED, SubNav, SubPane, TIMING, useInstantSetting, useSettingsSub } from './shared'

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'browser', label: 'Browser' },
  { key: 'artifacts', label: 'Artifacts' }
] as const

const APPLY = 'Open pages reload with the new setting.'

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
          hint="Off sends only the text of what you point at, its HTML on web pages, and its position on images."
          text="Include a picture with what you point at"
        />
      </SubPane>
      <BrowserSection active={sub === 'browser'} />
      <SubPane section="pane" sub="artifacts" active={sub === 'artifacts'} className="flex flex-col gap-5">
        <p className="text-meta text-dim">
          HTML pages Claude creates in a session open as artifacts, marked Made by Claude. These settings apply only to them; other HTML files always
          run offline.
        </p>
        <CheckField
          setting="artifactRemoteResources"
          ui="artifact-remote"
          label="Web resources"
          hint={`Lets pages use libraries and fonts from CDNs over HTTPS. Those scripts run with the page's access and can send what it shows to their servers. ${APPLY}`}
          text="Load scripts, styles and fonts from the web"
        />
        <CheckField
          setting="artifactNetworkRequests"
          ui="artifact-network"
          label="Data requests"
          hint={`Lets pages read data files in their own folder and connect to any address over HTTPS or WSS, and to localhost and 127.0.0.1 for local dev servers. Pages never get your browser's logins or cookies, or files outside their folder. ${APPLY}`}
          text="Let pages fetch data"
        />
      </SubPane>
    </Pane>
  )
}
