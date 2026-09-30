import '@testing-library/jest-dom/vitest'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  deleteCredentialsPermanently,
  importCredentials,
  listCredentialVersions,
  previewPasswordImport,
  restoreCredentialVersion,
  listCredentials,
  loadCredential,
  lockVault,
  restoreCredentials,
  saveCredential,
  setCredentialsFavorite,
  setupVault,
  trashCredentials,
  unlockVault,
  vaultStatus,
  type Credential,
  type CredentialFilter,
  type CredentialInput,
  type CredentialSummary,
} from '../data/passwords'
import { copySecret, copyText } from '../lib/clipboard'
import { getTauriInvoke } from './setup'

const notifyVaultChanged = vi.hoisted(() => vi.fn())

vi.mock('../data/events', () => ({
  notifyVaultChanged,
}))

const STATUS = { configured: true, unlocked: true }

const CREDENTIAL: Credential = {
  id: '4f2a9c1b8d3e5f60718293a4b5c6d7e8',
  service: 'GitHub',
  username: 'ada@example.com',
  url: 'https://github.com',
  category: 'Development',
  tags: ['work', 'code'],
  isFavorite: false,
  deletedAt: null,
  createdAt: '2026-09-14T09:30:00.000Z',
  updatedAt: '2026-09-16T14:05:00.000Z',
  notes: 'Personal access token',
  password: 'correct-horse-battery',
}

const SUMMARY: CredentialSummary = {
  id: CREDENTIAL.id,
  service: CREDENTIAL.service,
  username: CREDENTIAL.username,
  url: CREDENTIAL.url,
  category: CREDENTIAL.category,
  tags: CREDENTIAL.tags,
  isFavorite: CREDENTIAL.isFavorite,
  deletedAt: CREDENTIAL.deletedAt,
  createdAt: CREDENTIAL.createdAt,
  updatedAt: CREDENTIAL.updatedAt,
}

beforeEach(() => {
  getTauriInvoke().mockReset()
  notifyVaultChanged.mockReset()
})

