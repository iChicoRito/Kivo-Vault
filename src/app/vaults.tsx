import { createContext, useContext } from 'react'

/** Opens another vault. App restarts its boot flow, so every page remounts. */
export const VaultSwitchContext = createContext<((id: string) => Promise<void>) | null>(null)

export function useVaultSwitch() {
  return useContext(VaultSwitchContext)
}
