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
