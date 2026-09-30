import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  EmptyState,
  ListBox,
  Modal,
  Select,
  Typography,
} from '@heroui/react'
import { FolderTransferIcon, StarIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import PageHeader from '../../app/PageHeader'
import { CollectionSelect } from '../../components/items/dialogs'
import { ItemTable, ItemTableSkeleton } from '../../components/items/ItemTable'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import {
  listItems,
  moveItemsToCollection,
  setItemsFavorite,
  type ItemKind,
  type ItemSummary,
} from '../../data/items'
import { notifyError, notifySuccess, trashManyWithUndo } from '../../lib/feedback'
import { useVaultChanged } from '../../lib/useVaultChanged'
import { CollectionFolderPanel } from '../collections/CollectionFolderPanel'
import { ItemDetailsDialog } from '../items/ItemDetailsDialog'
import { DialogHeader } from '../../components/DialogHeader'

type LoadState = 'loading' | 'ready' | 'error'

type Kind = 'all' | ItemKind

const PAGE_SIZE = 10
const panelLabelClass = 'uppercase'

function KindSelect({ value, onChange }: { value: Kind; onChange: (kind: Kind) => void }) {
  return (
    <Select
      aria-label="Item type"
      className="w-44"
      selectedKey={value}
      variant="secondary"
      onSelectionChange={(key) => onChange(String(key ?? 'all') as Kind)}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id="all" textValue="All types">
            All types
          </ListBox.Item>
          <ListBox.Item id="note" textValue="Notes">
            Notes
          </ListBox.Item>
          <ListBox.Item id="source" textValue="Sources">
            Sources
          </ListBox.Item>
          <ListBox.Item id="file" textValue="Files">
            Files
          </ListBox.Item>
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

export function FavoritesPage() {
  const [items, setItems] = useState<ItemSummary[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)
  const [kind, setKind] = useState<Kind>('all')
  const [page, setPage] = useState(1)
  const [openItemId, setOpenItemId] = useState<string | null>(null)
  const [moveId, setMoveId] = useState<string | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [targetCollectionId, setTargetCollectionId] = useState<string | null>(null)

  useVaultChanged(() => setAttempt((value) => value + 1))

  useEffect(() => {
    let active = true
    setLoadState((state) => (state === 'ready' ? state : 'loading'))

    listItems(kind === 'all' ? { favorite: true } : { favorite: true, kind })
      .then((loaded) => {
        if (!active) return
        setItems(loaded)
        setLoadState('ready')
      })
      .catch(() => {
        if (active) setLoadState('error')
      })

    return () => {
      active = false
    }
  }, [attempt, kind])

  useEffect(() => {
    setPage(1)
  }, [kind])

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pagedItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const selection = useSelection()

  async function trashSelected(ids: string[]) {
    const moved = await trashManyWithUndo(ids)
    if (moved) {
      selection.clear()
      reload()
    }
  }

  function reload() {
    setAttempt((value) => value + 1)
  }

  async function handleToggleFavorite(id: string, next: boolean) {
    try {
      await setItemsFavorite([id], next)
      reload()
    } catch {
      notifyError('Kivo could not update this favorite. Your items are unchanged. Try again.')
    }
  }

  function openMove(id: string) {
    setMoveId(id)
    setTargetCollectionId(null)
    setMoveOpen(true)
  }

  async function handleMove() {
    if (!moveId) return

    try {
      await moveItemsToCollection([moveId], targetCollectionId)
      setMoveOpen(false)
      setMoveId(null)
      setTargetCollectionId(null)
      reload()
      notifySuccess('Item moved to collection')
    } catch {
      notifyError('Kivo could not move this item. Try again.')
    }
  }

  return (
    <section aria-labelledby="favorites-title" className="grid gap-5">
      <PageHeader
        description="Keep priority items easy to find."
        title="Favorites"
        titleId="favorites-title"
      />

      <div className="flex flex-wrap items-end gap-3" data-tour="favorites">
        <KindSelect value={kind} onChange={setKind} />
      </div>

      {loadState === 'loading' ? (
        <ItemTableSkeleton label="Loading favorites" />
      ) : null}

      {loadState === 'error' ? (
        <Alert aria-labelledby="favorites-error-title" role="alert" status="danger">
          <Alert.Content className="grid gap-3">
            <Typography className={panelLabelClass} color="muted" type="body-xs" weight="bold">
              ERROR
            </Typography>
            <Typography id="favorites-error-title" type="h2">
              Your favorites could not load
            </Typography>
            <Typography type="body">
              Kivo could not read favorite items. Try again to reload this list.
            </Typography>
            <Button className="justify-self-start" variant="secondary" onPress={reload}>
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {loadState === 'ready' && items.length === 0 && kind === 'all' ? (
        <EmptyState
          aria-labelledby="favorites-empty-title"
          className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center"
        >
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={StarIcon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            {/* An h2 under the page's h1, styled like the h3 titles of the other empty states. */}
            <h2 className="typography typography--h3 typography--align-center" id="favorites-empty-title">
              No favorites yet.
            </h2>
            <Typography align="center" color="muted" type="body">
              Items you mark as favorites will appear here.
            </Typography>
          </div>
        </EmptyState>
      ) : null}

      {loadState === 'ready' && (items.length > 0 || kind !== 'all') ? (
        <div className="flex gap-4">
          <CollectionFolderPanel />
          <div className="grid min-w-0 flex-1 content-start gap-5">
          <SelectionBar
            actionLabel="Move to Trash"
            confirmTrash
            selection={selection}
            visibleIds={items.map((item) => item.id)}
            onAction={(ids) => void trashSelected(ids)}
          />
          <ItemTable
          draggable
          selection={selection}
          emptyMessage="No favorites of this type."
          items={pagedItems}
          page={currentPage}
          pageSize={PAGE_SIZE}
          totalItems={items.length}
          onMove={openMove}
          onOpen={setOpenItemId}
          onPageChange={setPage}
          onToggleFavorite={(id, next) => {
            void handleToggleFavorite(id, next)
          }}
        />
          </div>
        </div>
      ) : null}

      <Modal
        isOpen={moveOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setMoveOpen(false)
            setMoveId(null)
          }
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <DialogHeader
                description="Pick where this item should live."
                icon={FolderTransferIcon}
                title="Move to collection"
              />
              <Modal.Body>
                <CollectionSelect
                  label="Collection"
                  value={targetCollectionId}
                  onChange={setTargetCollectionId}
                />
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setMoveOpen(false)}>
                  Cancel
                </Button>
                <Button onPress={() => void handleMove()}>Move</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <ItemDetailsDialog
        itemId={openItemId}
        onChanged={reload}
        onClose={() => setOpenItemId(null)}
      />
    </section>
  )
}

export default FavoritesPage
