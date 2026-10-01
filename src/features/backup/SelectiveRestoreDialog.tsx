import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Checkbox, Input, Label, Modal, TextArea, TextField, Typography } from '@heroui/react'
import { DatabaseRestoreIcon } from '@hugeicons/core-free-icons'

import { DialogHeader } from '../../components/DialogHeader'
import {
  listBackupContents,
  restoreFromBackup,
  type BackupInfo,
  type BackupItem,
  type BackupUnlock,
} from '../../data/backup'
import type { ImportReport } from '../../data/portability'

export type SelectiveRestoreDialogProps = {
  /** The checked backup to pick from; null keeps the dialog closed. */
  backup: BackupInfo | null
  onClose: () => void
}

const KIND_LABEL: Record<BackupItem['kind'], string> = { note: 'Note', source: 'Source', file: 'File' }
const NO_COLLECTION = 'Not in a collection'

function errorText(error: unknown, fallback: string): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return text.trim() ? text.replace(/^Error:\s*/, '') : fallback
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Brings back chosen notes, sources and files from a backup. They are added as
 * new copies; nothing already in the vault is replaced.
 */
export function SelectiveRestoreDialog({ backup, onClose }: SelectiveRestoreDialogProps) {
  const [password, setPassword] = useState('')
  const [kit, setKit] = useState('')
  const [useKit, setUseKit] = useState(false)
  // How the backup was opened, reused for the restore. Cleared on close.
  const [opened, setOpened] = useState<BackupUnlock | undefined>(undefined)
  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(unlock?: BackupUnlock) {
    if (!backup) return
    setError(null)
    setBusy(true)
    try {
      setItems(await listBackupContents(backup.path, unlock))
      setOpened(unlock)
    } catch (reason) {
      setError(errorText(reason, 'Kivo could not open this backup. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }

  // A plain backup opens straight away; an encrypted one waits for its password.
  useEffect(() => {
    setItems(null)
    setChosen(new Set())
    setSearch('')
    setReport(null)
    setError(null)
    setPassword('')
    setKit('')
    setUseKit(false)
    setOpened(undefined)
    if (backup && !backup.encrypted) void load()
  }, [backup]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase()
    const byCollection = new Map<string, BackupItem[]>()
    for (const item of items ?? []) {
      if (query && !item.title.toLowerCase().includes(query)) continue
      const name = item.collection ?? NO_COLLECTION
      byCollection.set(name, [...(byCollection.get(name) ?? []), item])
    }
    return [...byCollection.entries()].sort(([a], [b]) =>
      a === NO_COLLECTION ? 1 : b === NO_COLLECTION ? -1 : a.localeCompare(b),
    )
  }, [items, search])

  function setMany(ids: string[], on: boolean) {
    setChosen((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function unlock(event: FormEvent) {
    event.preventDefault()
    if (useKit) {
      if (!kit.trim()) return setError('Paste your recovery key.')
      return void load({ recoveryKey: kit })
    }
    if (!password) {
      setError('Enter the Master Password this backup was made with.')
      return
    }
    void load({ password })
  }

  async function restore() {
    if (!backup) return
    setError(null)
    setBusy(true)
    try {
      // The password stays only while this dialog is open; closing it clears it.
      setReport(await restoreFromBackup(backup.path, [...chosen], backup.encrypted ? opened : undefined))
    } catch (reason) {
      setError(errorText(reason, 'Kivo could not restore these items. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }

  const needsPassword = Boolean(backup?.encrypted)
  const locked = needsPassword && items === null

  return (
    <Modal
      isOpen={backup !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <DialogHeader
              description={`Backup from ${backup?.createdAt ?? ''}. Chosen items are added as new copies; nothing in your vault is replaced.`}
              icon={DatabaseRestoreIcon}
              title="Restore some items"
            />
            <Modal.Body className="grid gap-4">
              {locked ? (
                <form className="grid gap-3" noValidate onSubmit={unlock}>
                  {useKit ? (
                    <TextField value={kit} onChange={setKit}>
                      <Label>Recovery key</Label>
                      <TextArea autoComplete="off" autoFocus placeholder="KIVO-RECOVERY-V1:..." spellCheck={false} />
                    </TextField>
                  ) : (
                    <TextField className="max-w-sm" type="password" value={password} onChange={setPassword}>
                      <Label>Master Password</Label>
                      <Input autoComplete="current-password" autoFocus />
                    </TextField>
                  )}
                  <Typography color="muted" type="body-sm">
                    {useKit
                      ? 'Use the Master Password recovery kit that was active when this backup was made.'
                      : backup?.recoveryAvailable
                        ? 'This backup is encrypted. Use the Master Password it was made with, or your recovery kit.'
                        : 'This backup is encrypted. Use the Master Password it was made with.'}
                  </Typography>
                  {backup?.recoveryAvailable ? (
                    <Button
                      className="justify-self-start"
                      variant="ghost"
                      onPress={() => {
                        setUseKit((value) => !value)
                        setError(null)
                      }}
                    >
                      {useKit ? 'Use the Master Password instead' : 'Forgot it? Use recovery kit'}
                    </Button>
                  ) : null}
                  <Button className="justify-self-start" isDisabled={busy} type="submit">
                    {busy ? 'Opening...' : 'Open backup'}
                  </Button>
                </form>
              ) : null}

              {!locked && items === null && busy ? <p role="status">Reading the backup...</p> : null}

              {items && !report ? (
                items.length === 0 ? (
                  <Typography type="body">This backup has no notes, sources or files.</Typography>
                ) : (
                  <>
                    <TextField className="w-full" value={search} onChange={setSearch}>
                      <Label>Search this backup</Label>
                      <Input placeholder="Title" variant="secondary" />
                    </TextField>
                    <div aria-label="Items in this backup" className="grid max-h-80 gap-3 overflow-y-auto pr-1" role="group">
                      {groups.length === 0 ? <Typography color="muted" type="body-sm">Nothing matches that search.</Typography> : null}
                      {groups.map(([name, members]) => {
                        const ids = members.map((item) => item.id)
                        const count = ids.filter((id) => chosen.has(id)).length
                        return (
                          <section key={name} aria-label={name} className="grid gap-1">
                            <Checkbox
                              isIndeterminate={count > 0 && count < ids.length}
                              isSelected={count === ids.length}
                              onChange={(on) => setMany(ids, on)}
                            >
                              <Checkbox.Content>
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                                <span className="font-semibold">{name}</span>
                                <span className="text-sm text-muted">{plural(ids.length, 'item')}</span>
                              </Checkbox.Content>
                            </Checkbox>
                            <ul className="grid gap-1 pl-6">
                              {members.map((item) => (
                                <li key={item.id}>
                                  <Checkbox isSelected={chosen.has(item.id)} onChange={(on) => setMany([item.id], on)}>
                                    <Checkbox.Content className="min-w-0">
                                      <Checkbox.Control>
                                        <Checkbox.Indicator />
                                      </Checkbox.Control>
                                      <span className="truncate">{item.title}</span>
                                      <span className="shrink-0 text-xs text-muted">{KIND_LABEL[item.kind]}</span>
                                      {item.alreadySaved ? (
                                        <span className="shrink-0 text-xs text-muted">Already in your vault</span>
                                      ) : null}
                                    </Checkbox.Content>
                                  </Checkbox>
                                </li>
                              ))}
                            </ul>
                          </section>
                        )
                      })}
                    </div>
                  </>
                )
              ) : null}

              {report ? (
                <div className="grid gap-1" role="status">
                  <Typography type="body" weight="medium">
                    {plural(report.imported, 'item')} restored.
                  </Typography>
                  {report.skipped.map((entry, index) => (
                    <Typography key={`${entry.title}-${index}`} type="body-sm">
                      Skipped {entry.title}: {entry.reason}
                    </Typography>
                  ))}
                </div>
              ) : null}

              {error ? (
                <Typography className="text-danger" role="alert" type="body-sm">
                  {error}
                </Typography>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              {report ? (
                <Button onPress={onClose}>Done</Button>
              ) : (
                <>
                  <Button isDisabled={busy} variant="secondary" onPress={onClose}>
                    Cancel
                  </Button>
                  {items && items.length > 0 ? (
                    <Button
                      isDisabled={busy || chosen.size === 0}
                      onPress={() => void restore()}
                    >
                      {busy ? 'Restoring...' : `Restore ${plural(chosen.size, 'item')}`}
                    </Button>
                  ) : null}
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default SelectiveRestoreDialog
