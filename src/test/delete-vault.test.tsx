import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn(),
}))

vi.mock('../lib/feedback', () => feedbackMock)

import VaultSwitcher from '../app/VaultSwitcher'
import { VaultSwitchContext } from '../app/vaults'

const invoke = getTauriInvoke()

type Handlers = Record<string, (args: Record<string, unknown>) => unknown>

let handlers: Handlers

const TWO_VAULTS = {
  activeId: 'travel',
  vaults: [
    { id: 'work', name: 'Work' },
    { id: 'travel', name: 'Travel' },
  ],
}

beforeEach(() => {
  handlers = {
    list_vaults: () => TWO_VAULTS,
    read_protection_state: () => ({ lockEnabled: false, encryptionEnabled: false }),
    create_backup_now: () => ({ path: 'C:\\Docs\\Kivo Backups\\2026-10-02', valid: true }),
    delete_vault: () => ({ id: 'work', name: 'Work' }),
  }
  invoke.mockReset()
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    const handler = handlers[command]

    if (!handler) return Promise.reject(new Error(`Unexpected command: ${command}`))

    try {
      return Promise.resolve(handler(args ?? {}))
    } catch (error) {
      return Promise.reject(error)
    }
  })
})

async function openDelete(switchTo = vi.fn().mockResolvedValue(undefined)) {
  render(
    <VaultSwitchContext.Provider value={switchTo}>
      <VaultSwitcher />
    </VaultSwitchContext.Provider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Vault: Travel. Switch vault' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete this vault…' }))
  return switchTo
}

function confirmField() {
  return screen.getByLabelText('Type Travel to confirm')
}

describe('Delete vault', () => {
  it('offers a backup before asking for the name', async () => {
    const switchTo = await openDelete()

    expect(await screen.findByRole('heading', { name: 'Back up Travel first?' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Type Travel to confirm')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back up first' }))

    expect(await screen.findByText(/Backup saved to C:\\Docs\\Kivo Backups/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('create_backup_now', { folder: null })
    expect(invoke).not.toHaveBeenCalledWith('delete_vault', expect.anything())
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('deletes only after the exact vault name is typed', async () => {
    const switchTo = await openDelete()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip backup' }))

    const remove = await screen.findByRole('button', { name: 'Delete vault' })
    fireEvent.change(confirmField(), { target: { value: 'travel' } })
    expect(remove).toBeDisabled()

    fireEvent.change(confirmField(), { target: { value: 'Travel' } })
    expect(remove).toBeEnabled()
    fireEvent.click(remove)

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('work'))
    expect(invoke).toHaveBeenCalledWith('delete_vault', { id: 'travel', confirmName: 'Travel' })
    expect(invoke).not.toHaveBeenCalledWith('create_backup_now', expect.anything())
  })

  it('asks for the Master Password to encrypt the backup', async () => {
    handlers.read_protection_state = () => ({ lockEnabled: true, encryptionEnabled: false })
    await openDelete()

    fireEvent.click(await screen.findByRole('button', { name: 'Back up first' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your Master Password to encrypt the backup.')

    fireEvent.change(screen.getByLabelText('Master Password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back up first' }))

    await screen.findByLabelText('Type Travel to confirm')
    expect(invoke).toHaveBeenCalledWith('create_backup_now', { folder: null, password: 'secret' })
  })

  it('keeps the vault when the backend refuses', async () => {
    handlers.delete_vault = () => {
      throw new Error('The last vault cannot be deleted.')
    }
    const switchTo = await openDelete()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip backup' }))
    fireEvent.change(confirmField(), { target: { value: 'Travel' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete vault' }))

    expect(await screen.findByText('The last vault cannot be deleted.')).toBeInTheDocument()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('cannot delete the last vault', async () => {
    handlers.list_vaults = () => ({ activeId: 'travel', vaults: [{ id: 'travel', name: 'Travel' }] })
    render(
      <VaultSwitchContext.Provider value={vi.fn()}>
        <VaultSwitcher />
      </VaultSwitchContext.Provider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Travel. Switch vault' }))

    expect(await screen.findByRole('menuitem', { name: 'Delete this vault (last vault)' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })
})
