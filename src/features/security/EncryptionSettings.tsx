import { useEffect, useState } from 'react'
import { Button, Card, Input, Label, TextField, Typography } from '@heroui/react'
import { SquareUnlock01Icon } from '@hugeicons/core-free-icons'
import { ConfirmDialog } from '../../components/items/dialogs'
import { disableEncryption, enableEncryption, readProtectionState, type ProtectionState } from '../../data/protection'
import { notifyError, notifySuccess } from '../../lib/feedback'

export default function EncryptionSettings() {
  const [state, setState] = useState<ProtectionState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void readProtectionState().then(setState).catch(() => setError('Could not check encryption. Reopen Settings to try again.')) }, [])
  async function change() {
    if (!password || !state || busy) return
    setBusy(true)
    setError(null)
    try {
      if (state.encryptionEnabled) await disableEncryption(password)
      else await enableEncryption(password)
      setState(await readProtectionState())
      setPassword('')
      setConfirm(false)
      notifySuccess(state.encryptionEnabled ? 'Encryption turned off' : 'Encryption turned on')
    } catch {
      setError('Could not change encryption. Nothing was changed. Try again.')
      notifyError('Could not change encryption')
    } finally { setBusy(false) }
  }
  return <Card aria-labelledby="encryption-title"><Card.Content className="grid gap-4">
    <div className="grid gap-1">
      <Typography className="text-lg font-semibold" id="encryption-title" type="h2">Encryption</Typography>
      <Typography color="muted" type="body-sm">Scrambles your notes and files on this device so only your Master Password can open them. Titles, tags, dates, and collections stay readable.</Typography>
    </div>
    <ul className="grid list-disc gap-1 pl-5 text-sm text-muted">
      <li>If you forget your Master Password, encrypted content cannot be recovered.</li>
      <li>Opening an encrypted file makes a temporary unlocked copy on this device.</li>
    </ul>
    {!state && !error ? <Typography role="status" type="body-sm">Checking encryption...</Typography> : null}
    {state ? <Typography role="status" type="body" weight="medium">Encryption is {state.encryptionEnabled ? 'on' : 'off'}.</Typography> : null}
    {state && !state.lockEnabled ? <Typography color="muted" type="body-sm">Set a Master Password in App lock first.</Typography> : null}
    {state?.lockEnabled ? <TextField className="max-w-md" type="password" value={password} onChange={setPassword}><Label>Master Password</Label><Input fullWidth autoComplete="current-password" variant="secondary" /></TextField> : null}
    {error ? <Typography role="alert" type="body-sm" className="text-danger">{error}</Typography> : null}
    <Button className="justify-self-start" isDisabled={!state?.lockEnabled || busy || !password} variant={state?.encryptionEnabled ? 'secondary' : 'primary'} onPress={() => state?.encryptionEnabled ? setConfirm(true) : void change()}>{busy ? 'Updating...' : state?.encryptionEnabled ? 'Turn off encryption' : 'Turn on encryption'}</Button>
    <ConfirmDialog icon={SquareUnlock01Icon} open={confirm} title="Turn off encryption?" description="Your notes and files will be saved unscrambled on this device again. Make a backup first." confirmLabel="Turn off encryption" tone="danger" onCancel={() => setConfirm(false)} onConfirm={() => void change()} />
  </Card.Content></Card>
}
