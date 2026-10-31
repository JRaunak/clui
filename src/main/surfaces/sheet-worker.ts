// The sheet worker: one utilityProcess per workbook open, with its own heap. Main hands it the file's bytes and a port to
// the tab's renderer worker; it posts the book through that port and exits once the renderer has it. A heap that runs
// out kills only this process, which main reports as the out-of-memory state.
import type { MessagePortMain } from 'electron'
import { readWorkbook } from './workbook'

process.parentPort.once('message', (e: { data: { bytes: Uint8Array }; ports: MessagePortMain[] }) => {
  const port = e.ports[0]
  port.on('message', (m) => {
    if ((m.data as { t?: string } | null)?.t === 'got') process.exit(0)
  })
  port.start()
  void readWorkbook(e.data.bytes, (f) => port.postMessage({ t: 'progress', f })).then(
    (out) => {
      if ('t' in out) return port.postMessage({ t: 'failed', failure: out })
      port.postMessage({ t: 'facts', facts: out.facts, date1904: out.date1904 })
      // One message per sheet keeps each under IPC's message size limit.
      out.sheets.forEach((sheet, i) => port.postMessage({ t: 'sheet', i, sheet }))
      port.postMessage({ t: 'done' })
    },
    () => port.postMessage({ t: 'failed', failure: { t: 'damaged' } })
  )
})
