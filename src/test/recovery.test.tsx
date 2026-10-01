import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'

vi.mock('../lib/feedback', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))

import RecoverySettings from '../features/security/RecoverySettings'
import { RecoveryDialog } from '../features/security/RecoveryDialog'
import UnlockPage from '../features/security/UnlockPage'

const KIT = 'KIVO-RECOVERY-V1:content:' + 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(64) + ':12345678'

type Handler = (args: Record<string, unknown>) => unknown

function backend(handlers: Record<string, Handler>) {
  getTauriInvoke().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command]
    if (!handler) return undefined
    return handler(args)
  })
}

const status = (content: { available: boolean; enabled: boolean }, passwords = { available: true, enabled: false }) => ({
  read_recovery_status: ({ scope }: Record<string, unknown>) =>
    scope === 'content' ? { scope, ...content } : { scope, ...passwords },
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RecoverySettings', () => {
  it('shows each vault on its own row with what it needs', async () => {
    backend(status({ available: false, enabled: false }, { available: true, enabled: true }))
    render(<RecoverySettings />)

    expect(await screen.findByText(/Turn on encryption first/)).toBeInTheDocument()
    expect(screen.getByText('Kit active')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace kit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument()
  })

  it('sets up a kit only after the key is entered back', async () => {
    let enabled = false
    const confirm = vi.fn(({ recoveryKey }: Record<string, unknown>) => {
      if (recoveryKey !== KIT) throw 'That is not the recovery key shown above. Check it and try again.'
      enabled = true
    })
    backend({
      read_recovery_status: ({ scope }) => ({ scope, available: true, enabled: scope === 'content' && enabled }),
      begin_recovery_setup: () => ({ token: 't1', recoveryKey: KIT, expiresInSeconds: 300 }),
      save_recovery_kit: () => true,
      confirm_recovery_setup: confirm,
      cancel_recovery_setup: () => undefined,
    })
    render(<RecoverySettings />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Set up' }))[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Master Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))

    const key = await within(dialog).findByLabelText('Recovery key')
    expect(key).not.toHaveTextContent('c'.repeat(64))
    expect(key).toHaveTextContent('KIVO-RECOVERY-V1:content:')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show' }))
    expect(key).toHaveTextContent(KIT)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save kit file...' }))
    expect(await within(dialog).findByText(/Saved\. Move the file/)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Enter the recovery key to confirm'), { target: { value: 'wrong' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and turn on' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not the recovery key shown above')

    fireEvent.change(within(dialog).getByLabelText('Enter the recovery key to confirm'), { target: { value: KIT } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and turn on' }))
    expect(await screen.findByText('Kit active')).toBeInTheDocument()
    expect(getTauriInvoke()).toHaveBeenCalledWith('begin_recovery_setup', { scope: 'content', password: 'pw' })
  })

  it('cancels the setup on the backend when the dialog closes', async () => {
    backend({
      ...status({ available: true, enabled: false }),
      begin_recovery_setup: () => ({ token: 't9', recoveryKey: KIT, expiresInSeconds: 300 }),
      cancel_recovery_setup: () => undefined,
    })
    render(<RecoverySettings />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Set up' }))[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Master Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await within(dialog).findByLabelText('Recovery key')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('cancel_recovery_setup', { token: 't9' }))
  })
})

describe('Using a recovery kit', () => {
  it('checks the new password before asking the vault, then sets it', async () => {
    backend({ recover_vault: () => undefined })
    const onDone = vi.fn()
    render(<RecoveryDialog mode="recover" scope="passwords" onClose={vi.fn()} onDone={onDone} />)

    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: KIT } })
    fireEvent.change(screen.getByLabelText('New vault password'), { target: { value: 'short' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 8 characters')

    fireEvent.change(screen.getByLabelText('New vault password'), { target: { value: 'a long new password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a long new password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(getTauriInvoke()).toHaveBeenCalledWith('recover_vault', {
      scope: 'passwords',
      recoveryKey: KIT,
      newPassword: 'a long new password',
    })
  })

  it('the unlock screen offers a kit only when one is active, then asks for the new password', async () => {
    backend({
      ...status({ available: true, enabled: true }),
      recover_vault: () => undefined,
    })
    render(<UnlockPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Forgot it? Use recovery kit' }))
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: KIT } })
    fireEvent.change(screen.getByLabelText('New master password'), { target: { value: 'new pw' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText('Your new Master Password is set. Unlock with it now.')).toBeInTheDocument()
  })

  it('the unlock screen has no kit option when none is active', async () => {
    backend(status({ available: true, enabled: false }))
    render(<UnlockPage />)

    await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('read_recovery_status', { scope: 'content' }))
    expect(screen.queryByRole('button', { name: /Use recovery kit/ })).not.toBeInTheDocument()
  })
})
