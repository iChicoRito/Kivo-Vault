import { useEffect, useState } from 'react'
import { Button, Modal } from '@heroui/react'
import { EyeIcon } from '@hugeicons/core-free-icons'
import { openItemFile, readItemFile, revealItemFile, type ItemFilePreview } from '../../data/files'
import { notifyError } from '../../lib/feedback'
import { DialogHeader } from '../../components/DialogHeader'

export function FilePreviewDialog({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  const [preview, setPreview] = useState<ItemFilePreview | null>(null)
  const [error, setError] = useState(false)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!itemId) return
    let active = true
    setPreview(null)
    setError(false)
    readItemFile(itemId).then((data) => { if (active) setPreview(data) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [itemId])

  useEffect(() => {
    if (preview?.preview !== 'pdf' || !preview.payloadBase64) return
    const bytes = Uint8Array.from(atob(preview.payloadBase64), (char) => char.charCodeAt(0))
    const next = URL.createObjectURL(new Blob([bytes], { type: preview.mime ?? 'application/pdf' }))
    setUrl(next)
    return () => { URL.revokeObjectURL(next); setUrl(null) }
  }, [preview])

  function external(reveal: boolean) {
    if (!itemId) return
    void (reveal ? revealItemFile(itemId) : openItemFile(itemId)).catch(() => notifyError('Kivo could not open this file.'))
  }

  return (
    <Modal isOpen={itemId !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal.Backdrop><Modal.Container size="lg"><Modal.Dialog>
        <DialogHeader icon={EyeIcon} title="File preview" description="A read-only look at this file." />
        <Modal.Body className="grid gap-4">
          {!preview && !error ? <p role="status">Loading file preview...</p> : null}
          {error ? <p role="alert">Preview could not load. Open the file externally or try again.</p> : null}
          {preview?.preview === 'image' && preview.payloadBase64 ? <img className="max-h-[60vh] max-w-full object-contain" src={`data:${preview.mime ?? 'application/octet-stream'};base64,${preview.payloadBase64}`} alt={preview.originalName} /> : null}
          {preview?.preview === 'pdf' && url ? <iframe className="h-[60vh] w-full" title={preview.originalName} src={url} /> : null}
          {preview?.preview === 'text' ? <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-default p-4 text-sm">{preview.text}</pre> : null}
          {preview?.truncated ? <p>Preview truncated. Open externally for the complete file.</p> : null}
          {preview?.preview === 'unsupported' ? <p>This file type cannot be previewed here. Open it externally.</p> : null}
          {preview ? <dl className="grid gap-1 text-sm"><div><dt className="inline text-muted">Name: </dt><dd className="inline break-all">{preview.originalName}</dd></div><div><dt className="inline text-muted">Type: </dt><dd className="inline">{preview.mime ?? 'Unknown'}</dd></div><div><dt className="inline text-muted">Size: </dt><dd className="inline">{preview.byteSize.toLocaleString()} bytes</dd></div><div><dt className="inline text-muted">Imported: </dt><dd className="inline">{new Date(preview.importedAt).toLocaleString()}</dd></div></dl> : null}
        </Modal.Body>
        <Modal.Footer><Button variant="secondary" onPress={() => external(false)}>Open externally</Button><Button variant="secondary" onPress={() => external(true)}>Reveal</Button><Button onPress={onClose}>Close</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
    </Modal>
  )
}
