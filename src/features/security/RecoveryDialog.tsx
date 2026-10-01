import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input, Label, Modal, TextArea, TextField, Typography } from '@heroui/react'
import { SquareLock01Icon } from '@hugeicons/core-free-icons'

import { DialogHeader } from '../../components/DialogHeader'
import {
  beginRecoverySetup,
  cancelRecoverySetup,
  confirmRecoverySetup,
  disableRecovery,
  errorText,
  recoverVault,
  saveRecoveryKit,
  type RecoveryDraft,
  type VaultScope,
} from '../../data/recovery'
import { notifySuccess } from '../../lib/feedback'

export type RecoveryMode = 'setup' | 'disable' | 'recover'

type RecoveryDialogProps = {
  /** `null` keeps the dialog closed. */
  mode: RecoveryMode | null
  scope: VaultScope
  onClose: () => void
  /** Called after setup is confirmed, recovery is turned off, or a vault is recovered. */
  onDone: () => void
}

const VAULT_NAME: Record<VaultScope, string> = {
  content: 'content vault',
  passwords: 'password vault',
}

const PASSWORD_LABEL: Record<VaultScope, string> = {
  content: 'Master Password',
  passwords: 'Vault password',
}

/** Keeps the readable prefix and scope; hides the ids, secret and checksum. */
function masked(key: string) {
  const [prefix, scope, ...rest] = key.split(':')
  return [prefix, scope, ...rest.map((part) => '•'.repeat(part.length))].join(':')
}

/**
 * Sets up, turns off, or uses a recovery kit for one vault. The recovery key
 * is shown only during setup, hidden until the user asks, and cleared from the
 * screen when the dialog closes.
 */
