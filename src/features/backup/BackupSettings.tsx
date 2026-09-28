import { useEffect, useState } from 'react'
import { Button, Card, Input, Label, TextField, Typography } from '@heroui/react'
import { createBackupNow, inspectBackup, pickBackupDestination, pickBackupSource, type BackupInfo } from '../../data/backup'
import { readProtectionState } from '../../data/protection'
import RestoreDialog from './RestoreDialog'

export default function BackupSettings() {
  const [result, setResult] = useState<BackupInfo | null>(null)
  const [restore, setRestore] = useState<BackupInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // With an app lock, backups are encrypted with the Master Password.
  const [lockEnabled, setLockEnabled] = useState(false)
  const [password, setPassword] = useState('')

  useEffect(() => {
    let active = true
    readProtectionState()
      .then((state) => { if (active) setLockEnabled(Boolean(state?.lockEnabled)) })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  // Every backup lands in its own new dated folder, so nothing is ever replaced.
  // With no folder chosen it goes to "Kivo Backups" in Documents.
  async function create(chooseFolder: boolean) {
    if (lockEnabled && !password) {
      setError('Enter your Master Password to encrypt the backup.')
      return
    }
    setBusy(true); setError(null)
    try {
      const folder = chooseFolder ? await pickBackupDestination() : null
      if (chooseFolder && !folder) return
      setResult(await createBackupNow(folder, lockEnabled ? password : undefined))
      setPassword('')
    } catch (reason) {
      const text = String(reason)
      setError(
        text.includes('Incorrect Master Password') ? 'That Master Password is not correct.'
          : text.includes('Too many wrong tries') ? text.replace(/^Error:\s*/, '')
            : 'Could not make the backup. Try again, or pick another folder.',
      )
    } finally { setBusy(false) }
  }
  async function check() {
    setBusy(true); setError(null)
    try {
      const path = await pickBackupSource()
      if (path) { const inspected = await inspectBackup(path); setResult(inspected); setRestore(inspected) }
    } catch { setError('Could not open this backup. Nothing was changed.') }
    finally { setBusy(false) }
  }
  return <Card aria-labelledby="backup-title"><Card.Content className="grid gap-4">
    <div className="grid gap-1">
      <Typography className="text-lg font-semibold" id="backup-title" type="h2">Backup and restore</Typography>
      <Typography color="muted" type="body-sm">Back up now saves everything, including notes, files, passwords, and settings, to Documents › Kivo Backups in one click. Kivo does not make backups automatically, so keep a copy on another drive.</Typography>
      <Typography color="muted" type="body-sm">{lockEnabled
        ? 'Backups are encrypted with your Master Password. You will need it to restore.'
        : 'This backup is not encrypted. Set a Master Password to encrypt backups.'}</Typography>
    </div>
    {lockEnabled ? <TextField className="max-w-sm" type="password" value={password} onChange={setPassword}>
      <Label>Master Password</Label>
      <Input autoComplete="current-password" />
    </TextField> : null}
    <div className="flex flex-wrap gap-3"><Button isDisabled={busy} onPress={() => void create(false)}>Back up now</Button><Button isDisabled={busy} variant="secondary" onPress={() => void create(true)}>Back up to folder...</Button><Button isDisabled={busy} variant="secondary" onPress={() => void check()}>Restore from backup</Button></div>
    {busy ? <Typography role="status" type="body-sm">Working on your backup...</Typography> : null}
    {result ? <div className="grid gap-0.5 rounded-xl bg-(--default) px-4 py-3" role="status">
      <Typography type="body-sm" weight="medium">{result.valid ? 'This backup looks good.' : 'This backup has problems.'} {result.encrypted
        ? `Encrypted, made ${result.createdAt}.`
        : `${result.itemCount} items and ${result.fileCount} files, made ${result.createdAt}.`}</Typography>
      <Typography className="break-all" color="muted" type="body-xs">{result.path}</Typography>
    </div> : null}
    {result?.problems.map((problem) => <Typography role="alert" className="text-danger" key={problem} type="body-sm">{problem}</Typography>)}
    {error ? <Typography role="alert" className="text-danger" type="body-sm">{error}</Typography> : null}
    <RestoreDialog backup={restore} onClose={() => setRestore(null)} />
  </Card.Content></Card>
}
