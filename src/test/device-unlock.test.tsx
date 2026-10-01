import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'

vi.mock('../lib/feedback', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))

import DeviceUnlockSettings from '../features/security/DeviceUnlockSettings'
import UnlockPage from '../features/security/UnlockPage'

type Handler = (args: Record<string, unknown>) => unknown

function backend(handlers: Record<string, Handler>) {
  getTauriInvoke().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command]
    return handler ? handler(args) : undefined
  })
}

const status = (enrolled: boolean, available = true, reason: string | null = null) => ({
  read_device_unlock_status: ({ scope }: Record<string, unknown>) => ({
    scope,
    available,
    enrolled,
    unavailableReason: reason,
  }),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Windows Hello settings', () => {
  it('says why it cannot be used and offers nothing to turn on', async () => {
    backend(status(false, false, 'Set up Windows Hello (face, fingerprint or PIN) in Windows Settings first.'))
    render(<DeviceUnlockSettings />)

    expect(await screen.findAllByText(/Set up Windows Hello \(face, fingerprint or PIN\)/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument()
    expect(screen.getByText(/programs running as you/)).toBeInTheDocument()
  })

  it('turns on after the password and the Windows Hello prompt, and reports a cancelled prompt', async () => {
    let enrolled = false
    let answer: 'cancelled' | 'enrolled' = 'cancelled'
    backend({
      read_device_unlock_status: ({ scope }) => ({ scope, available: true, enrolled: scope === 'content' && enrolled, unavailableReason: null }),
      enroll_device_unlock: () => {
        if (answer === 'enrolled') enrolled = true
        return { status: answer }
      },
    })
    render(<DeviceUnlockSettings />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Turn on' }))[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Master Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Windows Hello was cancelled')

    answer = 'enrolled'
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeInTheDocument()
    expect(getTauriInvoke()).toHaveBeenCalledWith('enroll_device_unlock', { scope: 'content', password: 'pw' })
  })
})

describe('Unlocking with Windows Hello', () => {
  it('shows the button only when it is set up, and unlocks Kivo on success', async () => {
    backend({ ...status(true), unlock_with_device: () => ({ status: 'unlocked' }) })
    const onUnlocked = vi.fn()
    render(<UnlockPage onUnlocked={onUnlocked} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Windows Hello' }))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
    expect(getTauriInvoke()).toHaveBeenCalledWith('unlock_with_device', { scope: 'content' })
  })

  it('stays quiet on a cancelled prompt and keeps the password field', async () => {
    backend({ ...status(true), unlock_with_device: () => ({ status: 'cancelled' }) })
    const onUnlocked = vi.fn()
    render(<UnlockPage onUnlocked={onUnlocked} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Windows Hello' }))
    await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('unlock_with_device', { scope: 'content' }))
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/Master Password/)).toBeInTheDocument()
    expect(screen.queryByText(/could not unlock/)).not.toBeInTheDocument()
  })

  it('shows the reason when Windows Hello fails, and the password still works', async () => {
    backend({
      ...status(true),
      unlock_with_device: () => {
        throw 'Windows Hello setup is out of date. Unlock with your password and set it up again.'
      },
    })
    render(<UnlockPage onUnlocked={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Windows Hello' }))
    expect(await screen.findByText(/setup is out of date/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock Kivo' })).toBeEnabled()
  })

  it('has no Windows Hello button when it is not set up', async () => {
    backend(status(false))
    render(<UnlockPage onUnlocked={vi.fn()} />)

    await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('read_device_unlock_status', { scope: 'content' }))
    expect(screen.queryByRole('button', { name: 'Unlock with Windows Hello' })).not.toBeInTheDocument()
  })
})
