import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import tauriConfig from './src-tauri/tauri.conf.json' with { type: 'json' }

// Same name the NSIS bundler gives the installer, see `bundle` in tauri.conf.json.
const INSTALLER = `${tauriConfig.productName}_${tauriConfig.version}_x64-setup.exe`
// A fresh local build wins. Hosts like Vercel cannot run the Tauri build, so they
// use the copy committed in landing/installer/ (refresh it for each release).
const INSTALLER_CANDIDATES = [
  `./src-tauri/target/release/bundle/nsis/${INSTALLER}`,
  `./landing/installer/${INSTALLER}`,
].map((path) => fileURLToPath(new URL(path, import.meta.url)))
const OUT_DIR = fileURLToPath(new URL('./dist-landing', import.meta.url))

function requireInstaller() {
  const source = INSTALLER_CANDIDATES.find((path) => existsSync(path))
  if (!source) {
    throw new Error(
      `${INSTALLER} was not found. Run \`pnpm tauri build\`, or copy it into landing/installer/.`,
    )
  }
  return source
}

/** Ships the installer next to the page, so the Download button needs no other host. */
function kivoInstaller(): Plugin {
  return {
    name: 'kivo-installer',
    buildStart() {
      requireInstaller()
    },
    closeBundle() {
      mkdirSync(`${OUT_DIR}/downloads`, { recursive: true })
      copyFileSync(requireInstaller(), `${OUT_DIR}/downloads/${INSTALLER}`)
    },
    configureServer(server) {
      server.middlewares.use(`/downloads/${INSTALLER}`, (_request, response) => {
        const source = requireInstaller()
        response.setHeader('Content-Type', 'application/octet-stream')
        createReadStream(source).pipe(response)
      })
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('./landing', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [react(), tailwindcss(), kivoInstaller()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 1430 },
  preview: { port: 1431 },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // The demo page bundles the whole app (~970 kB). It only loads when a visitor
    // scrolls near it, so its size does not slow the landing page's first view.
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      // The landing page, and the real app it embeds as the demo.
      input: {
        main: fileURLToPath(new URL('./landing/index.html', import.meta.url)),
        demo: fileURLToPath(new URL('./landing/demo.html', import.meta.url)),
      },
    },
  },
})
