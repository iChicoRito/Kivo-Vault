import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'

vi.mock('../lib/feedback', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))

import RestoreDialog from '../features/backup/RestoreDialog'
import { SelectiveRestoreDialog } from '../features/backup/SelectiveRestoreDialog'
import type { BackupInfo } from '../data/backup'

const KIT = 'KIVO-RECOVERY-V1:content:' + 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(64) + ':12345678'

function info(overrides: Partial<BackupInfo> = {}): BackupInfo {
  return {
    path: 'C:/safe/Kivo Backup',
    createdAt: '2026-10-01',
    appVersion: '0.3.0',
    schemaVersion: 20,
    itemCount: 0,
    fileCount: 0,
    valid: true,
    problems: [],
    encrypted: true,
    recoveryAvailable: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'alert').mockImplementation(() => undefined)
})

describe('Replacing the vault from a backup', () => {
  it('can use the recovery kit instead of the forgotten password', async () => {
    getTauriInvoke().mockImplementation(async (command: string) =>
      command === 'restore_backup' ? { itemCount: 2, fileCount: 1, safetyCopyPath: 'C:/safety' } : undefined,
    )
    const onClose = vi.fn()
    render(<RestoreDialog backup={info()} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Forgot it? Use recovery kit' }))
    expect(screen.queryByLabelText('Master Password this backup was made with')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: KIT } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace my vault' }))

    await waitFor(() =>
      expect(getTauriInvoke()).toHaveBeenCalledWith('restore_backup', { path: 'C:/safe/Kivo Backup', recoveryKey: KIT }),
    )
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Use recovery kit')))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows why an older backup needs its password and offers no kit', () => {
    render(<RestoreDialog backup={info({ recoveryAvailable: false })} onClose={vi.fn()} />)

    expect(screen.getByText('This backup can only be opened with the Master Password it was made with.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use recovery kit/ })).not.toBeInTheDocument()
  })

  it('shows the kit error and keeps the vault as it was', async () => {
    getTauriInvoke().mockRejectedValue('That recovery key does not open this backup.')
    render(<RestoreDialog backup={info()} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Forgot it? Use recovery kit' }))
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: KIT } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace my vault' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That recovery key does not open this backup.')
    expect(window.alert).not.toHaveBeenCalled()
  })
})

describe('Restoring some items with a recovery kit', () => {
  it('opens the backup with the kit and restores with it too', async () => {
    getTauriInvoke().mockImplementation(async (command: string) => {
      if (command === 'list_backup_contents') {
        return [{ id: 'note-1', kind: 'note', title: 'Plan', collection: null, updatedAt: '2026-09-01', alreadySaved: false }]
      }
      if (command === 'restore_from_backup') return { imported: 1, skipped: [], losses: [] }
      return undefined
    })
    render(<SelectiveRestoreDialog backup={info()} onClose={vi.fn()} />)

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forgot it? Use recovery kit' }))
    fireEvent.change(within(dialog).getByLabelText('Recovery key'), { target: { value: KIT } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open backup' }))

    await waitFor(() =>
      expect(getTauriInvoke()).toHaveBeenCalledWith('list_backup_contents', { path: 'C:/safe/Kivo Backup', recoveryKey: KIT }),
    )
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Plan/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: /Restore 1 item/ }))

    await waitFor(() =>
      expect(getTauriInvoke()).toHaveBeenCalledWith('restore_from_backup', {
        path: 'C:/safe/Kivo Backup',
        recoveryKey: KIT,
        ids: ['note-1'],
      }),
    )
  })
})
