import { useEffect, useState } from 'react'
import { Button, FieldError, Input, Label, Modal, TextField, Typography } from '@heroui/react'
import { CloudUploadIcon, Delete02Icon } from '@hugeicons/core-free-icons'

import { useVaultSwitch } from '../../app/vaults'
import { DialogHeader } from '../../components/DialogHeader'
import { createBackupNow } from '../../data/backup'
import { readProtectionState } from '../../data/protection'
import { deleteVault, type VaultSummary } from '../../data/vaults'

type DeleteVaultDialogProps = {
  /** The open vault, or null when the dialog is closed. */
  vault: VaultSummary | null
  onClose: () => void
}

type Step = 'backup' | 'confirm'

function message(reason: unknown, fallback: string) {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return text.replace(/^Error:\s*/, '') || fallback
}

// Deleting a vault happens in order: Kivo offers a backup first, then the
// person types the vault name, and only then is the vault removed.
export default function DeleteVaultDialog({ vault, onClose }: DeleteVaultDialogProps) {
  const switchTo = useVaultSwitch()
  const [step, setStep] = useState<Step>('backup')
  // With an app lock, backups are encrypted with the Master Password.
  const [lockEnabled, setLockEnabled] = useState(false)
  const [password, setPassword] = useState('')
  const [backupPath, setBackupPath] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!vault) return
    let active = true
    readProtectionState()
      .then((state) => {
        if (active) setLockEnabled(Boolean(state?.lockEnabled))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [vault])

  function close() {
    if (busy) return
    setStep('backup')
    setPassword('')
    setBackupPath(null)
    setTyped('')
    setError(null)
    onClose()
  }

  async function backUp() {
    if (busy) return
    if (lockEnabled && !password) {
      setError('Enter your Master Password to encrypt the backup.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const backup = await createBackupNow(null, lockEnabled ? password : undefined)
      setPassword('')
      setBackupPath(backup.path)
      setStep('confirm')
    } catch (reason) {
      const text = message(reason, '')
      setError(
        text.includes('Incorrect Master Password')
          ? 'That Master Password is not correct.'
          : text.includes('Too many wrong tries')
            ? text
            : 'Could not make the backup. Nothing was deleted.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!vault || !switchTo || busy || typed.trim() !== vault.name) return
    setBusy(true)
    setError(null)
    try {
      const opened = await deleteVault(vault.id, typed)
      // The backend already opened another vault; reboot the app into it.
      await switchTo(opened.id)
    } catch (reason) {
      setError(message(reason, 'Kivo could not delete the vault. Try again.'))
      setBusy(false)
    }
  }

  const name = vault?.name ?? ''

  return (
    <Modal isOpen={vault !== null} onOpenChange={(next) => { if (!next) close() }}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog aria-busy={busy}>
            {step === 'backup' ? (
              <>
                <DialogHeader
                  description="Deleting removes every note, file, password and setting in this vault from this device. Make a backup first if you may want it later."
                  icon={CloudUploadIcon}
                  title={`Back up ${name} first?`}
                  tone="warning"
                />
                <Modal.Body className="grid gap-3">
                  <Typography color="muted" type="body-sm">
                    The backup goes to Documents › Kivo Backups › {name}. Your other vaults are not touched.
                  </Typography>
                  {lockEnabled ? (
                    <TextField type="password" value={password} onChange={setPassword}>
                      <Label>Master Password</Label>
                      <Input autoComplete="current-password" fullWidth variant="secondary" />
                    </TextField>
                  ) : null}
                  {error ? (
                    <Typography className="text-danger" role="alert" type="body-sm">
                      {error}
                    </Typography>
                  ) : null}
                </Modal.Body>
                <Modal.Footer className="flex-wrap">
                  <Button isDisabled={busy} variant="secondary" onPress={close}>
                    Cancel
                  </Button>
                  <Button
                    isDisabled={busy}
                    variant="secondary"
                    onPress={() => {
                      setError(null)
                      setStep('confirm')
                    }}
                  >
                    Skip backup
                  </Button>
                  <Button isDisabled={busy} onPress={() => void backUp()}>
                    {busy ? 'Backing up...' : 'Back up first'}
                  </Button>
                </Modal.Footer>
              </>
            ) : (
              <form
                className="contents"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault()
                  void remove()
                }}
              >
                <DialogHeader
                  description="This cannot be undone. Kivo opens one of your other vaults afterwards."
                  icon={Delete02Icon}
                  title={`Delete ${name}?`}
                  tone="danger"
                />
                <Modal.Body className="grid gap-3">
                  {backupPath ? (
                    <Typography role="status" type="body-sm">
                      Backup saved to {backupPath}
                    </Typography>
                  ) : null}
                  <TextField isInvalid={error !== null} value={typed} onChange={setTyped}>
                    <Label>Type {name} to confirm</Label>
                    <Input autoComplete="off" autoFocus fullWidth variant="secondary" />
                    {error ? <FieldError>{error}</FieldError> : null}
                  </TextField>
                </Modal.Body>
                <Modal.Footer>
                  <Button isDisabled={busy} variant="secondary" onPress={close}>
                    Cancel
                  </Button>
                  <Button isDisabled={busy || typed.trim() !== name} type="submit" variant="danger">
                    {busy ? 'Deleting...' : 'Delete vault'}
                  </Button>
                </Modal.Footer>
              </form>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
