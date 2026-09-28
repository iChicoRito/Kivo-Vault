import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Button,
  Card,
  Description,
  Input,
  Label,
  Radio,
  RadioGroup,
  Separator,
  Skeleton,
  TextField,
  Typography,
} from '@heroui/react'

import {
  hasAppLock,
  readAppLockVerifier,
  removeAppLock,
  setAppLock,
  verifyPassword,
} from '../../data/security'
import { notifyError, notifySuccess } from '../../lib/feedback'
import { changeMasterPassword, readProtectionState } from '../../data/protection'
import { usePreferences } from '../../app/preferences'

type Mode = 'loading' | 'off' | 'on' | 'error'

const AUTO_LOCK_MINUTES = [0, 5, 15, 30, 60]
const AUTO_LOCK_HINTS: Record<number, string> = {
  0: 'Stays open until you lock it',
  5: 'Best on a shared computer',
  15: 'A good default',
  30: 'For longer work sessions',
  60: 'Only on a private device',
}

const EMPTY_PASSWORD_MESSAGE = 'Enter a Master Password.'
const EMPTY_CURRENT_MESSAGE = 'Enter your current Master Password.'
const MISMATCH_MESSAGE = 'Passwords do not match.'
const WRONG_PASSWORD_MESSAGE = 'That password did not match. Try again.'
const SAVE_ERROR_MESSAGE = 'We could not update app lock. Try again.'
const REMOVE_ERROR_MESSAGE = 'We could not remove app lock. Try again.'
const READ_ERROR_MESSAGE = 'We could not read app lock. Reopen Settings to try again.'

