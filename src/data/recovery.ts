import { invoke } from './runtime'

/** `content` is notes, sources and files; `passwords` is the password vault. */
export type VaultScope = 'content' | 'passwords'

export type RecoveryStatus = { scope: VaultScope; available: boolean; enabled: boolean }

/** Shown once during setup. Never store it in the app. */
export type RecoveryDraft = { token: string; recoveryKey: string; expiresInSeconds: number }

export const readRecoveryStatus = async (scope: VaultScope) =>
  invoke<RecoveryStatus>('read_recovery_status', { scope })

export const beginRecoverySetup = async (scope: VaultScope, password: string) =>
  invoke<RecoveryDraft>('begin_recovery_setup', { scope, password })

/** Opens the native save dialog. `false` means the user cancelled. */
export const saveRecoveryKit = async (token: string) => invoke<boolean>('save_recovery_kit', { token })

export const confirmRecoverySetup = async (token: string, recoveryKey: string) =>
  invoke<void>('confirm_recovery_setup', { token, recoveryKey })

export const cancelRecoverySetup = async (token: string) => invoke<void>('cancel_recovery_setup', { token })

export const disableRecovery = async (scope: VaultScope, password: string) =>
  invoke<void>('disable_recovery', { scope, password })

export const recoverVault = async (scope: VaultScope, recoveryKey: string, newPassword: string) =>
  invoke<void>('recover_vault', { scope, recoveryKey, newPassword })

export function errorText(error: unknown, fallback: string): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return text.trim() ? text.replace(/^Error:\s*/, '') : fallback
}