describe('passwords data contract', () => {
  it('reads the vault status with vault_status and no arguments', async () => {
    getTauriInvoke().mockResolvedValue({ ...STATUS })

    await expect(vaultStatus()).resolves.toEqual(STATUS)
    expect(getTauriInvoke()).toHaveBeenCalledWith('vault_status')
    expect(notifyVaultChanged).not.toHaveBeenCalled()
  })

  it('creates the vault with setup_vault and { masterPassword }', async () => {
    getTauriInvoke().mockResolvedValue({ ...STATUS })

    await expect(setupVault('hunter2-hunter2')).resolves.toEqual(STATUS)
    expect(getTauriInvoke()).toHaveBeenCalledWith('setup_vault', {
      masterPassword: 'hunter2-hunter2',
    })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('unlocks the vault with unlock_vault and { masterPassword }', async () => {
    getTauriInvoke().mockResolvedValue({ ...STATUS })

    await expect(unlockVault('hunter2-hunter2')).resolves.toEqual(STATUS)
    expect(getTauriInvoke()).toHaveBeenCalledWith('unlock_vault', {
      masterPassword: 'hunter2-hunter2',
    })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('locks the vault with lock_vault and no arguments', async () => {
    getTauriInvoke().mockResolvedValue({ configured: true, unlocked: false })

    await expect(lockVault()).resolves.toEqual({ configured: true, unlocked: false })
    expect(getTauriInvoke()).toHaveBeenCalledWith('lock_vault')
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('lists credentials with list_credentials and a null filter by default', async () => {
    getTauriInvoke().mockResolvedValue([SUMMARY])

    await expect(listCredentials()).resolves.toEqual([SUMMARY])
    expect(getTauriInvoke()).toHaveBeenCalledWith('list_credentials', { filter: null })
    expect(notifyVaultChanged).not.toHaveBeenCalled()
  })

  it('passes a full filter through list_credentials', async () => {
    const filter: CredentialFilter = {
      query: 'git',
      category: 'Development',
      tag: 'work',
      favorite: true,
      trashed: false,
    }

    getTauriInvoke().mockResolvedValue([])

    await expect(listCredentials(filter)).resolves.toEqual([])
    expect(getTauriInvoke()).toHaveBeenCalledWith('list_credentials', { filter })
  })

  it('loads one credential with load_credential and { id }', async () => {
    getTauriInvoke().mockResolvedValue({ ...CREDENTIAL })

    await expect(loadCredential(CREDENTIAL.id)).resolves.toEqual(CREDENTIAL)
    expect(getTauriInvoke()).toHaveBeenCalledWith('load_credential', { id: CREDENTIAL.id })
    expect(notifyVaultChanged).not.toHaveBeenCalled()
  })

  it('saves a credential with save_credential and { input }', async () => {
    const input: CredentialInput = {
      id: CREDENTIAL.id,
      service: 'GitHub',
      username: 'ada@example.com',
      password: 'correct-horse-battery',
      url: 'https://github.com',
      category: 'Development',
      tags: ['work', 'code'],
      notes: 'Personal access token',
      isFavorite: false,
    }

    getTauriInvoke().mockResolvedValue({ ...CREDENTIAL })

    await expect(saveCredential(input)).resolves.toEqual(CREDENTIAL)
    expect(getTauriInvoke()).toHaveBeenCalledWith('save_credential', { input })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('marks credentials favorite with set_credentials_favorite and { ids, favorite }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await expect(setCredentialsFavorite([CREDENTIAL.id], true)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('set_credentials_favorite', {
      ids: [CREDENTIAL.id],
      favorite: true,
    })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('trashes credentials with trash_credentials and { ids }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await expect(trashCredentials([CREDENTIAL.id])).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('trash_credentials', { ids: [CREDENTIAL.id] })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('restores credentials with restore_credentials and { ids }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await expect(restoreCredentials([CREDENTIAL.id])).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('restore_credentials', { ids: [CREDENTIAL.id] })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })

  it('deletes credentials forever with delete_credentials_permanently and { ids }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await expect(deleteCredentialsPermanently([CREDENTIAL.id])).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('delete_credentials_permanently', {
      ids: [CREDENTIAL.id],
    })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })
})

describe('credential history', () => {
  it('lists versions with list_credential_versions and { id }', async () => {
    getTauriInvoke().mockResolvedValue([])

    await expect(listCredentialVersions('cred-1')).resolves.toEqual([])
    expect(getTauriInvoke()).toHaveBeenCalledWith('list_credential_versions', { id: 'cred-1' })
  })

  it('restores a version with restore_credential_version and tells the app', async () => {
    getTauriInvoke().mockResolvedValue(CREDENTIAL)

    await expect(restoreCredentialVersion('version-1')).resolves.toEqual(CREDENTIAL)
    expect(getTauriInvoke()).toHaveBeenCalledWith('restore_credential_version', {
      versionId: 'version-1',
    })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })
})

describe('password import', () => {
  it('previews a file with preview_password_import and { path }', async () => {
    getTauriInvoke().mockResolvedValue({ rows: [], skipped: 0 })

    await expect(previewPasswordImport('C:/export.csv')).resolves.toEqual({ rows: [], skipped: 0 })
    expect(getTauriInvoke()).toHaveBeenCalledWith('preview_password_import', { path: 'C:/export.csv' })
  })

  it('imports choices with import_credentials and tells the app', async () => {
    const result = { imported: 1, replaced: 0, failed: [] }
    const choice = { service: 'Forum', url: '', username: 'ada', password: 'p', notes: '', replaceId: null }
    getTauriInvoke().mockResolvedValue(result)

    await expect(importCredentials([choice])).resolves.toEqual(result)
    expect(getTauriInvoke()).toHaveBeenCalledWith('import_credentials', { choices: [choice] })
    expect(notifyVaultChanged).toHaveBeenCalledTimes(1)
  })
})

describe('copySecret', () => {
  it('hands the password to the Rust side in the desktop app', async () => {
    const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown }
    const original = tauriWindow.__TAURI_INTERNALS__
    tauriWindow.__TAURI_INTERNALS__ = { invoke: () => undefined }
    getTauriInvoke().mockResolvedValue(undefined)

    try {
      await expect(copySecret('s3cret')).resolves.toBeUndefined()
      expect(getTauriInvoke()).toHaveBeenCalledWith('copy_secret', { text: 's3cret' })
    } finally {
      tauriWindow.__TAURI_INTERNALS__ = original
    }
  })
})

describe('copyText', () => {
  it('writes through the clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const originalClipboard = navigator.clipboard

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    try {
      await expect(copyText('s3cret')).resolves.toBeUndefined()
      expect(writeText).toHaveBeenCalledWith('s3cret')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
    }
  })

  it('falls back to a hidden textarea when the clipboard API is unavailable', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand
    const execCommand = vi.fn().mockReturnValue(true)

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    document.execCommand = execCommand as unknown as typeof document.execCommand

    try {
      await expect(copyText('fallback')).resolves.toBeUndefined()
      expect(execCommand).toHaveBeenCalledWith('copy')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
      document.execCommand = originalExecCommand
    }
  })

  it('throws when both copy paths fail', async () => {
    const originalClipboard = navigator.clipboard
    const originalExecCommand = document.execCommand

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    document.execCommand = vi
      .fn()
      .mockReturnValue(false) as unknown as typeof document.execCommand

    try {
      await expect(copyText('nope')).rejects.toThrow('Could not copy to the clipboard')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
      document.execCommand = originalExecCommand
    }
  })
})
