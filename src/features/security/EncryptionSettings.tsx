import { useEffect, useState, type FormEvent } from 'react'
import { Button, Card, Chip, Input, Label, Modal, Skeleton, TextField, Typography } from '@heroui/react'
import {
  InformationCircleIcon,
  SquareLock01Icon,
  SquareUnlock01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { DialogHeader } from '../../components/DialogHeader'
import {
  disableEncryption,
  enableEncryption,
  readProtectionState,
  type ProtectionState,
} from '../../data/protection'
import { notifyError, notifySuccess } from '../../lib/feedback'

const PROTECTED = [
  'Note text, titles and tags',
  'Links and descriptions',
  'Files and file names',
  'Collection names',
]
const READABLE = ['Dates and item counts', 'File sizes', 'Favorite and pinned marks']

function errorMessage(reason: unknown) {
  const text = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : ''
  if (text.includes('Incorrect Master Password')) return 'That Master Password is not correct.'
  if (text.startsWith('Too many wrong tries')) return text
  return 'Kivo could not change encryption. Nothing was changed. Try again.'
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="grid content-start gap-2 rounded-2xl border border-default p-4">
      <Typography className="font-medium" type="body-sm">
        {title}
      </Typography>
      <ul className="grid gap-1 text-sm text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function Note({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2">
      <HugeiconsIcon aria-hidden="true" className="mt-0.5 shrink-0 text-muted" icon={InformationCircleIcon} size={16} />
      <Typography color="muted" type="body-sm">
        {children}
      </Typography>
    </div>
  )
}

export default function EncryptionSettings() {
  const [state, setState] = useState<ProtectionState | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void readProtectionState()
      .then(setState)
      .catch(() => setLoadError(true))
  }, [])

  const on = state?.encryptionEnabled ?? false

  function close() {
    if (busy) return
    setDialogOpen(false)
    setPassword('')
    setError(null)
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!state || busy) return
    if (!password) return setError('Enter your Master Password.')
    setBusy(true)
    setError(null)
    try {
      if (on) await disableEncryption(password)
      else await enableEncryption(password)
      setState(await readProtectionState())
      setDialogOpen(false)
      setPassword('')
      notifySuccess(on ? 'Encryption turned off' : 'Encryption turned on')
    } catch (reason) {
      const message = errorMessage(reason)
      setError(message)
      notifyError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card aria-labelledby="encryption-title">
      <Card.Content className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Typography className="text-lg font-semibold" id="encryption-title" type="h2">
              Encryption
            </Typography>
            {state ? (
              <Typography role="status" type="body-sm">
                {on
                  ? 'Your notes and files are encrypted on this device.'
                  : 'Your notes and files are stored unencrypted on this device.'}
              </Typography>
            ) : null}
            {!state && !loadError ? (
              <div className="flex items-center gap-2" role="status">
                <Typography color="muted" type="body-sm">
                  Checking encryption...
                </Typography>
                <Skeleton aria-hidden="true" className="h-4 w-20 rounded" />
              </div>
            ) : null}
            {loadError ? (
              <Typography className="text-danger" role="alert" type="body-sm">
                Could not check encryption. Reopen Settings to try again.
              </Typography>
            ) : null}
          </div>
          {state ? (
            <Chip className="gap-1.5 px-3 py-1" color={on ? 'success' : 'default'} size="md" variant="soft">
              <HugeiconsIcon aria-hidden="true" icon={on ? SquareLock01Icon : SquareUnlock01Icon} size={14} />
              {on ? 'On' : 'Off'}
            </Chip>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <List items={PROTECTED} title={on ? 'Protected' : 'Would be protected'} />
          <List items={READABLE} title="Stays readable" />
        </div>

        <div className="grid gap-2">
          <Note>
            If you forget your Master Password, only a recovery kit can help. Set one up in Recovery
            kits below.
          </Note>
          <Note>
            Opening an encrypted file makes a temporary unlocked copy on this device. Kivo removes it
            when it locks or starts again.
          </Note>
        </div>

        {state && !state.lockEnabled ? (
          <Typography color="muted" type="body-sm">
            Set a Master Password in App lock first. Encryption uses it as the key.
          </Typography>
        ) : null}

        <div className="flex justify-end">
          <Button
            isDisabled={!state?.lockEnabled}
            variant={on ? 'secondary' : 'primary'}
            onPress={() => setDialogOpen(true)}
          >
            {on ? 'Turn off encryption' : 'Turn on encryption'}
          </Button>
        </div>
      </Card.Content>

      <Modal
        isOpen={dialogOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) close()
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <DialogHeader
                description={
                  on
                    ? 'Your notes and files will be saved unencrypted on this device again. Make a backup first.'
                    : 'Your notes and files will be encrypted with your Master Password.'
                }
                icon={on ? SquareUnlock01Icon : SquareLock01Icon}
                title={on ? 'Turn off encryption?' : 'Turn on encryption'}
                tone={on ? 'danger' : 'default'}
              />
              <form className="contents" noValidate onSubmit={(event) => void submit(event)}>
                <Modal.Body className="grid gap-4">
                  <TextField isInvalid={error !== null} type="password" value={password} onChange={setPassword}>
                    <Label>Master Password</Label>
                    <Input autoComplete="current-password" autoFocus variant="secondary" />
                  </TextField>
                  <Typography color="muted" type="body-sm">
                    This can take a while if you have many files. Keep Kivo open until it finishes.
                    If you set up a Master Password recovery kit, set it up again afterwards.
                  </Typography>
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
                  <Button isDisabled={busy} type="submit" variant={on ? 'danger' : 'primary'}>
                    {busy
                      ? on
                        ? 'Decrypting...'
                        : 'Encrypting...'
                      : on
                        ? 'Turn off encryption'
                        : 'Turn on encryption'}
                  </Button>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </Card>
  )
}
