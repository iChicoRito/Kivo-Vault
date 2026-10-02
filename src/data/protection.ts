import { notifySecurityChanged } from './events'
import { invoke } from './runtime'

export type ProtectionState = { lockEnabled: boolean; encryptionEnabled: boolean }

export const readProtectionState = () => invoke<ProtectionState>('read_protection_state')
export const unlockVault = (password: string) => invoke<boolean>('unlock_content_vault', { password })
export const lockVault = () => invoke<void>('lock_content_vault')
export const enableEncryption = async (password: string) => {
  await invoke<void>('enable_encryption', { password })
  notifySecurityChanged()
}
export const disableEncryption = async (password: string) => {
  await invoke<void>('disable_encryption', { password })
  notifySecurityChanged()
}
export const changeMasterPassword = async (current: string, next: string) => {
  await invoke<void>('change_master_password', { current, next })
  notifySecurityChanged()
}
