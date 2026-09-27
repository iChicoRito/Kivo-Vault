import { invoke as tauriInvoke } from '@tauri-apps/api/core'

import { browserInvoke } from './browser'

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: unknown
  }
}

type BrowserBackend = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/** Set by the landing page demo, which runs the app in a browser tab. The desktop app never sets it. */
let browserBackend: BrowserBackend | null = null

export function setBrowserBackend(backend: BrowserBackend | null) {
  browserBackend = backend
}

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false

  return typeof (window as TauriWindow).__TAURI_INTERNALS__?.invoke === 'function'
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime() || import.meta.env.MODE === 'test') {
    return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args)
  }

  if (browserBackend) return browserBackend<T>(command, args)

  if (import.meta.env.DEV) return browserInvoke<T>(command, args)

  return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args)
}
