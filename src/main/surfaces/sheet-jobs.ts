import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { IpcChannels } from '../../shared/ipc'

// The heap a workbook gets: exceljs holds about 600 B a cell, so the 2-million-cell ceiling needs about 1.2 GB.
const HEAP_MB = 1280

/** Sheet worker processes by the id of the open that started each, so a tab's Stop or close ends exactly its own. */
export function sheetJobs(entry: string, push: (channel: string, payload: unknown) => void) {
  const jobs = new Map<string, { child: UtilityProcess; handleId: string; stopped: boolean }>()
  const stop = (id: string): void => {
    const j = jobs.get(id)
    if (!j) return
    j.stopped = true
    j.child.kill()
  }
  return {
    start(wc: WebContents, handleId: string, id: string, bytes: Buffer): void {
      stop(id)
      // No environment: the reader needs none, and the process never sees the app's.
      const child = utilityProcess.fork(entry, [], { execArgv: [`--max-old-space-size=${HEAP_MB}`], env: {}, stdio: 'ignore', serviceName: 'Clui sheet reader' })
      const job = { child, handleId, stopped: false }
      jobs.set(id, job)
      child.on('exit', (code) => {
        if (jobs.get(id) === job) jobs.delete(id)
        if (code !== 0 && !job.stopped) push(IpcChannels.sheetExit, { id, code })
      })
      const { port1, port2 } = new MessageChannelMain()
      child.postMessage({ bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }, [port1])
      wc.postMessage(IpcChannels.sheetPort, id, [port2])
    },
    stop,
    dispose(handleId: string): void {
      for (const [id, j] of jobs) if (j.handleId === handleId) stop(id)
    },
    disposeAll(): void {
      for (const id of [...jobs.keys()]) stop(id)
    }
  }
}
