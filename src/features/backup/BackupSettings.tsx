import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, Description, Dropdown, Input, Label, Separator, TextField, Typography } from '@heroui/react'
import { CloudUploadIcon, DatabaseRestoreIcon, Folder01Icon, Stethoscope02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { createBackupNow, inspectBackup, pickBackupDestination, pickBackupSource, type BackupInfo } from '../../data/backup'
import { readProtectionState } from '../../data/protection'
import RestoreDialog from './RestoreDialog'
import SelectiveRestoreDialog from './SelectiveRestoreDialog'
import VaultHealthDialog from './VaultHealthDialog'

export default function BackupSettings() {
  const [result, setResult] = useState<BackupInfo | null>(null)
  const [restore, setRestore] = useState<BackupInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // With an app lock, backups are encrypted with the Master Password.
  const [lockEnabled, setLockEnabled] = useState(false)
  const [password, setPassword] = useState('')
  const [healthOpen, setHealthOpen] = useState(false)
  const [pickFrom, setPickFrom] = useState<BackupInfo | null>(null)

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
  // Checks the chosen backup, then opens a full restore or the item picker.
  async function check(open: (backup: BackupInfo) => void) {
    setBusy(true); setError(null)
    try {
      const path = await pickBackupSource()
      if (path) { const inspected = await inspectBackup(path); setResult(inspected); open(inspected) }
    } catch { setError('Could not open this backup. Nothing was changed.') }
    finally { setBusy(false) }
  }
  return (
    <Card aria-labelledby="backup-title">
      <Card.Content className="grid gap-5">
        <div className="grid gap-1">
          <Typography className="text-lg font-semibold" id="backup-title" type="h2">Backup and restore</Typography>
          <Typography color="muted" type="body-sm">
            Kivo does not make backups automatically, so back up now and then and keep a copy on another drive.
          </Typography>
        </div>

        {/* One row per job: what it does on the left, its action on the right. */}
        <div className="grid gap-4">
          <Row
            title="Back up"
            hint={`Saves this vault's notes, files, passwords and settings to Documents › Kivo Backups, in a folder named after the vault. ${lockEnabled
              ? 'Backups are encrypted with your Master Password; you will need it to restore.'
              : 'Backups are not encrypted. Set a Master Password to encrypt them.'}`}
          >
            <Button isDisabled={busy} variant="tertiary" onPress={() => void create(true)}>
              <HugeiconsIcon aria-hidden="true" icon={Folder01Icon} size={16} />
              Back up to folder...
            </Button>
            <Button isDisabled={busy} onPress={() => void create(false)}>
              <HugeiconsIcon aria-hidden="true" icon={CloudUploadIcon} size={16} />
              Back up now
            </Button>
          </Row>
          {lockEnabled ? (
            <TextField className="max-w-sm" type="password" value={password} onChange={setPassword}>
              <Label>Master Password</Label>
              <Input autoComplete="current-password" />
            </TextField>
          ) : null}

          <Separator />

          <Row title="Restore" hint="Bring back your whole vault, or only the notes, sources and files you pick.">
            <Dropdown>
              <Button isDisabled={busy} variant="secondary">
                <HugeiconsIcon aria-hidden="true" icon={DatabaseRestoreIcon} size={16} />
                Restore...
              </Button>
              <Dropdown.Popover>
                <Dropdown.Menu
                  onAction={(key) => void check(key === 'some' ? setPickFrom : setRestore)}
                >
                  <Dropdown.Item id="some" textValue="Restore some items">
                    <div className="grid">
                      <Label>Restore some items...</Label>
                      <Description>Added as copies. Nothing is replaced.</Description>
                    </div>
                  </Dropdown.Item>
                  <Dropdown.Item id="all" textValue="Replace my whole vault">
                    <div className="grid">
                      <Label>Replace my whole vault...</Label>
                      <Description>A safety copy of your vault is made first.</Description>
                    </div>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </Row>

          <Separator />

          <Row title="Vault health" hint="Finds missing files and damaged records, and offers fixes that never delete data.">
            <Button isDisabled={busy} variant="secondary" onPress={() => setHealthOpen(true)}>
              <HugeiconsIcon aria-hidden="true" icon={Stethoscope02Icon} size={16} />
              Check vault health
            </Button>
          </Row>
        </div>

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
        <VaultHealthDialog open={healthOpen} onClose={() => setHealthOpen(false)} />
        <SelectiveRestoreDialog backup={pickFrom} onClose={() => setPickFrom(null)} />
      </Card.Content>
    </Card>
  )
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="grid min-w-0 flex-1 basis-72 gap-0.5">
        <Typography type="body" weight="medium">{title}</Typography>
        <Typography color="muted" type="body-sm">{hint}</Typography>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
