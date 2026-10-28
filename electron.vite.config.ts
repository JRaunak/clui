import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    plugins: [react(), tailwindcss()],
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
