import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../lib/feedback', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))
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

it('asks for the Master Password and sends it when an app lock exists', async () => {
  getTauriInvoke().mockImplementation((command: string) => Promise.resolve(
    command === 'read_protection_state' ? { lockEnabled: true, encryptionEnabled: false } : {
      path: 'C:/safe/Kivo Backup', createdAt: '2026-09-24', appVersion: '0.1', schemaVersion: 16,
      itemCount: 0, fileCount: 0, valid: true, problems: [], encrypted: true,
    }))
  render(<BackupSettings />)
  expect(await screen.findByText(/encrypted with your Master Password/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))
  expect(await screen.findByText('Enter your Master Password to encrypt the backup.')).toBeInTheDocument()
  expect(getTauriInvoke()).not.toHaveBeenCalledWith('create_backup_now', expect.anything())

  fireEvent.change(screen.getByLabelText('Master Password'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('create_backup_now', { folder: null, password: 'secret' }))
  expect(await screen.findByText(/Encrypted, made 2026-09-24/)).toBeInTheDocument()
})

it('checks vault health, lists problems by kind and repairs one kind', async () => {
  let fixed = false
  getTauriInvoke().mockImplementation((command: string) => {
    if (command === 'read_protection_state') return Promise.resolve({ lockEnabled: false, encryptionEnabled: false })
    if (command === 'repair_vault_health') { fixed = true; return Promise.resolve(1) }
    if (command === 'check_vault_health') return Promise.resolve({
      databaseProblem: null,
      problems: fixed ? [] : [
        { kind: 'missing_file', id: 'file-1', label: 'Lease.pdf' },
        { kind: 'stray_file', id: 'orphan.bin', label: 'orphan.bin' },
      ],
      skipped: ['Saved passwords were not checked. Unlock the password vault to include them.'],
    })
    return Promise.resolve(null)
  })
  render(<BackupSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Check vault health' }))

  const dialog = await screen.findByRole('dialog', { name: 'Vault health' })
  const missing = await within(dialog).findByRole('region', { name: '1 file is missing or changed' })
  expect(within(missing).getByText('Lease.pdf')).toBeInTheDocument()
  expect(within(dialog).getByText(/Saved passwords were not checked/)).toBeInTheDocument()

  fireEvent.click(within(missing).getByRole('button', { name: 'Move items to Trash' }))
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('repair_vault_health', { kind: 'missing_file', ids: ['file-1'] }))
  expect(await within(dialog).findByText(/No problems found/)).toBeInTheDocument()
})

it('warns that exports are not encrypted and never imports before a file is picked', async () => {
  getTauriInvoke().mockResolvedValue(null)
  render(<PortabilitySettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Import Kivo export' }))
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('pick_file'))
  expect(getTauriInvoke()).not.toHaveBeenCalledWith('import_json', expect.anything())
  expect(screen.getByText(/not encrypted/i)).toBeInTheDocument()
})
