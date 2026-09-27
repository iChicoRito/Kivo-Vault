import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { HugeiconsIcon } from '@hugeicons/react'
import { LibraryIcon } from '@hugeicons/core-free-icons'
import {
  Alert,
  Button,
  EmptyState,
  Input,
  Label,
  Modal,
  TextField,
  Typography,
} from '@heroui/react'

import PageHeader from '../../app/PageHeader'
import { CollectionSelect, ConfirmDialog } from '../../components/items/dialogs'
import { FilterMenu, type KindFilter } from '../../components/items/FilterMenu'
import { ItemTable, ItemTableSkeleton } from '../../components/items/ItemTable'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import { listCollections, type Collection } from '../../data/collections'
import {
  listItems,
  moveItemsToCollection,
  setItemsFavorite,
  type ItemFilter,
  type ItemSummary,
} from '../../data/items'
import { listTags, type Tag } from '../../data/tags'
import { notifyError, notifySuccess, trashManyWithUndo, trashWithUndo } from '../../lib/feedback'
import { useVaultChanged } from '../../lib/useVaultChanged'
import { QuickAddMenu } from '../quick-add/QuickAddMenu'
import { ItemDetailsDialog } from './ItemDetailsDialog'

type LoadState = 'loading' | 'ready' | 'error'

const PAGE_SIZE = 10
const panelLabelClass = 'uppercase'

function buildFilter(
  kind: KindFilter,
  collectionId: string | null,
  tag: string | null,
  favorite: boolean,
  query: string,
): ItemFilter {
  const filter: ItemFilter = {}

  if (kind !== 'all') filter.kind = kind
  if (collectionId) filter.collectionId = collectionId
  if (tag) filter.tag = tag
  if (favorite) filter.favorite = true

  const trimmedQuery = query.trim()
  if (trimmedQuery) filter.query = trimmedQuery

  return filter
}

export function ItemsPage() {
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState<ItemSummary[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)

  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<Tag[]>([])

  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [collectionId, setCollectionId] = useState<string | null>(() =>
    searchParams.get('collection'),
  )
  const [tag, setTag] = useState<string | null>(null)
  const [favorite, setFavorite] = useState(false)
  const [page, setPage] = useState(1)

  const [moveId, setMoveId] = useState<string | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [targetCollectionId, setTargetCollectionId] = useState<string | null>(null)
  const [trashId, setTrashId] = useState<string | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [openItemId, setOpenItemId] = useState<string | null>(null)

  useVaultChanged(() => setAttempt((value) => value + 1))

  useEffect(() => {
    let active = true

    Promise.all([listCollections(), listTags()])
      .then(([loadedCollections, loadedTags]) => {
        if (!active) return
        setCollections(loadedCollections)
        setTags(loadedTags)
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    setCollectionId(searchParams.get('collection'))
  }, [searchParams])

  useEffect(() => {
    let active = true
    setLoadState((state) => (state === 'ready' ? state : 'loading'))

    listItems(buildFilter(kind, collectionId, tag, favorite, query))
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
  }, [attempt, kind, collectionId, tag, favorite, query])

  useEffect(() => {
    setPage(1)
  }, [kind, collectionId, tag, favorite, query])

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pagedItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const hasActiveFilters =
    kind !== 'all' || collectionId !== null || tag !== null || favorite || query.trim() !== ''

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

  async function handleRowFavorite(id: string, nextFavorite: boolean) {
    try {
      await setItemsFavorite([id], nextFavorite)
      reload()
    } catch {
      notifyError('Kivo could not finish that action. Your items are unchanged. Try again.')
    }
  }

  function openMove(id: string) {
    setMoveId(id)
    setTargetCollectionId(null)
    setMoveOpen(true)
  }

  function openTrash(id: string) {
    setTrashId(id)
    setTrashOpen(true)
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

  async function handleTrash() {
    if (!trashId) return

    const id = trashId
    setTrashOpen(false)
    setTrashId(null)

    const moved = await trashWithUndo({ ids: [id], label: 'Item' })

    if (moved) reload()
  }

  return (
    <section aria-labelledby="items-title" className="grid gap-5">
      <PageHeader
        description="Browse saved items from one place."
        title="All Items"
        titleId="items-title"
      />

      <div className="flex flex-wrap items-end gap-3" data-tour="items">
        <TextField className="w-full max-w-sm" value={query} onChange={setQuery}>
          <Label>Search items</Label>
          <Input fullWidth placeholder="Search by title" variant="secondary" />
        </TextField>

        <FilterMenu
          collectionId={collectionId}
          collections={collections}
          favoritesOnly={favorite}
          kind={kind}
          tag={tag}
          tags={tags}
          onClear={() => {
            setKind('all')
            setCollectionId(null)
            setTag(null)
            setFavorite(false)
          }}
          onCollectionChange={setCollectionId}
          onFavoritesChange={setFavorite}
          onKindChange={setKind}
          onTagChange={setTag}
        />

        <div className="ms-auto">
          <QuickAddMenu onAdded={() => setAttempt((value) => value + 1)} />
        </div>
      </div>

      {loadState === 'loading' ? (
        <ItemTableSkeleton label="Loading items" />
      ) : null}

      {loadState === 'error' ? (
        <Alert aria-labelledby="items-error-title" role="alert" status="danger">
          <Alert.Content className="grid gap-3">
            <Typography className={panelLabelClass} color="muted" type="body-xs" weight="bold">
              ERROR
            </Typography>
            <Typography id="items-error-title" type="h2">
              Your items could not load
            </Typography>
            <Typography type="body">
              Kivo could not read saved items. Try again to reload this list.
            </Typography>
            <Button
              className="justify-self-start"
              variant="secondary"
              onPress={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {loadState === 'ready' && items.length === 0 && !hasActiveFilters ? (
        <EmptyState
          aria-labelledby="items-empty-title"
          className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center"
        >
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={LibraryIcon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            {/* An h2 under the page's h1, styled like the h3 titles of the other empty states. */}
            <h2 className="typography typography--h3 typography--align-center" id="items-empty-title">
              No items yet.
            </h2>
            <Typography align="center" color="muted" type="body">
              Save a note, source, or file to see it here.
            </Typography>
          </div>
        </EmptyState>
      ) : null}

      {loadState === 'ready' && (items.length > 0 || hasActiveFilters) ? (
        <>
          <SelectionBar
            actionLabel="Move to Trash"
            confirmTrash
            selection={selection}
            visibleIds={items.map((item) => item.id)}
            onAction={(ids) => void trashSelected(ids)}
          />
          <ItemTable
          selection={selection}
          emptyMessage="No items match your search or filters."
          items={pagedItems}
          page={currentPage}
          pageSize={PAGE_SIZE}
          totalItems={items.length}
          onMove={openMove}
          onOpen={setOpenItemId}
          onPageChange={setPage}
          onToggleFavorite={(id, next) => {
            void handleRowFavorite(id, next)
          }}
          onTrash={openTrash}
        />
        </>
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
              <Modal.Header>
                <Modal.Heading>Move to collection</Modal.Heading>
              </Modal.Header>
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

      <ConfirmDialog
        confirmLabel="Move to trash"
        description="This item leaves every list. You can restore it from Trash."
        open={trashOpen}
        title="Move this item to Trash?"
        tone="danger"
        onCancel={() => {
          setTrashOpen(false)
          setTrashId(null)
        }}
        onConfirm={() => void handleTrash()}
      />

      <ItemDetailsDialog
        itemId={openItemId}
        onChanged={() => setAttempt((value) => value + 1)}
        onClose={() => setOpenItemId(null)}
      />
    </section>
  )
}

export default ItemsPage
