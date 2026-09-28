import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  hasAppLock,
  readAppLockVerifier,
  removeAppLock,
  setAppLock,
} from '../data/security'
import AppLockSettings from '../features/security/AppLockSettings'
import UnlockPage from '../features/security/UnlockPage'
import { getTauriInvoke } from './setup'

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))

vi.mock('../lib/feedback', () => feedbackMock)

const invoke = getTauriInvoke()

const VERIFIER = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'
const CORRUPTED = 'not-a-phc-string'
const PASSWORD = 'hunter two'
const ENCODED = 'encoded-verifier'

type InvokeHandler = (args?: unknown) => unknown

function stubInvoke(handlers: Record<string, InvokeHandler>) {
  invoke.mockImplementation((command: string, args?: unknown) => {
    const handler = handlers[command]
    if (!handler) {
      return Promise.reject(new Error(`Unexpected command: ${command}`))
    }

    return Promise.resolve(handler(args))
  })
}

// The backend is the only authority on whether a lock exists. `present` is what
// `has_password_verifier` reports; `rawVerifier` is whatever the stored row holds.
function lockHandlers(
  present: boolean,
  rawVerifier: string | null = present ? VERIFIER : null,
): Record<string, InvokeHandler> {
  return {
    has_password_verifier: () => present,
    load_password_verifier: () => rawVerifier,
    read_protection_state: () => ({ lockEnabled: present, encryptionEnabled: false }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

function submitFormOf(input: HTMLElement) {
  const form = input.closest('form')
  if (!form) throw new Error('Expected the field to be inside a form')

  fireEvent.submit(form)
}

function passwordInput() {
  return screen.getByLabelText('Master Password')
}

describe('app lock data wrappers', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('hashes the password before storing only the verifier', async () => {
    const calls: string[] = []
    stubInvoke({
      hash_password: () => {
        calls.push('hash')
        return ENCODED
      },
      set_password_verifier: (args) => {
        calls.push('store')
        return undefined
      },
    })

    await setAppLock(PASSWORD)

    expect(calls).toEqual(['hash', 'store'])
    expect(invoke).toHaveBeenNthCalledWith(1, 'hash_password', { password: PASSWORD })
    const storeArgs = invoke.mock.calls[1][1] as { verifier: string }
    expect(storeArgs.verifier).toBe(ENCODED)
    expect(JSON.stringify(storeArgs)).not.toContain(PASSWORD)
  })

  it('never stores a verifier when hashing fails', async () => {
    stubInvoke({
      hash_password: () => {
        throw new Error('hashing failed')
      },
    })

    await expect(setAppLock(PASSWORD)).rejects.toThrow('Could not protect the password.')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('hash_password', { password: PASSWORD })
  })

  it('removes the stored verifier', async () => {
    stubInvoke({ remove_password_verifier: () => undefined })

    await removeAppLock()

    expect(invoke).toHaveBeenCalledWith('remove_password_verifier')
  })

  it('reports whether an app lock exists from the backend lock state, not the raw row', async () => {
    stubInvoke({ ...lockHandlers(true) })
    await expect(readAppLockVerifier()).resolves.toBe(VERIFIER)
    await expect(hasAppLock()).resolves.toBe(true)

    stubInvoke({ ...lockHandlers(false, CORRUPTED) })
    await expect(hasAppLock()).resolves.toBe(false)

    stubInvoke({ ...lockHandlers(false) })
    await expect(hasAppLock()).resolves.toBe(false)
  })
})

describe('UnlockPage', () => {
  beforeEach(() => {
    invoke.mockReset()
    stubInvoke({
      load_password_verifier: () => VERIFIER,
      unlock_content_vault: () => true,
      read_protection_state: () => ({ lockEnabled: true, encryptionEnabled: false }),
    })
  })

  it('focuses the password field and states that app lock does not encrypt files', async () => {
    render(<UnlockPage />)

    expect(screen.getByRole('heading', { name: 'Unlock your vault' })).toBeInTheDocument()
    expect(passwordInput()).toHaveFocus()
    expect(
      screen.getByText(
        'App lock keeps Kivo closed to other people. It does not encrypt your files.',
      ),
    ).toBeInTheDocument()

    await screen.findByLabelText('Master Password')
  })

  it('rejects a wrong password with generic copy and stays on the page', async () => {
    stubInvoke({
      load_password_verifier: () => VERIFIER,
      unlock_content_vault: () => false,
      read_protection_state: () => ({ lockEnabled: true, encryptionEnabled: false }),
    })
    const onUnlocked = vi.fn()

    render(<UnlockPage onUnlocked={onUnlocked} />)
    typeInto(passwordInput(), 'wrong password')
    submitFormOf(passwordInput())

    expect(await screen.findByText('That password did not match. Try again.')).toBeInTheDocument()
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Unlock your vault' })).toBeInTheDocument()
  })

  it('verifies the submitted password through the form submit handler', async () => {
    const onUnlocked = vi.fn()

    render(<UnlockPage onUnlocked={onUnlocked} />)
    typeInto(passwordInput(), PASSWORD)
    submitFormOf(passwordInput())

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith('unlock_content_vault', { password: PASSWORD })
  })

  it('shows the wait message after too many wrong tries', async () => {
    stubInvoke({
      load_password_verifier: () => VERIFIER,
      unlock_content_vault: () => {
        throw new Error('Too many wrong tries. Wait 30 seconds.')
      },
    })

    render(<UnlockPage />)
    typeInto(passwordInput(), PASSWORD)
    submitFormOf(passwordInput())

    expect(await screen.findByText('Too many wrong tries. Wait 30 seconds.')).toBeInTheDocument()
  })

  it('unlocks the app after the correct password verifies', async () => {
    const onUnlocked = vi.fn()

    render(<UnlockPage onUnlocked={onUnlocked} />)
    typeInto(passwordInput(), PASSWORD)
    submitFormOf(passwordInput())

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1))
  })

  it('shows a busy state while verifying the password', async () => {
    const checking = deferred<boolean>()
    stubInvoke({
      load_password_verifier: () => VERIFIER,
      unlock_content_vault: () => checking.promise,
      read_protection_state: () => ({ lockEnabled: true, encryptionEnabled: false }),
    })

    render(<UnlockPage />)
    typeInto(passwordInput(), PASSWORD)
    submitFormOf(passwordInput())

    const busyButton = await screen.findByRole('button', { name: 'Checking password...' })
    expect(busyButton).toBeDisabled()

    await act(async () => {
      checking.resolve(true)
      await checking.promise
    })
  })

  it('shows generic copy when the verifier check fails', async () => {
    stubInvoke({
      load_password_verifier: () => VERIFIER,
      unlock_content_vault: () => {
        throw new Error('ipc failed')
      },
      read_protection_state: () => ({ lockEnabled: true, encryptionEnabled: false }),
    })

    render(<UnlockPage />)
    typeInto(passwordInput(), PASSWORD)
    submitFormOf(passwordInput())

    expect(
      await screen.findByText('We could not check the password. Try again.'),
    ).toBeInTheDocument()
  })
})