export function RecoveryDialog({ mode, scope, onClose, onDone }: RecoveryDialogProps) {
  const [password, setPassword] = useState('')
  const [draft, setDraft] = useState<RecoveryDraft | null>(null)
  const [shown, setShown] = useState(false)
  const [saved, setSaved] = useState(false)
  const [entered, setEntered] = useState('')
  const [kit, setKit] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const draftRef = useRef<RecoveryDraft | null>(null)
  draftRef.current = draft

  // Forget everything typed or shown once the dialog closes or unmounts.
  useEffect(() => {
    if (mode) return
    if (draftRef.current) void cancelRecoverySetup(draftRef.current.token).catch(() => undefined)
    setPassword('')
    setDraft(null)
    setShown(false)
    setSaved(false)
    setEntered('')
    setKit('')
    setNext('')
    setConfirm('')
    setError(null)
  }, [mode])

  useEffect(
    () => () => {
      if (draftRef.current) void cancelRecoverySetup(draftRef.current.token).catch(() => undefined)
    },
    [],
  )

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(errorText(reason, 'Kivo could not finish this. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (mode === 'setup' && !draft) {
      if (!password) return setError(`Enter your ${PASSWORD_LABEL[scope]}.`)
      return void run(async () => {
        setDraft(await beginRecoverySetup(scope, password))
        setPassword('')
      })
    }
    if (mode === 'setup' && draft) {
      if (!entered.trim()) return setError('Type or paste the recovery key to confirm you saved it.')
      return void run(async () => {
        await confirmRecoverySetup(draft.token, entered)
        setDraft(null)
        notifySuccess('Recovery kit is ready')
        onDone()
      })
    }
    if (mode === 'disable') {
      if (!password) return setError(`Enter your ${PASSWORD_LABEL[scope]}.`)
      return void run(async () => {
        await disableRecovery(scope, password)
        notifySuccess('Recovery kit turned off')
        onDone()
      })
    }
    if (mode === 'recover') {
      if (!kit.trim()) return setError('Paste your recovery key.')
      if (!next) return setError('Choose a new password.')
      if (scope === 'passwords' && next.length < 8) return setError('Use at least 8 characters.')
      if (next !== confirm) return setError('The new passwords do not match.')
      return void run(async () => {
        await recoverVault(scope, kit, next)
        notifySuccess('New password set')
        onDone()
      })
    }
  }

  const title =
    mode === 'setup'
      ? `Set up a recovery kit for the ${VAULT_NAME[scope]}`
      : mode === 'disable'
        ? `Turn off the ${VAULT_NAME[scope]} recovery kit`
        : `Use a recovery kit`
  const description =
    mode === 'setup'
      ? 'A recovery kit lets you set a new password if you forget this one. Keep it away from this computer and your backups.'
      : mode === 'disable'
        ? 'The current kit stops working for this vault. Backups made while it was active may still open with it.'
        : `Set a new password for the ${VAULT_NAME[scope]}. Your data stays as it is.`
  const primary =
    mode === 'setup'
      ? draft
        ? 'Confirm and turn on'
        : 'Continue'
      : mode === 'disable'
        ? 'Turn off'
        : 'Set new password'

  return (
    <Modal
      isOpen={mode !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) onClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <DialogHeader description={description} icon={SquareLock01Icon} title={title} />
            <form className="contents" noValidate onSubmit={submit}>
              <Modal.Body className="grid gap-4">
                {(mode === 'setup' && !draft) || mode === 'disable' ? (
                  <TextField type="password" value={password} onChange={setPassword}>
                    <Label>{PASSWORD_LABEL[scope]}</Label>
                    <Input autoComplete="current-password" autoFocus variant="secondary" />
                  </TextField>
                ) : null}

                {mode === 'setup' && draft ? (
                  <>
                    <div className="grid gap-2">
                      <Typography className="font-medium" type="body">
                        Your recovery key
                      </Typography>
                      <code
                        aria-label="Recovery key"
                        className="block break-all rounded-xl bg-default px-3 py-2 font-mono text-sm"
                      >
                        {shown ? draft.recoveryKey : masked(draft.recoveryKey)}
                      </code>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onPress={() => setShown((value) => !value)}>
                          {shown ? 'Hide' : 'Show'}
                        </Button>
                        <Button
                          isDisabled={busy}
                          size="sm"
                          variant="secondary"
                          onPress={() =>
                            void run(async () => {
                              if (await saveRecoveryKit(draft.token)) setSaved(true)
                            })
                          }
                        >
                          Save kit file...
                        </Button>
                      </div>
                      <Typography className="text-muted" type="body-sm">
                        {saved
                          ? 'Saved. Move the file somewhere safe, away from this computer.'
                          : 'Save the kit file or write the key down. Kivo does not keep a copy.'}
                      </Typography>
                    </div>
                    <TextField value={entered} onChange={setEntered}>
                      <Label>Enter the recovery key to confirm</Label>
                      <TextArea autoComplete="off" spellCheck={false} variant="secondary" />
                    </TextField>
                  </>
                ) : null}

                {mode === 'recover' ? (
                  <>
                    <TextField value={kit} onChange={setKit}>
                      <Label>Recovery key</Label>
                      <TextArea
                        autoComplete="off"
                        autoFocus
                        placeholder="KIVO-RECOVERY-V1:..."
                        spellCheck={false}
                        variant="secondary"
                      />
                    </TextField>
                    <TextField type="password" value={next} onChange={setNext}>
                      <Label>New {PASSWORD_LABEL[scope].toLowerCase()}</Label>
                      <Input autoComplete="new-password" variant="secondary" />
                    </TextField>
                    <TextField type="password" value={confirm} onChange={setConfirm}>
                      <Label>Confirm new password</Label>
                      <Input autoComplete="new-password" variant="secondary" />
                    </TextField>
                    <Typography className="text-muted" type="body-sm">
                      Nothing is deleted. After this, unlock with the new password.
                    </Typography>
                  </>
                ) : null}

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
                <Button isDisabled={busy} type="submit" variant={mode === 'disable' ? 'danger' : 'primary'}>
                  {busy ? 'Working...' : primary}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
