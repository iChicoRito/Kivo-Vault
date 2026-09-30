import { useEffect, useState } from 'react'
import { Button, Modal, Typography } from '@heroui/react'
import { HistoryIcon } from '@hugeicons/core-free-icons'

import { ConfirmDialog } from '../../components/items/dialogs'
import {
  listCredentialVersions,
  restoreCredentialVersion,
  type CredentialVersion,
} from '../../data/passwords'
import { copySecret } from '../../lib/clipboard'
import { notifyError, notifySuccess } from '../../lib/feedback'
import { DialogHeader } from '../../components/DialogHeader'

export type CredentialHistoryDialogProps = {
  /** The credential whose history is shown; null keeps the dialog closed. */
  credentialId: string | null
  service: string
  onClose: () => void
  onRestored: () => void
}

/** Earlier versions of one credential, newest first. Built like the note history dialog. */
export function CredentialHistoryDialog({
  credentialId,
  service,
  onClose,
  onRestored,
}: CredentialHistoryDialogProps) {
  const [versions, setVersions] = useState<CredentialVersion[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!credentialId) return
    let active = true
    setVersions(null)
    setError(false)
    setRevealed(new Set())
    listCredentialVersions(credentialId)
      .then((rows) => {
        if (active) setVersions(rows)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [credentialId, attempt])

  function toggleReveal(id: string) {
    setRevealed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function copy(password: string) {
    try {
      await copySecret(password)
      notifySuccess('Password copied')
    } catch {
      notifyError('Kivo could not copy this password. Try again.')
    }
  }

  async function restore() {
    if (!selected) return
    const versionId = selected
    setSelected(null)
    try {
      await restoreCredentialVersion(versionId)
      notifySuccess('Earlier version restored')
      onRestored()
      onClose()
    } catch {
      notifyError('Kivo could not restore this version. Try again.')
    }
  }

  return (
    <>
      <Modal
        isOpen={credentialId !== null}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <DialogHeader
                description="Earlier details of this login, newest first."
                icon={HistoryIcon}
                title={`History: ${service}`}
              />
              <Modal.Body className="grid gap-3">
                {!versions && !error ? <p role="status">Loading history...</p> : null}
                {error ? (
                  <div className="grid justify-items-start gap-2" role="alert">
                    History could not load.
                    <Button variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
                      Try again
                    </Button>
                  </div>
                ) : null}
                {versions?.length === 0 ? (
                  <p>No earlier versions yet. When you change this credential, the old details appear here.</p>
                ) : null}
                {versions?.map((version) => {
                  const shown = revealed.has(version.id)
                  return (
                    <article key={version.id} className="grid gap-2 rounded-lg border border-default p-3">
                      <time className="text-sm font-semibold" dateTime={version.createdAt}>
                        {new Date(version.createdAt).toLocaleString()}
                      </time>
                      <Typography className="truncate" color="muted" type="body-sm">
                        {[version.username || 'No username', version.url].filter(Boolean).join(' · ')}
                      </Typography>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span
                          aria-label={shown ? 'Password' : 'Password hidden'}
                          className="min-w-0 flex-1 break-all font-mono text-sm"
                        >
                          {shown ? version.password : '••••••••••••'}
                        </span>
                        <Button size="sm" variant="tertiary" onPress={() => toggleReveal(version.id)}>
                          {shown ? 'Hide' : 'Show'}
                        </Button>
                        <Button size="sm" variant="tertiary" onPress={() => void copy(version.password)}>
                          Copy
                        </Button>
                      </div>
                      <Button
                        className="justify-self-start"
                        variant="secondary"
                        onPress={() => setSelected(version.id)}
                      >
                        Restore this version
                      </Button>
                    </article>
                  )
                })}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={onClose}>
                  Close
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <ConfirmDialog
        icon={HistoryIcon}
        confirmLabel="Restore version"
        description="Your current details are saved to history first, so you can switch back."
        open={selected !== null}
        title="Restore this version?"
        onCancel={() => setSelected(null)}
        onConfirm={() => void restore()}
      />
    </>
  )
}

export default CredentialHistoryDialog
