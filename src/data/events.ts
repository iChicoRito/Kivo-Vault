import { listen } from '@tauri-apps/api/event'

import { isTauriRuntime } from './runtime'

/** Window event that fires after any vault write that changes items or collections. */
export const VAULT_CHANGED_EVENT = 'kivo:vault-changed'

/**
 * Tells listeners (the collection sidepanel) to reload their data. The panel
 * already works from window events for drag and drop, so writes announce
 * themselves the same way instead of depending on props or a store.
 */
export function notifyVaultChanged(): void {
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT))
}

/** Window event that fires after the Master Password, app lock or encryption changes. */
export const SECURITY_CHANGED_EVENT = 'kivo:security-changed'

/**
 * Tells the security settings cards to read their status again. Windows Hello,
 * recovery kits and encryption depend on the Master Password, so setting or
 * removing it must update them without reopening the page.
 */
export function notifySecurityChanged(): void {
  window.dispatchEvent(new Event(SECURITY_CHANGED_EVENT))
}

export type CollectionAccessChange = { accessEpoch: number }

/**
 * Runs `handler` whenever a protected collection locks or unlocks, so views
 * that name saved items can drop what may now be hidden. Returns the unsubscribe.
 */
export function onCollectionAccessChanged(
  handler: (change: CollectionAccessChange) => void,
): () => void {
  if (!isTauriRuntime()) return () => undefined

  let stop: (() => void) | null = null
  let stopped = false
  void listen<CollectionAccessChange>('collection-access-changed', (event) =>
    handler(event.payload),
  ).then((unlisten) => {
    if (stopped) unlisten()
    else stop = unlisten
  })

  return () => {
    stopped = true
    stop?.()
  }
}
