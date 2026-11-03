import { useId } from 'react'
import type { FileLinkTarget, LinkTarget } from '../../../../shared/settings'
import { LINK_MOD } from '../../lib/openLink'
import { useSettings } from '../../lib/settings'
import { Dropdown } from '../Dropdown'
import { FieldError } from '../LoginFields'
import { CheckField, Field, Group, SAVE_FAILED, TIMING, describedBy, useInstantSetting } from './shared'

const APPLY = 'Open pages reload with the new setting.'

export function PaneSection(): JSX.Element {
  const files = useInstantSetting('fileLinkTarget')
  const web = useInstantSetting('linkTarget')
  const browser = useSettings((s) => !!s?.values.browserEnabled)
  const uid = useId()
  return (
    <>
      <CheckField
        setting="surfaceTools"
        ui="surface-tools"
        label="Pane access"
        hint={`Claude can see what the pane shows and open files, folders, browser tabs and changes there. References you send still work with this off. Quick sessions never have it. ${TIMING}`}
        text="Claude can show things in the pane"
      />

      <Group id="settings-group-links" label="Links">
        <Field
          label="Open file links in"
          hint={`Applies to file paths in Claude's replies and tool calls. ${LINK_MOD}-click opens the other way.`}
          hintId={`${uid}-files-hint`}
          onReset={files.value && files.value !== 'clui' ? files.reset : undefined}
          note={files.failed && <FieldError id={`${uid}-files-err`} text={SAVE_FAILED} />}
        >
          <Dropdown<FileLinkTarget>
            value={files.value ?? 'clui'}
            ariaLabel="Open file links in"
            ariaDescribedBy={describedBy(`${uid}-files-hint`, files.failed && `${uid}-files-err`)}
            dataUi="file-link-target"
            options={[
              { value: 'clui', label: 'Clui' },
              { value: 'editor', label: 'Editor' }
            ]}
            onChange={files.set}
          />
        </Field>
        <Field
          label="Open web links in"
          hint={
            browser
              ? `Applies to web links in Claude's replies and tool output. ${LINK_MOD}-click opens the other way.`
              : 'Takes effect when browser access is on. Until then, links open in your default browser.'
          }
          hintId={`${uid}-links-hint`}
          onReset={web.value && web.value !== 'clui' ? web.reset : undefined}
          note={web.failed && <FieldError id={`${uid}-links-err`} text={SAVE_FAILED} />}
        >
          <Dropdown<LinkTarget>
            value={web.value ?? 'clui'}
            ariaLabel="Open web links in"
            ariaDescribedBy={describedBy(`${uid}-links-hint`, web.failed && `${uid}-links-err`)}
            dataUi="link-target"
            options={[
              { value: 'clui', label: "Clui's browser" },
              { value: 'system', label: 'Default browser' }
            ]}
            onChange={web.set}
          />
        </Field>
      </Group>

      <Group id="settings-group-point" label="Point">
        <CheckField
          setting="annotateScreenshots"
          ui="annotate-screenshots"
          hint="Off sends only the text of what you point at, its HTML on web pages, and its position on images."
          text="Include a picture with what you point at"
        />
      </Group>

      <Group id="settings-group-artifacts" label="Artifacts">
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
      </Group>
    </>
  )
}
