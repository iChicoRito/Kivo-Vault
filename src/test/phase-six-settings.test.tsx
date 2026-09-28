import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { getTauriInvoke } from './setup'
import EncryptionSettings from '../features/security/EncryptionSettings'
import BackupSettings from '../features/backup/BackupSettings'
import PortabilitySettings from '../features/portability/PortabilitySettings'

beforeEach(() => getTauriInvoke().mockReset())

it('requires a master password before encryption, warns about external temp files', async () => {
  getTauriInvoke().mockResolvedValue({ lockEnabled: false, encryptionEnabled: false })
  render(<EncryptionSettings />)
  await waitFor(() => expect(screen.getByText(/set a Master Password/i)).toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Turn on encryption' })).toBeDisabled()
  expect(screen.getByText(/temp/i)).toBeInTheDocument()
})

it('backs up in one click, or into a picked folder, and leaves automatic backup off', async () => {
  getTauriInvoke().mockImplementation((command: string) => Promise.resolve(command === 'pick_backup_destination' ? 'C:/safe' : {
    path: 'C:/safe/Kivo Backup', createdAt: '2026-09-24', appVersion: '0.1', schemaVersion: 12,
    itemCount: 2, fileCount: 1, valid: true, problems: [],
  }))
  render(<BackupSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('create_backup_now', { folder: null }))
  expect(getTauriInvoke()).not.toHaveBeenCalledWith('pick_backup_destination')
  expect(await screen.findByText(/This backup looks good/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Back up to folder...' }))
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('create_backup_now', { folder: 'C:/safe' }))
  expect(screen.getByText(/does not make backups automatically/i)).toBeInTheDocument()
})

it('warns that exports are not encrypted and never imports before a file is picked', async () => {
  getTauriInvoke().mockResolvedValue(null)
  render(<PortabilitySettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Import Kivo export' }))
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('pick_file'))
  expect(getTauriInvoke()).not.toHaveBeenCalledWith('import_json', expect.anything())
  expect(screen.getByText(/not encrypted/i)).toBeInTheDocument()
})
