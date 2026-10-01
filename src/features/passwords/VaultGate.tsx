import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Alert, Button, Card, FieldError, Input, Label, Modal, Skeleton, TextField, Typography } from '@heroui/react'
import { HugeiconsIcon } from '@hugeicons/react'
import { SquareLock01Icon } from '@hugeicons/core-free-icons'
import { readRecoveryStatus } from '../../data/recovery'
import { readDeviceUnlockStatus, unlockWithDevice } from '../../data/deviceUnlock'
import { RecoveryDialog } from '../security/RecoveryDialog'

import PageHeader from '../../app/PageHeader'
import { useVault } from '../../app/vault'

export type VaultGateProps = {
  children: ReactNode
}

/**
 * Stands between the app content and the password pages. It shows the create
 * form when no vault exists, the unlock form when one does, and only renders
 * its children once the vault is open.
 */
export function VaultGate({ children }: VaultGateProps) {
  const { status, configured, unlocked, refresh } = useVault()

  if (status === 'loading') {
    return <VaultLoading />
  }

  if (status === 'error') {
    return <VaultError onRetry={() => void refresh()} />
  }

  if (!configured) {
    return <CreateVaultForm />
  }

  if (!unlocked) {
    return <UnlockVaultDialog />
  }

  return <>{children}</>
}

export default VaultGate

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) {
    return error
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function VaultPanel({
  titleId,
  title,
  description,
  children,
}: {
  titleId: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={titleId} className="grid w-full gap-6 py-4">
      <PageHeader description={description} title={title} titleId={titleId} />
      <Card>
        <Card.Content>{children}</Card.Content>
      </Card>
    </section>
  )
}

function VaultLoading() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading the password vault"
      className="mx-auto grid w-full max-w-xl gap-4 py-8"
      role="status"
    >
      <Skeleton animationType="shimmer" className="h-8 w-56 rounded-md" />
      <Skeleton animationType="shimmer" className="h-4 w-80 rounded-md" />
      <Skeleton animationType="shimmer" className="h-40 w-full rounded-3xl" />
    </section>
  )
}

function VaultError({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert aria-labelledby="vault-error-title" role="alert" status="danger">
      <Alert.Content className="grid gap-3">
        <Typography id="vault-error-title" type="h2">
          The vault could not load
        </Typography>
        <Typography type="body">
          Kivo could not read the password vault. Try again to reload it.
        </Typography>
        <Button className="justify-self-start" variant="secondary" onPress={onRetry}>
          Retry
        </Button>
      </Alert.Content>
    </Alert>
  )
}

function CreateVaultForm() {
  const { setup } = useVault()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    passwordRef.current?.focus()
  }, [])

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busyRef.current) return

    const tooShort = password.length < 8
    const mismatched = password !== confirm

    setPasswordError(tooShort ? 'Use at least 8 characters.' : null)
    setConfirmError(mismatched ? 'The passwords do not match.' : null)

    if (tooShort || mismatched) {
      if (tooShort) passwordRef.current?.focus()
      return
    }

    busyRef.current = true
    setBusy(true)

    try {
      await setup(password)
    } catch (caught) {
      setPasswordError(errorText(caught, 'Kivo could not create the vault. Try again.'))
      passwordRef.current?.focus()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <VaultPanel
      description="This password encrypts your saved logins. If you forget it, only a recovery kit (Settings > Security) can replace it."
      title="Create a master password"
      titleId="vault-create-title"
    >
      <form className="grid gap-5" noValidate onSubmit={(event) => void submit(event)}>
        <TextField
          isRequired
          isInvalid={passwordError !== null}
          type="password"
          value={password}
          onChange={(value) => {
            setPassword(value)
            setPasswordError(null)
          }}
        >
          <Label>Master password</Label>
          <Input fullWidth autoComplete="off" ref={passwordRef} variant="secondary" />
          {passwordError ? <FieldError>{passwordError}</FieldError> : null}
        </TextField>

        <TextField
          isRequired
          isInvalid={confirmError !== null}
          type="password"
          value={confirm}
          onChange={(value) => {
            setConfirm(value)
            setConfirmError(null)
          }}
        >
          <Label>Confirm master password</Label>
          <Input fullWidth autoComplete="off" variant="secondary" />
          {confirmError ? <FieldError>{confirmError}</FieldError> : null}
        </TextField>

        <Typography color="muted" type="body">
          Use at least 8 characters.
        </Typography>

        <div className="flex justify-end">
          <Button isDisabled={busy} type="submit" onPress={() => void submit()}>
            {busy ? 'Creating vault...' : 'Create and unlock'}
          </Button>
        </div>
      </form>
    </VaultPanel>
  )
}

