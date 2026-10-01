import { useState } from 'react'
import { Button, Input, Label, Modal, TextArea, TextField, Typography } from '@heroui/react'
import { DatabaseRestoreIcon } from '@hugeicons/core-free-icons'
import { restoreBackup, type BackupInfo } from '../../data/backup'
import { useLock } from '../../app/lock'
import { DialogHeader } from '../../components/DialogHeader'

export default function RestoreDialog({ backup, onClose }: { backup: BackupInfo | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [kit, setKit] = useState('')
  const [useKit, setUseKit] = useState(false)
  const lock = useLock()
  const needsSecret = Boolean(backup?.encrypted)
  const secret = useKit ? kit.trim() : password
  function close() {
    setPassword('')
    setKit('')
    setUseKit(false)
    setError(null)
    onClose()
  }
  async function restore() {
    if (!backup?.valid || busy || (needsSecret && !secret)) return
    setBusy(true)
    try {
      const unlock = !needsSecret ? undefined : useKit ? { recoveryKey: kit } : { password }
      const result = await restoreBackup(backup.path, unlock)
      const viaKit = useKit
      close()
      // Restored vault may have a different Master Password. Never leave old content mounted.
      await lock?.lock()
      window.alert(
        `Restored ${result.itemCount} items and ${result.fileCount} files. Safety copy: ${result.safetyCopyPath}` +
          (viaKit ? '\n\nOn the unlock screen, choose "Forgot it? Use recovery kit" with the same kit to set a new Master Password.' : ''),
      )
    } catch (reason) {
      const text = String(reason).replace(/^Error:\s*/, '')
      setError(
        text.includes('does not open this backup') || text.includes('Too many wrong tries') || text.includes('recovery') || text.includes('kit')
          ? text
          : 'Restore failed. Your current vault should be unchanged. Check your backup and try again.',
      )
    } finally { setBusy(false) }
  }
  return <Modal isOpen={backup !== null} onOpenChange={(open) => { if (!open && !busy) close() }}><Modal.Backdrop><Modal.Container><Modal.Dialog>
    <DialogHeader icon={DatabaseRestoreIcon} tone="warning" title="Replace my vault?" description="This replaces your current database and managed files, not merges them. A safety copy is made first. You will need the restored vault’s Master Password." />
    <Modal.Body className="grid gap-3">
      {backup ? <Typography type="body">Backup: {backup.createdAt}, {backup.encrypted ? 'encrypted' : `${backup.itemCount} items, ${backup.fileCount} files`}. {backup.path}</Typography> : null}
      {needsSecret && !useKit ? <TextField type="password" value={password} onChange={setPassword}>
        <Label>Master Password this backup was made with</Label>
        <Input autoComplete="current-password" />
      </TextField> : null}
      {needsSecret && useKit ? <TextField value={kit} onChange={setKit}>
        <Label>Recovery key</Label>
        <TextArea autoComplete="off" placeholder="KIVO-RECOVERY-V1:..." spellCheck={false} />
      </TextField> : null}
      {needsSecret && backup?.recoveryAvailable ? (
        <Button className="justify-self-start" variant="ghost" onPress={() => { setUseKit((value) => !value); setError(null) }}>
          {useKit ? 'Use the Master Password instead' : 'Forgot it? Use recovery kit'}
        </Button>
      ) : null}
      {needsSecret && !backup?.recoveryAvailable ? (
        <Typography color="muted" type="body-sm">This backup can only be opened with the Master Password it was made with.</Typography>
      ) : null}
      {backup?.problems.map((problem) => <Typography key={problem} role="alert" type="body">{problem}</Typography>)}
      {error ? <Typography role="alert" className="text-danger" type="body">{error}</Typography> : null}
    </Modal.Body><Modal.Footer><Button variant="secondary" isDisabled={busy} onPress={close}>Cancel</Button><Button variant="danger" isDisabled={!backup?.valid || busy || (needsSecret && !secret)} onPress={() => void restore()}>{busy ? 'Restoring...' : 'Replace my vault'}</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
}
