import { invoke } from './runtime'

export type SetupInput = {
  ownerName: string
  vaultName: string
  starterCollections: string[]
  passwordVerifier: string | null
}

export type BootState = 'onboarding' | 'ready' | 'locked'

export async function loadBootState(): Promise<BootState> {
  return invoke<BootState>('load_boot_state')
}

export async function completeSetup(input: SetupInput): Promise<void> {
  if (!input.ownerName.trim()) {
    throw new Error('Owner name is required')
  }

  await invoke<void>('complete_setup', { input })
}

/** Deletes every note, source, file, password, and setting, then starts over at onboarding. */
export async function resetVault(password: string | null): Promise<void> {
  await invoke<void>('reset_vault', { password })
}

/** True when an app lock or password vault is set, so a reset must ask for its password. */
export async function resetRequiresPassword(): Promise<boolean> {
  return invoke<boolean>('reset_requires_password')
}

/** Fails when the password a reset needs is wrong. Nothing is deleted. */
export async function verifyResetPassword(password: string): Promise<void> {
  await invoke<void>('verify_reset_password', { password })
}
