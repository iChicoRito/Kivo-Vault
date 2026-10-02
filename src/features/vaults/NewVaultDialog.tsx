import { useState, type FormEvent } from 'react'
import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  TextField,
  Typography,
} from '@heroui/react'
import { SafeIcon } from '@hugeicons/core-free-icons'

import { useVaultSwitch } from '../../app/vaults'
import { DialogHeader } from '../../components/DialogHeader'
import { hashPassword } from '../../data/security'
import { loadProfile } from '../../data/settings'
import { completeSetup } from '../../data/setup'
import { createVault } from '../../data/vaults'
import { notifyError } from '../../lib/feedback'
import { validatePasswordConfirmation } from '../onboarding/onboarding'

type NewVaultDialogProps = {
  open: boolean
  onClose: () => void
}

function message(reason: unknown, fallback: string) {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return text || fallback
}

// A new vault is empty and private: its own name and its own Master Password
// (or none, when the password is left blank).
export default function NewVaultDialog({ open, onClose }: NewVaultDialogProps) {
  const switchTo = useVaultSwitch()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const withPassword = password !== '' || confirmPassword !== ''

  function close() {
    if (busy) return
    setName('')
    setPassword('')
    setConfirmPassword('')
    setNameError(null)
    setPasswordError(null)
    setError(null)
    onClose()
  }

  async function create(event?: FormEvent) {
    event?.preventDefault()
    if (busy || !switchTo) return
    const vaultName = name.trim()
    const nameProblem = vaultName ? null : 'Enter a name for the vault.'
    const passwordProblem = withPassword ? validatePasswordConfirmation(password, confirmPassword) : null
    setNameError(nameProblem)
    setPasswordError(passwordProblem)
    setError(null)
    if (nameProblem || passwordProblem) return

    setBusy(true)
    let vaultId: string
    try {
      // The new vault uses the same owner name as the one open now.
      const owner = (await loadProfile().catch(() => null))?.ownerName.trim() || vaultName
      const verifier = withPassword ? await hashPassword(password) : null
      const vault = await createVault(vaultName)
      vaultId = vault.id
      try {
        await completeSetup({
          ownerName: owner,
          vaultName: vault.name,
          starterCollections: [],
          passwordVerifier: verifier,
        })
      } catch {
        // The vault exists but is not set up; it opens on the setup screen.
        notifyError('The vault was created, but its setup did not finish. Finish it on the next screen.')
      }
    } catch (reason) {
      setError(message(reason, 'Kivo could not create the vault. Try again.'))
      setBusy(false)
      return
    }
    setPassword('')
    setConfirmPassword('')
    // The backend already opened the new vault; reboot the app into it.
    await switchTo(vaultId).catch((reason: unknown) => {
      setBusy(false)
      setError(message(reason, 'Kivo could not open the new vault.'))
    })
  }

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) close() }}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog aria-busy={busy} className="max-w-xl">
            <Modal.CloseTrigger className="size-8 rounded-full" />
            <DialogHeader
              description="Its own notes, files, passwords and settings. Nothing is shared with your other vaults."
              icon={SafeIcon}
              title="New vault"
              titleClassName="pr-8"
            />
            <form className="contents" noValidate onSubmit={(event) => void create(event)}>
              <Modal.Body className="grid gap-6">
                <TextField isRequired isInvalid={nameError !== null} value={name} onChange={setName}>
                  <Label>Vault name</Label>
                  <Input autoComplete="off" autoFocus fullWidth placeholder="e.g. Work, Family, Studies" variant="secondary" />
                  {nameError ? <FieldError>{nameError}</FieldError> : null}
                </TextField>

                <fieldset className="grid gap-3">
                  <legend className="mb-1 grid gap-0.5">
                    <span className="text-sm font-medium text-foreground">Master Password (optional)</span>
                    <span className="text-sm text-muted">
                      Only this password opens this vault. Leave it blank to create the vault without one.
                    </span>
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField aria-label="Master Password" type="password" value={password} onChange={setPassword}>
                      <Input autoComplete="new-password" fullWidth placeholder="Master Password" variant="secondary" />
                    </TextField>
                    <TextField
                      aria-label="Confirm Master Password"
                      isInvalid={passwordError !== null}
                      type="password"
                      value={confirmPassword}
                      onChange={setConfirmPassword}
                    >
                      <Input autoComplete="new-password" fullWidth placeholder="Confirm password" variant="secondary" />
                      {passwordError ? <FieldError>{passwordError}</FieldError> : null}
                    </TextField>
                  </div>
                </fieldset>

                {error ? (
                  <Typography className="text-danger" role="alert" type="body-sm">
                    {error}
                  </Typography>
                ) : null}
              </Modal.Body>
              <Modal.Footer>
                <Button isDisabled={busy} variant="secondary" onPress={close}>
                  Cancel
                </Button>
                <Button isDisabled={busy} type="submit">
                  {busy ? 'Creating vault...' : withPassword ? 'Create vault' : 'Create without password'}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
