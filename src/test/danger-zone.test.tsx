import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'

import DangerZoneSettings from '../features/settings/DangerZoneSettings'
import { getTauriInvoke } from './setup'

beforeEach(() => getTauriInvoke().mockReset())

it('asks for the password, then the confirm word, and returns to the password when it is wrong', async () => {
  getTauriInvoke().mockImplementation(async (command: string) => {
    if (command === 'reset_requires_password') return true
    if (command === 'verify_reset_password') return undefined
    if (command === 'reset_vault') throw new Error('That password is not correct')
    return undefined
  })
  render(<DangerZoneSettings />)

  fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }))
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'guess' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  const confirm = await screen.findByRole('button', { name: 'Delete everything' })
  expect(confirm).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Type DELETE to confirm' }), {
    target: { value: 'DELETE' },
  })
  fireEvent.click(confirm)

  await waitFor(() =>
    expect(getTauriInvoke()).toHaveBeenCalledWith('reset_vault', { password: 'guess' }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was deleted.')
  expect(screen.getByLabelText('Password')).toBeInTheDocument()
})

it('skips the password step when nothing is locked', async () => {
  getTauriInvoke().mockResolvedValue(false)
  render(<DangerZoneSettings />)

  fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }))
  expect(await screen.findByRole('textbox', { name: 'Type DELETE to confirm' })).toBeInTheDocument()
})

it('stays on the password step when the password is wrong', async () => {
  getTauriInvoke().mockImplementation(async (command: string) => {
    if (command === 'reset_requires_password') return true
    if (command === 'verify_reset_password') throw new Error('That password is not correct')
    return undefined
  })
  render(<DangerZoneSettings />)

  fireEvent.click(screen.getByRole('button', { name: 'Delete all data' }))
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'wrong' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.')
  expect(screen.queryByRole('button', { name: 'Delete everything' })).not.toBeInTheDocument()
  expect(getTauriInvoke()).not.toHaveBeenCalledWith('reset_vault', expect.anything())
})
