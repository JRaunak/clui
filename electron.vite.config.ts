import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// pdf.js fetches these by URL only when a PDF needs them, so they ship as files beside the bundle under `pdfjs/`: the
// JPX, JBIG2 and ICC decoders (not the scripting engine or the no-wasm fallbacks), the standard fonts and the CJK maps.
const PDF_ASSETS: Record<string, RegExp> = { wasm: /^(jbig2|openjpeg|qcms_bg)\.wasm$|^LICENSE/, standard_fonts: /./, cmaps: /./ }
function pdfAssets(): Plugin {
  const root = resolve(__dirname, 'node_modules/pdfjs-dist')
  const files = (): string[] => Object.entries(PDF_ASSETS).flatMap(([dir, keep]) => readdirSync(join(root, dir)).filter((f) => keep.test(f)).map((f) => `${dir}/${f}`))
  return {
    name: 'pdf-assets',
    configureServer(server) {
      const shipped = new Set(files())
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const f = decodeURIComponent((req.url ?? '').split('?')[0].slice(1))
        if (!shipped.has(f)) return next()
        if (f.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm')
        res.end(readFileSync(join(root, f)))
      })
    },
    generateBundle() {
      for (const f of files()) this.emitFile({ type: 'asset', fileName: `pdfjs/${f}`, source: readFileSync(join(root, f)) })
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react(), tailwindcss(), pdfAssets()],
    worker: {
      // Vite resolves workers with the browser condition, and this package's browser build decodes entities through
      // document.createElement, which a worker doesn't have. Its worker build uses a lookup table instead.
      plugins: () => [
        {
          name: 'worker-entities',
          enforce: 'pre' as const,
          resolveId: (id: string) =>
            id === 'decode-named-character-reference' ? resolve(__dirname, 'node_modules/decode-named-character-reference/index.js') : null
        }
      ]
    }
  }
})
