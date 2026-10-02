import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Card, Input, Label, Modal, Separator, TextField, Typography } from '@heroui/react'
import { SquareLock01Icon } from '@hugeicons/core-free-icons'

import { DialogHeader } from '../../components/DialogHeader'
import {
  disableDeviceUnlock,
  enrollDeviceUnlock,
  readDeviceUnlockStatus,
  type DeviceUnlockStatus,
} from '../../data/deviceUnlock'
import { errorText, type VaultScope } from '../../data/recovery'
import { notifySuccess } from '../../lib/feedback'
import { useSecurityChanged } from '../../lib/useVaultChanged'

const ROWS: Array<{ scope: VaultScope; title: string; password: string }> = [
  { scope: 'content', title: 'Master Password', password: 'Master Password' },
  { scope: 'passwords', title: 'Password vault', password: 'Vault password' },
]

/**
 * Windows Hello as a shortcut for typing a password, set up per vault. The
 * password and any recovery kit keep working.
 */
export default function DeviceUnlockSettings() {
  const [status, setStatus] = useState<Partial<Record<VaultScope, DeviceUnlockStatus>>>({})
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<{ scope: VaultScope; mode: 'enable' | 'disable' } | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setFailed(false)
    Promise.all(ROWS.map((row) => readDeviceUnlockStatus(row.scope)))
      .then((list) => setStatus(Object.fromEntries(list.map((item) => [item.scope, item]))))
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])
  // Setting or removing the Master Password changes what can be offered here.
  useSecurityChanged(load)

  function close() {
    if (busy) return
    setOpen(null)
    setPassword('')
    setError(null)
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!open || busy) return
    if (!password) return setError('Enter the password first.')
    setBusy(true)
    setError(null)
    try {
      if (open.mode === 'enable') {
        const result = await enrollDeviceUnlock(open.scope, password)
        if (result.status === 'cancelled') {
          setError('Windows Hello was cancelled. Nothing was set up.')
          return
        }
        notifySuccess('Windows Hello is set up')
      } else {
        await disableDeviceUnlock(open.scope, password)
        notifySuccess('Windows Hello turned off')
      }
      setOpen(null)
      setPassword('')
      load()
    } catch (reason) {
      setError(errorText(reason, 'Kivo could not finish this. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }

  const row = ROWS.find((item) => item.scope === open?.scope)

  return (
    <Card aria-labelledby="device-unlock-title">
      <Card.Content className="grid gap-4">
        <div className="grid gap-1">
          <Typography className="text-lg font-semibold" id="device-unlock-title" type="h2">
            Windows Hello
          </Typography>
          <Typography color="muted" type="body-sm">
            Unlock with your face, fingerprint or Windows PIN instead of typing the password. The
            password and recovery kits still work. Anyone signed in to your Windows account, including
            programs running as you, may be able to reach the saved key, so only use this on your own
            computer.
          </Typography>
        </div>

        {failed ? (
          <Typography className="text-danger" role="alert" type="body-sm">
            Windows Hello status could not load. It needs the Kivo desktop app on Windows.
          </Typography>
        ) : null}

        {ROWS.map((item, index) => {
          const current = status[item.scope]
          return (
            <div key={item.scope} className="grid gap-4">
              {index > 0 ? <Separator /> : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="grid min-w-0 gap-0.5">
                  <Typography className="font-medium" type="body">
                    {item.title}
                    {current?.enrolled ? <span className="ml-2 text-sm font-normal text-success">On</span> : null}
                  </Typography>
                  <Typography color="muted" type="body-sm">
                    {current && !current.available && current.unavailableReason
                      ? current.unavailableReason
                      : 'Turning it on asks for the password, then Windows Hello once.'}
                  </Typography>
                </div>
                {current?.enrolled ? (
                  <Button variant="secondary" onPress={() => setOpen({ scope: item.scope, mode: 'disable' })}>
                    Turn off
                  </Button>
                ) : current?.available ? (
                  <Button variant="secondary" onPress={() => setOpen({ scope: item.scope, mode: 'enable' })}>
                    Turn on
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </Card.Content>

      <Modal isOpen={open !== null} onOpenChange={(isOpen) => { if (!isOpen) close() }}>
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <DialogHeader
                description={
                  open?.mode === 'enable'
                    ? 'Enter the password, then confirm with Windows Hello. Changing the password, using a recovery kit or restoring a backup turns this off again.'
                    : 'Unlocking will need the password again.'
                }
                icon={SquareLock01Icon}
                title={open?.mode === 'enable' ? `Turn on Windows Hello for the ${row?.title ?? ''}` : 'Turn off Windows Hello?'}
              />
              <form className="contents" noValidate onSubmit={(event) => void submit(event)}>
                <Modal.Body className="grid gap-4">
                  <TextField isInvalid={error !== null} type="password" value={password} onChange={setPassword}>
                    <Label>{row?.password ?? 'Password'}</Label>
                    <Input autoComplete="current-password" autoFocus variant="secondary" />
                  </TextField>
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
                    {busy
                      ? open?.mode === 'enable'
                        ? 'Waiting for Windows Hello...'
                        : 'Turning off...'
                      : open?.mode === 'enable'
                        ? 'Continue'
                        : 'Turn off'}
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
