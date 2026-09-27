import tauriConfig from '../src-tauri/tauri.conf.json'

const file = `${tauriConfig.productName}_${tauriConfig.version}_x64-setup.exe`

/** `vite.landing.config.ts` copies this file into `downloads/` at build time. */
export const INSTALLER = {
  file,
  href: `downloads/${file}`,
  version: tauriConfig.version,
}
