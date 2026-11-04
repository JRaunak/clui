import { useId } from 'react'
import { usePopover } from '../Popover'
import { TEXT_BUTTON } from './ImageSurface'
import { openDefault, TEXT_BTN } from './fileDoc'

/** The toolbar's first item on a view Clui didn't draw from the file as its app would: whose layout it is, as a
 *  button whose panel says what can differ, so the caveat reaches keyboard and screen reader alike. */
export function AboutView({ ui, label, title, heading, sentences, handleId, path }: {
  ui: string
  label: string
  title: string
  heading: string
  sentences: string[]
  handleId: string
  path: string
}): JSX.Element {
  const panel = usePopover({ placement: 'down', align: 'start' })
  const head = `${ui}-head${useId().replace(/:/g, '')}`
  return (
    <>
      <button type="button" data-ui={ui} {...panel.triggerProps} aria-haspopup="dialog" title={title} className={TEXT_BUTTON}>
        {label}
      </button>
      <div {...panel.popoverProps} role="dialog" aria-labelledby={head} data-ui={`${ui}-panel`} className="pop-base pop glass-thick flex w-[320px] flex-col gap-3 rounded-lg p-3">
        <p id={head} className="text-ui font-medium text-content">
          {heading}
        </p>
        {sentences.map((t) => (
          <p key={t} className="text-ui text-dim">
            {t}
          </p>
        ))}
        <button
          type="button"
          className={`${TEXT_BTN} -ml-2 self-start text-ui`}
          onClick={() => {
            panel.close({ returnFocus: false })
            void openDefault(handleId, path)
          }}
        >
          Open in default app
        </button>
      </div>
    </>
  )
}
