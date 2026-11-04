import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconMore } from '../Icon'
import { Menu } from '../Menu'
import { usePopover } from '../Popover'
import { PANE_BTN } from './PaneHeader'
import { TEXT_BTN } from './fileDoc'

/** A workbook's sheets as tabs, hidden ones last. ←/→, Home and End move and activate. */
export function SheetTabs({ sheets, active, onSelect }: { sheets: { name: string; hidden: boolean }[]; active: number; onSelect: (i: number) => void }): JSX.Element {
  const order = [...sheets.keys()].sort((a, b) => Number(sheets[a].hidden) - Number(sheets[b].hidden))
  const list = useRef<HTMLDivElement | null>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const ro = new ResizeObserver(() => setOver(el.scrollWidth > el.clientWidth + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [sheets.length])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  const onKeyDown = (e: KeyboardEvent): void => {
    const at = order.indexOf(active)
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : -2
    if (to === -2) return
    e.preventDefault()
    const i = order[Math.max(0, Math.min(order.length - 1, to))]
    onSelect(i)
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  }
  return (
    <>
      {over && (
        <Menu
          label="All sheets"
          align="start"
          placement="up"
          trigger={{ className: `${PANE_BTN} my-0.5 ml-1 shrink-0`, 'aria-label': 'All sheets', title: 'All sheets', 'data-ui': 'sheet-all' }}
          items={order.map((i) => ({ key: String(i), label: sheets[i].hidden ? `${sheets[i].name} · hidden` : sheets[i].name, type: 'radio' as const, checked: i === active, onClick: () => onSelect(i) }))}
        >
          <IconMore className="h-4 w-4" />
        </Menu>
      )}
      <div ref={list} role="tablist" aria-label="Sheets" data-ui="sheet-tabs" className="flex min-w-0 flex-1 overflow-x-auto scrollbar-none" onKeyDown={onKeyDown}>
        {order.map((i) => {
          const on = i === active
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={sheets[i].name}
              onClick={() => onSelect(i)}
              className={`h-8 max-w-[200px] shrink-0 truncate px-3 text-label ${on ? 'bg-bg font-medium text-content shadow-[inset_0_2px_0_var(--color-content)]' : 'text-dim pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content'}`}
            >
              {sheets[i].name}
              {sheets[i].hidden && <span className="font-normal text-faint"> · hidden</span>}
            </button>
          )
        })}
      </div>
    </>
  )
}

/** The strip's count of what Clui doesn't draw from the workbook, opening the sentences that say what. */
export function NotShown({ name, sheet, book, hidden, onHidden, onOpen }: {
  name: string
  sheet: string[]
  book: string[]
  /** The hidden rows and columns sentence, how many it counts, and whether they're shown. */
  hidden: { text: string; shown: boolean; n: number } | null
  onHidden: () => void
  onOpen: () => void
}): JSX.Element | null {
  const p = usePopover({ placement: 'up', align: 'end' })
  const n = sheet.length + book.length + (hidden ? 1 : 0)
  if (!n) return null
  const head = 'sheet-not-shown-head'
  const group = (label: string, items: JSX.Element[]): JSX.Element | null =>
    items.length ? (
      <div className="flex flex-col gap-1.5">
        <p className="text-meta text-faint">{label}</p>
        {items}
      </div>
    ) : null
  return (
    <>
      <button type="button" className={`${TEXT_BTN} shrink-0 text-label`} title={`What Clui doesn't show from ${name}`} data-ui="sheet-not-shown" {...p.triggerProps}>
        {`${n} not shown`}
      </button>
      <div {...p.popoverProps} role="dialog" aria-labelledby={head} className="pop-base pop glass-thick flex w-[320px] flex-col gap-3 rounded-lg p-3">
        <p id={head} className="text-ui font-medium text-content">
          Not shown in Clui
        </p>
        {group('On this sheet', [
          ...sheet.map((t) => (
            <p key={t} className="text-ui text-dim">
              {t}
            </p>
          )),
          ...(hidden
            ? [
                <div key="hidden" className="flex items-center justify-between gap-2">
                  <p className="text-ui text-dim">{hidden.text}</p>
                  <button type="button" className={`${TEXT_BTN} shrink-0 text-ui`} onClick={onHidden}>
                    {`${hidden.shown ? 'Hide' : 'Show'} ${hidden.n === 1 ? 'it' : 'them'}`}
                  </button>
                </div>
              ]
            : [])
        ])}
        {group(
          'In this workbook',
          book.map((t) => (
            <p key={t} className="text-ui text-dim">
              {t}
            </p>
          ))
        )}
        <button
          type="button"
          className={`${TEXT_BTN} self-start text-ui`}
          onClick={() => {
            p.close({ returnFocus: false })
            onOpen()
          }}
        >
          Open in default app
        </button>
      </div>
    </>
  )
}