export default function AppLockSettings() {
  const [mode, setMode] = useState<Mode>('loading')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const busyRef = useRef(false)
  const { preferences, updatePreferences } = usePreferences()
  const [autoLockError, setAutoLockError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    void (async () => {
      try {
        const enabled = await hasAppLock()
        if (active) setMode(enabled ? 'on' : 'off')
      } catch {
        if (active) setMode('error')
      }
    })()

    return () => {
      active = false
    }
  }, [])

  function resetFields() {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  function validateNewPassword() {
    if (!newPassword) return EMPTY_PASSWORD_MESSAGE
    if (newPassword !== confirmPassword) return MISMATCH_MESSAGE
    return null
  }

  async function turnOn(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busyRef.current) return

    const validation = validateNewPassword()
    if (validation) {
      setError(validation)
      return
    }

    busyRef.current = true
    setBusy(true)
    setError(null)
    setStatusMessage(null)

    try {
      await setAppLock(newPassword)
      resetFields()
      setMode('on')
      setStatusMessage('App lock is on. Kivo will ask for your Master Password when it opens.')
      notifySuccess('App lock is on')
    } catch {
      setError(SAVE_ERROR_MESSAGE)
      notifyError(SAVE_ERROR_MESSAGE)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function changePassword(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busyRef.current) return

    const validation = validateNewPassword()
    if (validation) {
      setError(validation)
      return
    }

    if (!currentPassword) {
      setError(EMPTY_CURRENT_MESSAGE)
      return
    }

    busyRef.current = true
    setBusy(true)
    setError(null)
    setStatusMessage(null)

    try {
      await changeMasterPassword(currentPassword, newPassword)
      resetFields()
      setChangingPassword(false)
      setStatusMessage('Your Master Password was changed.')
      notifySuccess('Master password changed')
    } catch {
      setError(SAVE_ERROR_MESSAGE)
      notifyError(SAVE_ERROR_MESSAGE)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function beginPasswordChange() {
    setError(null)
    setStatusMessage(null)
    setChangingPassword(true)
  }

  function cancelPasswordChange() {
    setError(null)
    resetFields()
    setChangingPassword(false)
  }

  function beginRemoval() {
    setError(null)
    setRemoveError(null)
    setStatusMessage(null)
    setConfirmingRemoval(true)
  }

  function cancelRemoval() {
    setRemoveError(null)
    setConfirmingRemoval(false)
  }

  async function confirmRemove(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busyRef.current) return

    if (!currentPassword) {
      setRemoveError(EMPTY_CURRENT_MESSAGE)
      return
    }

    busyRef.current = true
    setBusy(true)
    setRemoveError(null)
    setStatusMessage(null)

    try {
      const protection = await readProtectionState()
      if (protection.encryptionEnabled) {
        setRemoveError('Turn off encryption before removing app lock.')
        return
      }
      const verifier = await readAppLockVerifier()
      const matched = verifier !== null && (await verifyPassword(currentPassword, verifier))

      if (!matched) {
        setRemoveError(WRONG_PASSWORD_MESSAGE)
        return
      }

      await removeAppLock()
      resetFields()
      setConfirmingRemoval(false)
      setMode('off')
      setStatusMessage('App lock is off. Kivo will open without a password.')
      notifySuccess('App lock is off')
    } catch {
      setRemoveError(REMOVE_ERROR_MESSAGE)
      notifyError(REMOVE_ERROR_MESSAGE)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <Card aria-labelledby="app-lock-title">
      <Card.Content className="grid gap-4">
        <div className="grid gap-1">
          <Typography className="text-lg font-semibold" id="app-lock-title" type="h2">
            App lock
          </Typography>
          <Typography color="muted" type="body-sm">
            Ask for your Master Password each time Kivo opens.
          </Typography>
        </div>

        {statusMessage ? (
          <Typography role="status" type="body-sm">
            {statusMessage}
          </Typography>
        ) : null}

        {mode === 'loading' && (
          <div className="flex items-center gap-2">
            <Typography color="muted" role="status" type="body-sm">
              Checking app lock...
            </Typography>
            <Skeleton aria-hidden="true" className="h-4 w-20 rounded" />
          </div>
        )}

        {mode === 'error' && (
          <Typography className="font-semibold text-danger" role="alert" type="body">
            {READ_ERROR_MESSAGE}
          </Typography>
        )}

        {mode === 'off' && (
          <form className="grid gap-4" noValidate onSubmit={(event) => void turnOn(event)}>
            <Typography type="body" weight="medium">
              App lock is off.
            </Typography>

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                isInvalid={error !== null}
                type="password"
                value={newPassword}
                onChange={setNewPassword}
              >
                <Label>Master Password</Label>
                <Input fullWidth autoComplete="new-password" variant="secondary" />
              </TextField>

              <TextField
                isInvalid={error !== null}
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              >
                <Label>Confirm Master Password</Label>
                <Input fullWidth autoComplete="new-password" variant="secondary" />
              </TextField>
            </div>

            {error ? (
              <Typography className="font-semibold text-danger" role="alert" type="body-sm">
                {error}
              </Typography>
            ) : null}

            <Button
              className="justify-self-start"
              isDisabled={busy}
              type="submit"
              onPress={() => void turnOn()}
            >
              {busy ? 'Saving...' : 'Turn on app lock'}
            </Button>
          </form>
        )}

        {mode === 'on' && (
          <div className="grid gap-4">
            <Typography type="body" weight="medium">
              App lock is on.
            </Typography>

            <Separator />

            <RadioGroup
              className="grid gap-3"
              name="auto-lock"
              variant="secondary"
              value={String(preferences.autoLockMinutes)}
              onChange={(value) => {
                setAutoLockError(null)
                void updatePreferences({ autoLockMinutes: Number(value) }).catch(() =>
                  setAutoLockError('Could not save this setting. Try again.'),
                )
              }}
            >
              <div className="grid gap-0.5">
                <Label className="text-base font-medium">Lock after inactivity</Label>
                <Description className="text-sm">
                  Locks Kivo when you have not used it for a while.
                </Description>
              </div>
              {/* Each choice is a card, like the onboarding choices, so the time
                  and what it suits read at a glance. */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {AUTO_LOCK_MINUTES.map((minutes) => (
                  <Radio
                    key={minutes}
                    value={String(minutes)}
                    className="relative mt-0! flex min-h-11 cursor-pointer flex-col gap-1 rounded-2xl border border-default bg-surface p-3 transition-colors duration-200 ease-out hover:bg-surface-hover data-[selected=true]:border-accent data-[selected=true]:bg-accent/5 data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-offset-2 data-[focus-visible=true]:outline-focus"
                  >
                    {/* The overlay stretches the click area over the whole card. */}
                    <Radio.Content className="static after:absolute after:inset-0 after:rounded-2xl">
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                      <span className="font-semibold">
                        {minutes ? `${minutes} min` : 'Never'}
                      </span>
                    </Radio.Content>
                    <Description className="text-xs">{AUTO_LOCK_HINTS[minutes]}</Description>
                  </Radio>
                ))}
              </div>
            </RadioGroup>
            {autoLockError ? (
              <Typography role="alert" className="text-danger" type="body-sm">
                {autoLockError}
              </Typography>
            ) : null}

            <Separator />

            {changingPassword ? (
              <form
                className="grid gap-4"
                noValidate
                onSubmit={(event) => void changePassword(event)}
              >
                <Typography type="body" weight="medium">
                  Change password
                </Typography>
                <TextField
                  isInvalid={error !== null}
                  type="password"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                >
                  <Label>Current Master Password</Label>
                  <Input fullWidth autoComplete="current-password" variant="secondary" />
                </TextField>

                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    isInvalid={error !== null}
                    type="password"
                    value={newPassword}
                    onChange={setNewPassword}
                  >
                    <Label>New Master Password</Label>
                    <Input fullWidth autoComplete="new-password" variant="secondary" />
                  </TextField>

                  <TextField
                    isInvalid={error !== null}
                    type="password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                  >
                    <Label>Confirm New Master Password</Label>
                    <Input fullWidth autoComplete="new-password" variant="secondary" />
                  </TextField>
                </div>

                {error ? (
                  <Typography className="font-semibold text-danger" role="alert" type="body-sm">
                    {error}
                  </Typography>
                ) : null}

                <div className="flex flex-wrap gap-3">
                  <Button isDisabled={busy} type="submit" onPress={() => void changePassword()}>
                    {busy ? 'Saving...' : 'Save new password'}
                  </Button>
                  <Button
                    isDisabled={busy}
                    type="button"
                    variant="secondary"
                    onPress={cancelPasswordChange}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : confirmingRemoval ? (
              <form
                className="grid gap-4"
                noValidate
                onSubmit={(event) => void confirmRemove(event)}
              >
                <div className="grid gap-1">
                  <Typography type="body" weight="medium">
                    Remove app lock? Your files stay on this device.
                  </Typography>
                  <Typography color="muted" type="body-sm">
                    Kivo will open without asking for a password. Enter your current Master Password
                    to confirm.
                  </Typography>
                </div>

                <TextField
                  isInvalid={removeError !== null}
                  type="password"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                >
                  <Label>Master Password to remove app lock</Label>
                  <Input fullWidth autoComplete="current-password" variant="secondary" />
                </TextField>

                {removeError ? (
                  <Typography className="font-semibold text-danger" role="alert" type="body-sm">
                    {removeError}
                  </Typography>
                ) : null}

                <div className="flex flex-wrap gap-3">
                  <Button
                    isDisabled={busy}
                    type="submit"
                    variant="danger"
                    onPress={() => void confirmRemove()}
                  >
                    {busy ? 'Removing...' : 'Yes, remove app lock'}
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    isDisabled={busy}
                    onPress={cancelRemoval}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onPress={beginPasswordChange}>
                  Change password
                </Button>
                <Button variant="ghost" onPress={beginRemoval}>
                  Remove app lock
                </Button>
              </div>
            )}
          </div>
        )}
      </Card.Content>
    </Card>
  )
}
