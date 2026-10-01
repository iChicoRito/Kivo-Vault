import '@testing-library/jest-dom/vitest'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  loadPreferences,
  loadProfile,
  savePreferences,
  saveProfile,
  saveStartAtLogin,
} from '../data/settings'
import { getTauriInvoke } from './setup'

const PROFILE = {
  ownerName: 'Ada',
  vaultName: "Ada's Vault",
  setupCompletedAt: null,
}

const PREFERENCES = {
  theme: 'dark',
  density: 'compact',
  startAtLogin: false,
  notesView: 'grid',
  sourcesView: 'grid',
  collectionsView: 'grid',
  navigationStyle: 'dock',
  autoLockMinutes: 0,
  semanticSearch: false,
  autoTag: false,
  summaries: false,
  clipboardClearSeconds: 0,
  clipboardExcludeHistory: false,
  linkDetails: true,
} as const

beforeEach(() => {
  getTauriInvoke().mockReset()
})

describe('settings data contract', () => {
  it('reads the profile with load_profile and no arguments', async () => {
    getTauriInvoke().mockResolvedValue({ ...PROFILE })

    await expect(loadProfile()).resolves.toEqual(PROFILE)
    expect(getTauriInvoke()).toHaveBeenCalledWith('load_profile')
  })

  it('writes the profile through save_profile with { profile }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await saveProfile({ ownerName: 'Ada', vaultName: "Ada's Vault" })

    expect(getTauriInvoke()).toHaveBeenCalledWith('save_profile', {
      profile: { ownerName: 'Ada', vaultName: "Ada's Vault" },
    })
  })

  it('reads preferences with load_preferences and no arguments', async () => {
    getTauriInvoke().mockResolvedValue({ ...PREFERENCES })

    await expect(loadPreferences()).resolves.toEqual(PREFERENCES)
    expect(getTauriInvoke()).toHaveBeenCalledWith('load_preferences')
  })

  it('writes preferences through save_preferences with { preferences }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await savePreferences({ ...PREFERENCES })

    expect(getTauriInvoke()).toHaveBeenCalledWith('save_preferences', {
      preferences: { ...PREFERENCES },
    })
  })

  it('preserves every sibling preference when saving start at login', async () => {
    getTauriInvoke().mockResolvedValueOnce({ ...PREFERENCES }).mockResolvedValueOnce(undefined)

    await saveStartAtLogin(true)

    expect(getTauriInvoke()).toHaveBeenNthCalledWith(1, 'load_preferences')
    expect(getTauriInvoke()).toHaveBeenNthCalledWith(2, 'save_preferences', {
      preferences: { ...PREFERENCES, startAtLogin: true },
    })
  })
})
