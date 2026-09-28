import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'

const clipboardMock = vi.hoisted(() => ({ copyText: vi.fn(), copySecret: vi.fn() }))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn(),
}))

vi.mock('../lib/clipboard', () => clipboardMock)
vi.mock('../lib/feedback', () => feedbackMock)

import { AUTO_LOCK_MS, VaultProvider, useVault } from '../app/vault'
import PasswordsPage from '../features/passwords/PasswordsPage'

const invoke = getTauriInvoke()

type Handlers = Record<string, (args: Record<string, unknown>) => unknown>

let handlers: Handlers

function stub(command: string, handler: (args: Record<string, unknown>) => unknown) {
  handlers[command] = handler
}

function VaultProbe() {
  const { status, configured, unlocked, lock } = useVault()

  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="configured">{String(configured)}</span>
      <span data-testid="unlocked">{String(unlocked)}</span>
      <button type="button" onClick={() => void lock()}>
        Lock now
      </button>
    </div>
  )
}

function renderProbe() {
  return render(
    <VaultProvider>
      <VaultProbe />
    </VaultProvider>,
  )
}

beforeEach(() => {
  handlers = {}
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

afterEach(() => {
  vi.useRealTimers()
})

describe('VaultProvider', () => {
  it('exposes the configured and unlocked state from the vault status', async () => {
    stub('vault_status', () => ({ configured: true, unlocked: true }))

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'))
    expect(screen.getByTestId('configured')).toHaveTextContent('true')
    expect(screen.getByTestId('unlocked')).toHaveTextContent('true')
  })

  it('locks itself after the idle deadline and resets the timer on activity', async () => {
    vi.useFakeTimers()
    stub('vault_status', () => ({ configured: true, unlocked: true }))
    stub('lock_vault', () => ({ configured: true, unlocked: false }))

    renderProbe()
    await act(async () => {})

    expect(screen.getByTestId('unlocked')).toHaveTextContent('true')

    // Activity just before the deadline pushes the lock back.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_LOCK_MS - 1000)
    })
    act(() => {
      fireEvent.pointerDown(window)
      fireEvent.keyDown(window, { key: 'a' })
      fireEvent.wheel(window)
    })

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(invoke).not.toHaveBeenCalledWith('lock_vault')

    await act(async () => {
      vi.advanceTimersByTime(AUTO_LOCK_MS)
    })
    await act(async () => {})

    expect(invoke).toHaveBeenCalledWith('lock_vault')
    expect(screen.getByTestId('unlocked')).toHaveTextContent('false')
  })

  it('locks on demand', async () => {
    stub('vault_status', () => ({ configured: true, unlocked: true }))
    stub('lock_vault', () => ({ configured: true, unlocked: false }))

    renderProbe()
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('true'))

    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('lock_vault'))
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('false'))
  })

  it('surfaces the locked-vault message from a credential call', async () => {
    stub('vault_status', () => ({ configured: true, unlocked: true }))
    stub('list_credentials', () => {
      throw new Error('The password vault is locked')
    })

    render(
      <VaultProvider>
        <MemoryRouter initialEntries={['/passwords']}>
          <PasswordsPage />
        </MemoryRouter>
      </VaultProvider>,
    )

    expect(await screen.findByText(/The password vault is locked/)).toBeInTheDocument()
  })
})
