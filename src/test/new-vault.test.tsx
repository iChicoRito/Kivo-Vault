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

beforeEach(() => {
  feedbackMock.notifyError.mockReset()
  handlers = {
    list_vaults: () => ({ activeId: 'work', vaults: [{ id: 'work', name: 'Work' }] }),
    load_profile: () => ({ ownerName: 'Ana', vaultName: 'Work', setupCompletedAt: 'then' }),
    hash_password: ({ password }) => `verifier-for-${String(password)}`,
    create_vault: ({ name }) => ({ id: 'travel-id', name }),
    complete_setup: () => undefined,
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

async function openDialog(switchTo = vi.fn().mockResolvedValue(undefined)) {
  render(
    <VaultSwitchContext.Provider value={switchTo}>
      <VaultSwitcher />
    </VaultSwitchContext.Provider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New vault' }))
  await screen.findByRole('dialog')
  return switchTo
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function setupInput() {
  const call = invoke.mock.calls.find(([command]) => command === 'complete_setup')
  return (call?.[1] as { input: Record<string, unknown> } | undefined)?.input
}

describe('New vault', () => {
  it('creates a vault without a password and opens it', async () => {
    const switchTo = await openDialog()

    type('Vault name', '  Travel ')
    fireEvent.click(screen.getByRole('button', { name: 'Create without password' }))

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('travel-id'))
    expect(invoke).toHaveBeenCalledWith('create_vault', { name: 'Travel' })
    expect(invoke).not.toHaveBeenCalledWith('hash_password', expect.anything())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(setupInput()).toEqual({
      ownerName: 'Ana',
      vaultName: 'Travel',
      starterCollections: [],
      passwordVerifier: null,
    })
  })

  it('gives the new vault its own Master Password', async () => {
    const switchTo = await openDialog()

    type('Vault name', 'Travel')
    type('Master Password', 'trip-pass')
    type('Confirm Master Password', 'trip-pass')
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith('travel-id'))
    expect(invoke).toHaveBeenCalledWith('hash_password', { password: 'trip-pass' })
    expect(setupInput()).toEqual({
      ownerName: 'Ana',
      vaultName: 'Travel',
      starterCollections: [],
      passwordVerifier: 'verifier-for-trip-pass',
    })
  })

  it('creates nothing until the name and passwords are right', async () => {
    await openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Create without password' }))
    expect(await screen.findByText('Enter a name for the vault.')).toBeInTheDocument()

    type('Vault name', 'Travel')
    type('Master Password', 'trip-pass')
    type('Confirm Master Password', 'other')
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()

    expect(invoke).not.toHaveBeenCalledWith('create_vault', expect.anything())
  })

  it('shows why the backend refused the vault', async () => {
    handlers.create_vault = () => {
      throw new Error('A vault with that name already exists.')
    }
    const switchTo = await openDialog()

    type('Vault name', 'Work')
    fireEvent.click(screen.getByRole('button', { name: 'Create without password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A vault with that name already exists.')
    expect(switchTo).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('complete_setup', expect.anything())
  })

  it('is not offered on the lock screen switcher', async () => {
    handlers.list_vaults = () => ({
      activeId: 'work',
      vaults: [
        { id: 'work', name: 'Work' },
        { id: 'home', name: 'Home' },
      ],
    })
    render(
      <VaultSwitchContext.Provider value={vi.fn()}>
        <VaultSwitcher canManage={false} hideWhenSingle />
      </VaultSwitchContext.Provider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))
    await screen.findByRole('menuitemradio', { name: 'Home' })
    expect(screen.queryByRole('menuitem', { name: 'New vault' })).not.toBeInTheDocument()
  })
})