function UnlockVaultDialog() {
  const { unlock, refresh } = useVault()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const busyRef = useRef(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const [recoveryEnabled, setRecoveryEnabled] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [helloReady, setHelloReady] = useState(false)
  const [helloBusy, setHelloBusy] = useState(false)

  useEffect(() => {
    readRecoveryStatus('passwords')
      .then((status) => setRecoveryEnabled(status.enabled))
      .catch(() => setRecoveryEnabled(false))
    readDeviceUnlockStatus('passwords')
      .then((status) => setHelloReady(status.available && status.enrolled))
      .catch(() => setHelloReady(false))
  }, [])

  async function unlockWithHello() {
    if (helloBusy || busyRef.current) return
    setHelloBusy(true)
    setError(null)
    try {
      const result = await unlockWithDevice('passwords')
      if (result.status === 'unlocked') {
        setPassword('')
        await refresh()
      }
    } catch (caught) {
      setError(errorText(caught, 'Windows Hello could not unlock the vault. Use your password.'))
    } finally {
      setHelloBusy(false)
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busyRef.current) return

    busyRef.current = true
    setBusy(true)
    setError(null)

    try {
      await unlock(password)
    } catch (caught) {
      setError(errorText(caught, 'Could not unlock the vault.'))
      passwordRef.current?.focus()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <>
      {open ? null : (
        <section className="grid place-items-center gap-4 py-16 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-default">
            <HugeiconsIcon
              aria-hidden="true"
              className="text-muted"
              icon={SquareLock01Icon}
              size={24}
            />
          </span>
          <Typography type="h2">Unlock passwords</Typography>
          <Typography color="muted" type="body">
            Enter your master password to open the vault.
          </Typography>
          <Button onPress={() => setOpen(true)}>
            <HugeiconsIcon aria-hidden="true" icon={SquareLock01Icon} size={18} />
            Unlock
          </Button>
          {notice ? (
            <Typography role="status" type="body">
              {notice}
            </Typography>
          ) : null}
          {recoveryEnabled ? (
            <Button variant="ghost" onPress={() => setRecovering(true)}>
              Forgot it? Use recovery kit
            </Button>
          ) : null}
        </section>
      )}

      <Modal isOpen={open} onOpenChange={setOpen}>
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog className="max-w-2xl">
              <Modal.Body className="grid gap-6 p-8">
                <div className="grid justify-items-center gap-2 text-center">
                  <Modal.Icon aria-hidden="true" className="bg-accent/10 text-accent">
                    <HugeiconsIcon icon={SquareLock01Icon} size={20} />
                  </Modal.Icon>
                  <Modal.Heading className="text-2xl">Unlock passwords</Modal.Heading>
                  <Typography color="muted" type="body">
                    Enter your master password to open the vault.
                  </Typography>
                </div>

                <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
                  <TextField
                    isRequired
                    isInvalid={error !== null}
                    type="password"
                    value={password}
                    onChange={(value) => {
                      setPassword(value)
                      setError(null)
                    }}
                  >
                    <Label>Master Password</Label>
                    <Input fullWidth autoComplete="off" ref={passwordRef} variant="secondary" />
                    {error ? <FieldError>{error}</FieldError> : null}
                  </TextField>

                  <Button
                    isDisabled={busy}
                    className="w-full"
                    type="submit"
                    onPress={() => void submit()}
                  >
                    <HugeiconsIcon aria-hidden="true" icon={SquareLock01Icon} size={18} />
                    {busy ? 'Unlocking...' : 'Unlock'}
                  </Button>

                  {helloReady ? (
                    <Button
                      className="w-full"
                      isDisabled={helloBusy || busy}
                      variant="secondary"
                      onPress={() => void unlockWithHello()}
                    >
                      {helloBusy ? 'Waiting for Windows Hello...' : 'Unlock with Windows Hello'}
                    </Button>
                  ) : null}

                  {notice ? (
                    <Typography role="status" type="body">
                      {notice}
                    </Typography>
                  ) : null}
                  {recoveryEnabled ? (
                    <Button className="justify-self-center" variant="ghost" onPress={() => setRecovering(true)}>
                      Forgot it? Use recovery kit
                    </Button>
                  ) : null}
                </form>
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <RecoveryDialog
        mode={recovering ? 'recover' : null}
        scope="passwords"
        onClose={() => setRecovering(false)}
        onDone={() => {
          setRecovering(false)
          setNotice('Your new vault password is set. Unlock with it now.')
        }}
      />
    </>
  )
}
