import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, FieldError, Input, Label, Separator, TextField, Typography } from '@heroui/react'
import { FingerPrintScanIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import PageHeader from '../../app/PageHeader'
import VaultSwitcher from '../../app/VaultSwitcher'
import { readAppLockVerifier } from '../../data/security'
import { unlockVault as unlockContentVault } from '../../data/protection'
import { errorText, readRecoveryStatus } from '../../data/recovery'
import { readDeviceUnlockStatus, unlockWithDevice } from '../../data/deviceUnlock'
import { RecoveryDialog } from './RecoveryDialog'

export type UnlockPageProps = {
  onUnlocked?: () => void
}

const WRONG_PASSWORD_MESSAGE = 'That password did not match. Try again.'
const CHECK_ERROR_MESSAGE = 'We could not check the password. Try again.'

export default function UnlockPage({ onUnlocked }: UnlockPageProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const [recoveryEnabled, setRecoveryEnabled] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [helloReady, setHelloReady] = useState(false)
  const [helloBusy, setHelloBusy] = useState(false)

  useEffect(() => {
    passwordRef.current?.focus()
    readRecoveryStatus('content')
      .then((status) => setRecoveryEnabled(status.enabled))
      .catch(() => setRecoveryEnabled(false))
    readDeviceUnlockStatus('content')
      .then((status) => setHelloReady(status.available && status.enrolled))
      .catch(() => setHelloReady(false))
  }, [])

  async function unlockWithHello() {
    if (helloBusy || busyRef.current) return
    setHelloBusy(true)
    setError(null)
    try {
      const result = await unlockWithDevice('content')
      // A cancelled prompt is quiet; the password field stays ready.
      if (result.status === 'unlocked') {
        setPassword('')
        onUnlocked?.()
      }
    } catch (reason) {
      setError(errorText(reason, 'Windows Hello could not unlock Kivo. Use your password.'))
      void readDeviceUnlockStatus('content')
        .then((status) => setHelloReady(status.available && status.enrolled))
        .catch(() => setHelloReady(false))
    } finally {
      setHelloBusy(false)
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busyRef.current) return

    busyRef.current = true
    setChecking(true)
    setError(null)

    try {
      const verifier = await readAppLockVerifier()

      if (verifier === null) {
        onUnlocked?.()
        return
      }

      // Rust checks the password either way, so wrong tries are counted and slowed.
      const matched = await unlockContentVault(password)

      if (matched) {
        setPassword('')
        onUnlocked?.()
      } else {
        setError(WRONG_PASSWORD_MESSAGE)
      }
    } catch (reason) {
      const text = String(reason)
      setError(text.includes('Too many wrong tries') ? text.replace(/^Error:\s*/, '') : CHECK_ERROR_MESSAGE)
    } finally {
      busyRef.current = false
      setChecking(false)
    }
  }

  return (
    <section
      aria-busy={checking}
      aria-labelledby="unlock-title"
      className="grid min-h-screen place-items-center bg-background px-6 py-12 text-foreground sm:px-10"
    >
      <div className="grid w-full max-w-xl gap-8">
        <PageHeader
          description="Enter your Master Password to open Kivo on this device."
          title="Unlock your vault"
          titleId="unlock-title"
        />

        <form className="grid gap-5" noValidate onSubmit={(event) => void submit(event)}>
          <TextField
            isRequired
            isInvalid={error !== null}
            type="password"
            value={password}
            onChange={setPassword}
          >
            <Label>Master Password</Label>
            <Input fullWidth ref={passwordRef} autoComplete="current-password" />
            {error ? <FieldError>{error}</FieldError> : null}
          </TextField>

          {notice ? (
            <Typography role="status" type="body">
              {notice}
            </Typography>
          ) : null}

          {/* One primary action under the field, the other ways in below it. */}
          <div className="grid gap-3">
            <Button fullWidth isDisabled={checking} size="lg" type="submit" onPress={() => void submit()}>
              {checking ? 'Checking password...' : 'Unlock Kivo'}
            </Button>

            {helloReady ? (
              <>
                <div aria-hidden="true" className="flex items-center gap-3">
                  <Separator className="flex-1" />
                  <Typography color="muted" type="body-sm">
                    or
                  </Typography>
                  <Separator className="flex-1" />
                </div>
                <Button
                  fullWidth
                  isDisabled={helloBusy || checking}
                  size="lg"
                  variant="secondary"
                  onPress={() => void unlockWithHello()}
                >
                  <HugeiconsIcon aria-hidden="true" icon={FingerPrintScanIcon} size={20} />
                  {helloBusy ? 'Waiting for Windows Hello...' : 'Unlock with Windows Hello'}
                </Button>
              </>
            ) : null}
          </div>

          <div className="grid justify-items-center gap-1 text-center">
            {/* Other vaults are listed by name only; each opens with its own password. */}
            <VaultSwitcher canManage={false} hideWhenSingle placement="bottom" />
            {recoveryEnabled ? (
              <Button size="sm" variant="ghost" onPress={() => setRecovering(true)}>
                Forgot it? Use recovery kit
              </Button>
            ) : null}
            <Typography color="muted" type="body-sm">
              App lock keeps Kivo closed to other people. It does not encrypt your files.
            </Typography>
          </div>
        </form>
      </div>

      <RecoveryDialog
        mode={recovering ? 'recover' : null}
        scope="content"
        onClose={() => setRecovering(false)}
        onDone={() => {
          setRecovering(false)
          setNotice('Your new Master Password is set. Unlock with it now.')
          passwordRef.current?.focus()
        }}
      />
    </section>
  )
}
