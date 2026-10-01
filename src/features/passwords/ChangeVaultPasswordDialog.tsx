import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Label, Modal, TextField, Typography } from '@heroui/react'
import { SquareLock01Icon } from '@hugeicons/core-free-icons'

import { DialogHeader } from '../../components/DialogHeader'
import { changeVaultPassword } from '../../data/passwords'
import { notifySuccess } from '../../lib/feedback'

const MIN_LENGTH = 8

type ChangeVaultPasswordDialogProps = {
  open: boolean
  onClose: () => void
}

/**
 * Changes the password vault's own password. Saved passwords and their history
 * are not re-encrypted; only the wrapper around the vault key changes. This is
 * separate from the app's Master Password.
 */
export function ChangeVaultPasswordDialog({ open, onClose }: ChangeVaultPasswordDialogProps) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setCurrent('')
      setNext('')
      setConfirm('')
      setError(null)
    }
  }, [open])

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (busy) return
    if (!current) return setError('Enter the current vault password.')
    if (next.length < MIN_LENGTH) return setError('Use at least 8 characters for the new password.')
    if (next !== confirm) return setError('The new passwords do not match.')

    setBusy(true)
    setError(null)
    try {
      await changeVaultPassword(current, next)
      notifySuccess('Vault password changed')
      onClose()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason ?? '')
      setError(
        message.startsWith('Too many wrong tries') || message.startsWith('Some saved passwords')
          ? message
          : 'That current password is not correct. Nothing was changed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) onClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <DialogHeader
              description="This only changes the password vault's password, not the app's Master Password."
              icon={SquareLock01Icon}
              title="Change vault password"
            />
            <form className="contents" noValidate onSubmit={(event) => void submit(event)}>
              <Modal.Body className="grid gap-4">
                <TextField type="password" value={current} onChange={setCurrent}>
                  <Label>Current vault password</Label>
                  <Input autoComplete="current-password" autoFocus variant="secondary" />
                </TextField>
                <TextField type="password" value={next} onChange={setNext}>
                  <Label>New vault password</Label>
                  <Input autoComplete="new-password" variant="secondary" />
                </TextField>
                <TextField type="password" value={confirm} onChange={setConfirm}>
                  <Label>Confirm new password</Label>
                  <Input autoComplete="new-password" variant="secondary" />
                </TextField>
                {error ? (
                  <Typography className="text-danger" role="alert" type="body-sm">
                    {error}
                  </Typography>
                ) : null}
              </Modal.Body>
              <Modal.Footer>
                <Button isDisabled={busy} variant="secondary" onPress={onClose}>
                  Cancel
                </Button>
                <Button isDisabled={busy} type="submit">
                  {busy ? 'Changing...' : 'Change password'}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
