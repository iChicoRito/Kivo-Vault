import { invoke } from './runtime'
import type { VaultScope } from './recovery'

export type DeviceUnlockStatus = {
  scope: VaultScope
  available: boolean
  enrolled: boolean
  /** Why Windows Hello cannot be used right now, in plain words. */
  unavailableReason: string | null
}

export type DeviceUnlockResult = { status: 'unlocked' | 'enrolled' | 'cancelled' }

export const readDeviceUnlockStatus = async (scope: VaultScope) =>
  invoke<DeviceUnlockStatus>('read_device_unlock_status', { scope })

/** Checks the password, then shows the Windows Hello prompt. */
export const enrollDeviceUnlock = async (scope: VaultScope, password: string) =>
  invoke<DeviceUnlockResult>('enroll_device_unlock', { scope, password })

export const unlockWithDevice = async (scope: VaultScope) =>
  invoke<DeviceUnlockResult>('unlock_with_device', { scope })

export const disableDeviceUnlock = async (scope: VaultScope, password: string) =>
  invoke<void>('disable_device_unlock', { scope, password })
