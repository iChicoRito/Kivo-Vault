import { invoke } from './runtime'

export type VaultSummary = {
  id: string
  name: string
}

export type VaultList = {
  activeId: string
  vaults: VaultSummary[]
}

export function listVaults() {
  return invoke<VaultList>('list_vaults')
}

export function switchVault(id: string) {
  return invoke<void>('switch_vault', { id })
}

/** Creates an empty vault and opens it in the backend. Setup follows with `completeSetup`. */
export function createVault(name: string) {
  return invoke<VaultSummary>('create_vault', { name })
}

/** Deletes the open vault once its exact name is typed, then opens another vault (returned). */
export function deleteVault(id: string, confirmName: string) {
  return invoke<VaultSummary>('delete_vault', { id, confirmName })
}
