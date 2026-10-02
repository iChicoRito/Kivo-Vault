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

import App from '../App'
import VaultSwitcher from '../app/VaultSwitcher'
import { VaultSwitchContext } from '../app/vaults'

const invoke = getTauriInvoke()

type Handlers = Record<string, (args: Record<string, unknown>) => unknown>

let handlers: Handlers

const TWO_VAULTS = {
  activeId: 'work',
  vaults: [
    { id: 'work', name: 'Work' },
    { id: 'home', name: 'Home' },
  ],
}

beforeEach(() => {
  feedbackMock.notifyError.mockReset()
  handlers = {
    list_vaults: () => TWO_VAULTS,
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

function renderSwitcher(switchTo: (id: string) => Promise<void>, hideWhenSingle = false) {
  return render(
    <VaultSwitchContext.Provider value={switchTo}>
      <VaultSwitcher hideWhenSingle={hideWhenSingle} />
    </VaultSwitchContext.Provider>,
  )
}

describe('VaultSwitcher', () => {
  it('lists every vault by name and marks the open one', async () => {
    renderSwitcher(vi.fn())

    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))

    const work = await screen.findByRole('menuitemradio', { name: 'Work' })
    const home = screen.getByRole('menuitemradio', { name: 'Home' })
    expect(work).toHaveAttribute('aria-checked', 'true')
    expect(home).toHaveAttribute('aria-checked', 'false')
  })

  it('opens the chosen vault and ignores the one already open', async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined)
    renderSwitcher(switchTo)

    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Work' }))
    expect(switchTo).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Home' }))
    expect(switchTo).toHaveBeenCalledWith('home')
  })

  it('reports a failed switch', async () => {
    renderSwitcher(vi.fn().mockRejectedValue(new Error('That vault no longer exists')))

    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Home' }))

    await waitFor(() => expect(feedbackMock.notifyError).toHaveBeenCalledWith('That vault no longer exists'))
  })

  it('can stay hidden while there is only one vault', async () => {
    handlers.list_vaults = () => ({ activeId: 'work', vaults: [{ id: 'work', name: 'Work' }] })
    renderSwitcher(vi.fn(), true)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('list_vaults'))
    expect(screen.queryByRole('button', { name: /Switch vault/ })).not.toBeInTheDocument()
  })
})

describe('switching from the lock screen', () => {
  it('shows vault names only and reboots into the chosen vault', async () => {
    let active = 'work'
    handlers = {
      ...handlers,
      initialize_database: () => undefined,
      load_boot_state: () => 'locked',
      load_preferences: () => ({ theme: 'system', density: 'comfortable', startAtLogin: false }),
      list_vaults: () => ({ ...TWO_VAULTS, activeId: active }),
      switch_vault: ({ id }) => {
        active = String(id)
      },
      read_recovery_status: () => ({ scope: 'content', available: false, enabled: false }),
      read_device_unlock_status: () => ({
        scope: 'content',
        available: false,
        enrolled: false,
        unavailableReason: null,
      }),
    }

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Unlock your vault' })).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Vault: Work. Switch vault' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Home' }))

    expect(await screen.findByRole('button', { name: 'Vault: Home. Switch vault' })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('switch_vault', { id: 'home' })
    // The boot flow ran again for the new vault, from the database check on.
    expect(invoke.mock.calls.filter(([command]) => command === 'initialize_database')).toHaveLength(2)
    expect(invoke.mock.calls.filter(([command]) => command === 'load_boot_state')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Unlock your vault' })).toBeInTheDocument()
  })
})
