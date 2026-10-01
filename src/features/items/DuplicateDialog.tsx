import { useEffect, useState } from 'react'
import { Button, Modal, Typography } from '@heroui/react'
import { Copy01Icon } from '@hugeicons/core-free-icons'

import { DialogHeader } from '../../components/DialogHeader'
import { onCollectionAccessChanged } from '../../data/events'
import type { DuplicateMatch } from '../../data/items'
import { ItemDetailsDialog } from './ItemDetailsDialog'

export type DuplicateDecision = 'open' | 'skip' | 'keepBoth' | 'stop'

export type DuplicateConflict = {
  /** What is being captured: a file name or a link address. */
  name: string
  kind: 'link' | 'file'
  matches: DuplicateMatch[]
  accessEpoch: number
}

type DuplicateDialogProps = {
  /** `null` keeps the decision closed. */
  conflict: DuplicateConflict | null
  /** Shows Stop import when more files wait in the same batch. */
  remaining?: number
  onDecision: (decision: DuplicateDecision) => void
}

/**
 * Asks what to do when a capture matches saved items: open the saved one,
 * skip this capture, or keep both. Open existing and Skip save nothing; the
 * caller does the saving for Keep both. Escape counts as Skip.
 */
export function DuplicateDialog({ conflict, remaining = 0, onDecision }: DuplicateDialogProps) {
  const [detailsId, setDetailsId] = useState<string | null>(null)
  // Highest access epoch seen; matches from an older one may name hidden items.
  const [seenEpoch, setSeenEpoch] = useState(0)

  useEffect(
    () =>
      onCollectionAccessChanged(({ accessEpoch }) =>
        setSeenEpoch((current) => Math.max(current, accessEpoch)),
      ),
    [],
  )

  const stale = conflict !== null && seenEpoch > conflict.accessEpoch
  const matches = stale ? [] : conflict?.matches ?? []
  const what = conflict?.kind === 'file' ? 'file' : 'link'

  return (
    <>
      <Modal
        isOpen={conflict !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) onDecision('skip')
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <DialogHeader
                description={
                  conflict?.kind === 'file'
                    ? `A file with the same contents as ${conflict.name} is already saved.`
                    : `${conflict?.name ?? 'This link'} is already saved.`
                }
                icon={Copy01Icon}
                title={`This ${what} is already in Kivo`}
              />
              <Modal.Body className="grid gap-2">
                {stale ? (
                  <Typography className="text-muted" role="status" type="body-sm">
                    A collection was locked or unlocked, so Kivo hid these matches. You can still
                    skip or keep both.
                  </Typography>
                ) : (
                  <ul aria-label="Saved matches" className="grid gap-1">
                    {matches.map((match) => (
                      <li key={match.item.id} className="rounded-lg bg-default px-3 py-2">
                        <Typography className="font-medium" type="body">
                          {match.item.title || match.item.file?.originalName || 'Untitled'}
                        </Typography>
                        <Typography className="text-muted" type="body-sm">
                          {match.reason === 'url' ? 'Same address' : 'Same file contents'}
                        </Typography>
                      </li>
                    ))}
                  </ul>
                )}
              </Modal.Body>
              <Modal.Footer className="flex-wrap">
                {remaining > 0 ? (
                  <Button variant="ghost" onPress={() => onDecision('stop')}>
                    Stop import
                  </Button>
                ) : null}
                <Button
                  isDisabled={matches.length === 0}
                  variant="secondary"
                  onPress={() => {
                    setDetailsId(matches[0].item.id)
                    onDecision('open')
                  }}
                >
                  Open existing
                </Button>
                <Button variant="secondary" onPress={() => onDecision('skip')}>
                  Skip
                </Button>
                <Button onPress={() => onDecision('keepBoth')}>Keep both</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      {detailsId ? (
        <ItemDetailsDialog
          itemId={detailsId}
          onChanged={() => undefined}
          onClose={() => setDetailsId(null)}
        />
      ) : null}
    </>
  )
}
