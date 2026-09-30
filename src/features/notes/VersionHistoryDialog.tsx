import { useEffect, useState } from 'react'
import { Button, Modal } from '@heroui/react'
import { HistoryIcon } from '@hugeicons/core-free-icons'
import { listItemVersions, restoreItemVersion, type ItemVersion } from '../../data/versions'
import type { VaultItem } from '../../data/items'
import { ConfirmDialog } from '../../components/items/dialogs'
import { DialogHeader } from '../../components/DialogHeader'

export function VersionHistoryDialog({ itemId, onClose, onRestore }: { itemId: string | null; onClose: () => void; onRestore: (item: VaultItem) => void }) {
  const [versions, setVersions] = useState<ItemVersion[] | null>(null)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!itemId) return
    let active = true
    setVersions(null); setError(false)
    listItemVersions(itemId).then((rows) => { if (active) setVersions(rows) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [itemId, attempt])
  async function restore() {
    if (!selected) return
    try { const item = await restoreItemVersion(selected); setSelected(null); onRestore(item); onClose() }
    catch { setError(true); setSelected(null) }
  }
  return <>
    <Modal isOpen={itemId !== null} onOpenChange={(open) => { if (!open) onClose() }}><Modal.Backdrop><Modal.Container><Modal.Dialog>
      <DialogHeader icon={HistoryIcon} title="Version history" description="Earlier versions of this note, newest first." />
      <Modal.Body className="grid gap-3">
        {!versions && !error ? <p role="status">Loading versions...</p> : null}
        {error ? <div role="alert">Versions could not load. <Button variant="secondary" onPress={() => setAttempt((value) => value + 1)}>Try again</Button></div> : null}
        {versions?.length === 0 ? <p>No earlier versions yet. Edited notes will appear here.</p> : null}
        {versions?.map((version) => <article key={version.id} className="grid gap-2 rounded-lg border border-default p-3"><h3 className="font-semibold">{version.title}</h3><time dateTime={version.createdAt} className="text-sm text-muted">{new Date(version.createdAt).toLocaleString()}</time><div className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">{new DOMParser().parseFromString(version.content, 'text/html').body.textContent}</div><Button className="justify-self-start" variant="secondary" onPress={() => setSelected(version.id)}>Restore this version</Button></article>)}
      </Modal.Body><Modal.Footer><Button variant="secondary" onPress={onClose}>Close</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    <ConfirmDialog icon={HistoryIcon} open={selected !== null} title="Restore this version?" description="Your current note is saved as a version before restoring." confirmLabel="Restore version" onCancel={() => setSelected(null)} onConfirm={() => void restore()} />
  </>
}
