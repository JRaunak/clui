import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

type Lib = typeof import('pdfjs-dist')
type Viewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs')

let loading: Promise<{ lib: Lib; viewer: Viewer }> | null = null

/** pdf.js and its viewer components, fetched with the first PDF. The viewer reads the library from a global the
 *  library sets, so they load in that order. */
export function loadPdf(): Promise<{ lib: Lib; viewer: Viewer }> {
  loading ??= (async () => {
    const lib = await import('pdfjs-dist')
    lib.GlobalWorkerOptions.workerSrc = workerUrl
    return { lib, viewer: await import('pdfjs-dist/web/pdf_viewer.mjs') }
  })().catch((e: unknown) => {
    loading = null
    throw e
  })
  return loading
}

/** One of the asset folders the build ships beside the bundle, as pdf.js wants it: a URL ending in a slash. */
export const pdfAssets = (dir: 'wasm' | 'standard_fonts' | 'cmaps'): string => new URL(`pdfjs/${dir}/`, document.baseURI).href