describe('AppLockSettings', () => {
  beforeEach(() => {
    invoke.mockReset()
    feedbackMock.notifySuccess.mockClear()
    feedbackMock.notifyError.mockClear()
  })

  it('shows the setup form when no app lock exists', async () => {
    stubInvoke({ ...lockHandlers(false) })

    render(<AppLockSettings />)

    expect(await screen.findByText('App lock is off.')).toBeInTheDocument()
    expect(screen.getByLabelText('Master Password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm Master Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on app lock' })).toBeInTheDocument()
  })

  it('shows app lock off and offers the turn-on flow when a raw verifier exists but the backend reports no lock', async () => {
    stubInvoke({
      ...lockHandlers(false, CORRUPTED),
      hash_password: () => ENCODED,
      set_password_verifier: () => undefined,
    })

    render(<AppLockSettings />)

    expect(await screen.findByText('App lock is off.')).toBeInTheDocument()
    expect(screen.queryByText('App lock is on.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on app lock' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove app lock' })).not.toBeInTheDocument()

    typeInto(screen.getByLabelText('Master Password'), PASSWORD)
    typeInto(screen.getByLabelText('Confirm Master Password'), PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on app lock' }))

    // Turning the lock on overwrites the bad value through the normal set flow.
    expect(await screen.findByText('App lock is on.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('set_password_verifier', { verifier: ENCODED })
  })

  it('shows app lock on with change and remove controls when the backend reports a lock', async () => {
    stubInvoke({ ...lockHandlers(true) })

    render(<AppLockSettings />)

    expect(await screen.findByText('App lock is on.')).toBeInTheDocument()
    expect(screen.queryByText('App lock is off.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove app lock' })).toBeInTheDocument()
  })

  it('turns on app lock by hashing and storing the verifier', async () => {
    stubInvoke({
      ...lockHandlers(false),
      hash_password: () => ENCODED,
      set_password_verifier: () => undefined,
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is off.')

    typeInto(screen.getByLabelText('Master Password'), PASSWORD)
    typeInto(screen.getByLabelText('Confirm Master Password'), PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on app lock' }))

    expect(await screen.findByText('App lock is on.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('hash_password', { password: PASSWORD })
    expect(invoke).toHaveBeenCalledWith('set_password_verifier', { verifier: ENCODED })
    expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('App lock is on')
  })

  it('rejects a mismatched confirmation without storing anything', async () => {
    stubInvoke({ ...lockHandlers(false) })

    render(<AppLockSettings />)
    await screen.findByText('App lock is off.')

    typeInto(screen.getByLabelText('Master Password'), PASSWORD)
    typeInto(screen.getByLabelText('Confirm Master Password'), 'something else')
    fireEvent.click(screen.getByRole('button', { name: 'Turn on app lock' }))

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('set_password_verifier', expect.anything())
  })

  it('changes the password after confirming the current one', async () => {
    stubInvoke({
      ...lockHandlers(true),
      change_master_password: () => undefined,
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    typeInto(screen.getByLabelText('Current Master Password'), PASSWORD)
    typeInto(screen.getByLabelText('New Master Password'), 'new secret')
    typeInto(screen.getByLabelText('Confirm New Master Password'), 'new secret')
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }))

    expect(await screen.findByText('Your Master Password was changed.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('change_master_password', {
      current: PASSWORD,
      next: 'new secret',
    })
    expect(invoke).not.toHaveBeenCalledWith('set_password_verifier', expect.anything())
    expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Master password changed')
  })

  it('surfaces a failed password change and keeps the lock on', async () => {
    stubInvoke({
      ...lockHandlers(true),
      change_master_password: () => {
        throw new Error('wrong password')
      },
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    typeInto(screen.getByLabelText('Current Master Password'), 'wrong password')
    typeInto(screen.getByLabelText('New Master Password'), 'new secret')
    typeInto(screen.getByLabelText('Confirm New Master Password'), 'new secret')
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }))

    expect(
      await screen.findByText('We could not update app lock. Try again.'),
    ).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('set_password_verifier', expect.anything())
    expect(screen.getByText('App lock is on.')).toBeInTheDocument()
  })

  it('removes the app lock only after confirming the current password', async () => {
    stubInvoke({
      ...lockHandlers(true),
      verify_password: () => true,
      remove_password_verifier: () => undefined,
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove app lock' }))
    expect(screen.getByText('Remove app lock? Your files stay on this device.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('remove_password_verifier')

    typeInto(screen.getByLabelText('Master Password to remove app lock'), PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove app lock' }))

    expect(await screen.findByText('App lock is off.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('verify_password', {
      password: PASSWORD,
      verifier: VERIFIER,
    })
    expect(invoke).toHaveBeenCalledWith('remove_password_verifier')
    expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('App lock is off')
  })

  it('requires a password before removal is sent', async () => {
    stubInvoke({
      ...lockHandlers(true),
      verify_password: () => true,
      remove_password_verifier: () => undefined,
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove app lock' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove app lock' }))

    expect(await screen.findByText('Enter your current Master Password.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('remove_password_verifier')
    expect(screen.getByText('App lock is on.')).toBeInTheDocument()
  })

  it('rejects removal when the current password is wrong and keeps the lock on', async () => {
    stubInvoke({
      ...lockHandlers(true),
      verify_password: () => false,
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove app lock' }))
    typeInto(screen.getByLabelText('Master Password to remove app lock'), 'wrong password')
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove app lock' }))

    expect(await screen.findByText('That password did not match. Try again.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('remove_password_verifier')
    expect(screen.getByText('App lock is on.')).toBeInTheDocument()
  })

  it('keeps app lock off and shows generic copy when saving the verifier fails', async () => {
    stubInvoke({
      ...lockHandlers(false),
      hash_password: () => ENCODED,
      set_password_verifier: () => {
        throw new Error('ipc failed')
      },
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is off.')

    typeInto(screen.getByLabelText('Master Password'), PASSWORD)
    typeInto(screen.getByLabelText('Confirm Master Password'), PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Turn on app lock' }))

    expect(
      await screen.findByText('We could not update app lock. Try again.'),
    ).toBeInTheDocument()
    expect(feedbackMock.notifyError).toHaveBeenCalledWith('We could not update app lock. Try again.')
    expect(screen.getByText('App lock is off.')).toBeInTheDocument()
    expect(screen.queryByText('App lock is on.')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('set_password_verifier', { verifier: ENCODED })
  })

  it('keeps app lock on when removing the verifier fails', async () => {
    stubInvoke({
      ...lockHandlers(true),
      verify_password: () => true,
      remove_password_verifier: () => {
        throw new Error('ipc failed')
      },
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove app lock' }))
    typeInto(screen.getByLabelText('Master Password to remove app lock'), PASSWORD)
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove app lock' }))

    expect(await screen.findByText('We could not remove app lock. Try again.')).toBeInTheDocument()
    expect(feedbackMock.notifyError).toHaveBeenCalledWith('We could not remove app lock. Try again.')
    expect(screen.getByText('App lock is on.')).toBeInTheDocument()
    expect(screen.queryByText('App lock is off.')).not.toBeInTheDocument()
  })

  it('keeps the app lock when removal is cancelled', async () => {
    stubInvoke({
      ...lockHandlers(true),
      remove_password_verifier: () => undefined,
    })

    render(<AppLockSettings />)
    await screen.findByText('App lock is on.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove app lock' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('Remove app lock? Your files stay on this device.')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('remove_password_verifier')
    expect(screen.getByText('App lock is on.')).toBeInTheDocument()
  })
})
