import { useState } from 'react'
import { Button, Card, Input, Label, Modal, TextField, Typography } from '@heroui/react'

import { resetRequiresPassword, resetVault, verifyResetPassword } from '../../data/setup'

/** The word the person types to confirm, so a stray click can never wipe the vault. */
const CONFIRM_WORD = 'DELETE'

type Step = 'closed' | 'password' | 'confirm'

export default function DangerZoneSettings() {
  const [step, setStep] = useState<Step>('closed')
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setError(null)
    try {
      const required = await resetRequiresPassword()
      setNeedsPassword(required)
      setStep(required ? 'password' : 'confirm')
    } catch {
      setError('Kivo could not check your app lock. Try again.')
    }
  }

  function close() {
    if (busy) return
    setStep('closed')
    setPassword('')
    setTyped('')
    setError(null)
  }

  async function checkPassword() {
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await verifyResetPassword(password)
      setStep('confirm')
    } catch (reason) {
      setPassword('')
      setError(
        String(reason).includes('password is not correct')
          ? 'That password is not correct.'
          : 'Kivo could not check your password. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    if (typed !== CONFIRM_WORD || busy) return
    setBusy(true)
    setError(null)
    try {
      await resetVault(needsPassword ? password : null)
      // Stored view choices, tour progress, and theme go too, then the app
      // reloads and starts over at onboarding.
      try {
        localStorage.clear()
      } catch {
        // Storage can be blocked; the vault itself is already gone.
      }
      window.location.reload()
    } catch (reason) {
      setBusy(false)
      setTyped('')
      if (String(reason).includes('password is not correct')) {
        // The password is only checked by the reset itself, so a wrong one
        // sends the person back to fix it. Nothing was deleted.
        setPassword('')
        setStep('password')
        setError('That password is not correct. Nothing was deleted.')
      } else {
        setError('Kivo could not delete everything. Some data may remain. Try again.')
      }
    }
  }

  const errorText = error ? (
    <Typography className="font-semibold text-danger" role="alert" type="body-sm">
      {error}
    </Typography>
  ) : null

  return (
    <Card aria-labelledby="settings-danger-title" className="border border-danger/40">
      <Card.Content className="grid gap-4">
        <div className="grid gap-1">
          <Typography className="text-lg font-semibold text-danger" id="settings-danger-title" type="h2">
            Danger zone
          </Typography>
          <Typography color="muted" type="body-sm">
            Delete all data and reset Kivo. This removes every note, source, file, password,
            collection, and setting on this device, then starts setup again. It cannot be undone.
          </Typography>
        </div>
        <Button className="justify-self-start" variant="danger" onPress={() => void start()}>
          Delete all data
        </Button>
        {step === 'closed' ? errorText : null}
      </Card.Content>

      <Modal
        isOpen={step !== 'closed'}
        onOpenChange={(isOpen) => {
          if (!isOpen) close()
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>
                  {step === 'password' ? 'Enter your password' : 'Delete all data?'}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="grid gap-3">
                {step === 'password' ? (
                  <>
                    <Typography type="body">
                      Your vault is protected. Enter your app lock or master password to continue.
                    </Typography>
                    <TextField type="password" value={password} onChange={setPassword}>
                      <Label>Password</Label>
                      <Input autoComplete="current-password" fullWidth variant="secondary" />
                    </TextField>
                  </>
                ) : (
                  <>
                    <Typography type="body">
                      Every note, source, file, password, collection, and setting will be deleted
                      from this device. Backups you saved elsewhere are not touched. Make a backup
                      first if you may want this data later.
                    </Typography>
                    <TextField value={typed} onChange={setTyped}>
                      <Label>Type {CONFIRM_WORD} to confirm</Label>
                      <Input autoComplete="off" fullWidth variant="secondary" />
                    </TextField>
                  </>
                )}
                {errorText}
              </Modal.Body>
              <Modal.Footer>
                <Button isDisabled={busy} variant="secondary" onPress={close}>
                  Cancel
                </Button>
                {step === 'password' ? (
                  <Button isDisabled={!password || busy} onPress={() => void checkPassword()}>
                    {busy ? 'Checking...' : 'Continue'}
                  </Button>
                ) : (
                  <Button
                    isDisabled={typed !== CONFIRM_WORD || busy}
                    variant="danger"
                    onPress={() => void reset()}
                  >
                    {busy ? 'Deleting...' : 'Delete everything'}
                  </Button>
                )}
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </Card>
  )
}
