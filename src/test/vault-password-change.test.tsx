import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'

vi.mock('../lib/feedback', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))

import { ChangeVaultPasswordDialog } from '../features/passwords/ChangeVaultPasswordDialog'

function fill(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText('Current vault password'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('New vault password'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } })
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ChangeVaultPasswordDialog', () => {
  it('checks length and matching before asking the vault', async () => {
    render(<ChangeVaultPasswordDialog open onClose={vi.fn()} />)

    fill('old password', 'short', 'short')
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 8 characters')

    fill('old password', 'a long new password', 'something else')
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match')
    expect(getTauriInvoke()).not.toHaveBeenCalled()
  })

  it('changes the password through change_password_vault_password and closes', async () => {
    getTauriInvoke().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<ChangeVaultPasswordDialog open onClose={onClose} />)

    fill('old password', 'a long new password', 'a long new password')

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(getTauriInvoke()).toHaveBeenCalledWith('change_password_vault_password', {
      current: 'old password',
      next: 'a long new password',
    })
  })

  it('says nothing changed when the current password is wrong', async () => {
    getTauriInvoke().mockRejectedValue('Could not unlock the vault')
    const onClose = vi.fn()
    render(<ChangeVaultPasswordDialog open onClose={onClose} />)

    fill('wrong password', 'a long new password', 'a long new password')

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was changed')
    expect(onClose).not.toHaveBeenCalled()
  })
})
