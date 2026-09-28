import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  EmptyState,
  Input,
  Label,
  Modal,
  Skeleton,
  TextField,
  Typography,
} from '@heroui/react'
import {
  Delete02Icon,
  FolderOpenIcon,
  Link02Icon,
  NoteEditIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import PageHeader from '../../app/PageHeader'
import { CollectionSelect, ConfirmDialog } from '../../components/items/dialogs'
import { ItemCard, type ItemCardAction } from '../../components/items/ItemCard'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import { ListScrollArea } from '../../components/items/ListScrollArea'
import { notifyError, notifySuccess, trashManyWithUndo, trashWithUndo } from '../../lib/feedback'
import { useVaultChanged } from '../../lib/useVaultChanged'
import { openSourceUrl } from '../../data/files'
import { listItems, loadItem, moveItemsToCollection, type VaultItem } from '../../data/items'
import { moduleRoutes } from '../modules/ModulePage'
import { CollectionFolderPanel } from '../collections/CollectionFolderPanel'
import { startItemDrag } from '../collections/itemDrag'
import { SaveSourceDialog } from './SaveSourceDialog'

const sourcesModule = moduleRoutes.find((route) => route.path === 'sources')

if (!sourcesModule) throw new Error('Sources module metadata is missing')

const {
  description: sourcesDescription,
  title: sourcesTitle,
  loadingTitle: sourcesLoadingTitle,
  loadingDescription: sourcesLoadingDescription,
  errorTitle: sourcesErrorTitle,
  errorDescription: sourcesErrorDescription,
  emptyTitle: sourcesEmptyTitle,
  emptyDescription: sourcesEmptyDescription,
} = sourcesModule

const panelLabelClass = 'uppercase'

const OPEN_ERROR = 'Kivo could not open this address.'
const MOVE_ERROR = 'Kivo could not move this source. Try again.'

// Item summaries stay lean, so each row reads its full record for the address.
async function loadSources(query?: string) {
  const summaries = await listItems({ kind: 'source', query })
  return Promise.all(summaries.map((summary) => loadItem(summary.id)))
}

function SourcesLoadingSkeleton() {
  return (
    <ul aria-hidden="true" className="grid gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <li key={index} className="min-w-0">
          <div className="kivo-item-card relative rounded-3xl border border-default bg-surface">
            <div className="flex items-center gap-3 rounded-3xl p-3">
              <Skeleton className="size-11 shrink-0 rounded-xl" />
              <span className="grid min-w-0 flex-1 gap-1">
                <Skeleton className="h-4 w-2/3 rounded-md" />
                <Skeleton className="h-3 w-4/5 rounded-md" />
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

type LoadState = 'loading' | 'ready' | 'error'
type MoveState = { id: string; collectionId: string | null } | null

export function SourcesPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [sources, setSources] = useState<VaultItem[]>([])
  const [search, setSearch] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [trashTarget, setTrashTarget] = useState<VaultItem | null>(null)
  const [moveTarget, setMoveTarget] = useState<MoveState>(null)

  useVaultChanged(() => setAttempt((value) => value + 1))

  useEffect(() => {
    let active = true
    setLoadState((state) => (state === 'ready' ? state : 'loading'))

    loadSources(search.trim() || undefined)
      .then((loaded) => {
        if (!active) return
        setSources(loaded)
        setLoadState('ready')
      })
      .catch(() => {
        if (active) setLoadState('error')
      })

    return () => {
      active = false
    }
  }, [search, attempt])

  function openCreate() {
    setEditingId(null)
    setDialogOpen(true)
  }

  function openEdit(id: string) {
    setEditingId(id)
    setDialogOpen(true)
  }

  async function handleOpen(source: VaultItem) {
    if (!source.url) return

    try {
      await openSourceUrl(source.id)
    } catch {
      notifyError(OPEN_ERROR)
    }
  }

  const selection = useSelection()

  async function trashSelected(ids: string[]) {
    const moved = await trashManyWithUndo(ids)
    if (!moved) return
    setSources((current) => current.filter((entry) => !ids.includes(entry.id)))
    selection.clear()
  }

  async function confirmTrash() {
    const target = trashTarget
    if (!target) return

    setTrashTarget(null)
    const moved = await trashWithUndo({ ids: [target.id], label: 'Source' })

    if (moved) {
      setSources((current) => current.filter((entry) => entry.id !== target.id))
    }
  }

  async function handleMove() {
    if (!moveTarget) return

    try {
      await moveItemsToCollection([moveTarget.id], moveTarget.collectionId)
      setMoveTarget(null)
      notifySuccess('Source moved to collection')
    } catch {
      notifyError(MOVE_ERROR)
    }
  }

  function handleMenuAction(source: VaultItem, key: string) {
    if (key === 'open') void handleOpen(source)
    if (key === 'edit') openEdit(source.id)
    if (key === 'move') setMoveTarget({ id: source.id, collectionId: source.collectionId })
    if (key === 'trash') setTrashTarget(source)
  }

  return (
    <section aria-labelledby="sources-title" className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageHeader description={sourcesDescription} title={sourcesTitle} titleId="sources-title" />
        <Button data-tour="sources" onPress={openCreate}>
          <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
          New Source
        </Button>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <TextField className="w-full max-w-md" value={search} onChange={setSearch}>
          <Label>Search link</Label>
          <Input fullWidth placeholder="I am looking for..." variant="secondary" />
        </TextField>
      </div>

      {loadState === 'error' ? (
        <Alert role="alert" status="danger">
          <Alert.Content className="grid gap-3">
            <Typography className={panelLabelClass} color="muted" type="body-xs" weight="bold">
              ERROR
            </Typography>
            <Typography type="h2">{sourcesErrorTitle}</Typography>
            <Typography type="body">{sourcesErrorDescription}</Typography>
            <Button
              className="justify-self-start"
              variant="secondary"
              onPress={() => setAttempt((current) => current + 1)}
            >
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {loadState === 'ready' && sources.length === 0 && search.trim() === '' ? (
        <EmptyState className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={Link02Icon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            <Typography align="center" type="h3">
              {sourcesEmptyTitle}
            </Typography>
            <Typography align="center" color="muted" type="body">
              {sourcesEmptyDescription}
            </Typography>
          </div>
          <Button onPress={openCreate}>
            <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
            Create Source
          </Button>
        </EmptyState>
      ) : null}

      {loadState === 'ready' && sources.length === 0 && search.trim() !== '' ? (
        <EmptyState className="grid justify-items-start gap-3">
          <Typography type="h2">No sources match your search.</Typography>
          <Typography color="muted" type="body">
            Try a different word, or clear the search to see every source.
          </Typography>
        </EmptyState>
      ) : null}

      {loadState === 'loading' || (loadState === 'ready' && sources.length > 0) ? (
        <div className="flex gap-4">
          <CollectionFolderPanel />
          <div className="min-w-0 flex-1">
            {loadState === 'loading' ? (
              <div aria-live="polite" className="grid gap-4" role="status">
                <Typography className="sr-only">
                  {sourcesLoadingTitle}. {sourcesLoadingDescription}
                </Typography>
                <ListScrollArea>
                  <SourcesLoadingSkeleton />
                </ListScrollArea>
              </div>
            ) : (
              <>
                <div className="mb-3 empty:hidden">
                  <SelectionBar
                    actionLabel="Move to Trash"
                    confirmTrash
                    selection={selection}
                    visibleIds={sources.map((entry) => entry.id)}
                    onAction={(ids) => void trashSelected(ids)}
                  />
                </div>
                <ListScrollArea>
                  <ul className="grid gap-2">
                    {sources.map((source) => {
                      const actions: ItemCardAction[] = [
                        {
                          id: 'open',
                          label: 'Open link',
                          icon: Link02Icon,
                          isDisabled: !source.url,
                        },
                        {
                          id: 'edit',
                          label: 'Edit source',
                          icon: NoteEditIcon,
                        },
                        {
                          id: 'move',
                          label: 'Move to collection',
                          icon: FolderOpenIcon,
                        },
                        {
                          id: 'trash',
                          label: 'Move to trash',
                          icon: Delete02Icon,
                          danger: true,
                        },
                      ]

                      return (
                        <li
                          key={source.id}
                          data-item-drag-id={source.id}
                          className="min-w-0 select-none"
                          onPointerDown={(event) =>
                            startItemDrag(
                              event,
                              selection.isSelected(source.id)
                                ? selection.selectedIn(sources.map((entry) => entry.id))
                                : [source.id],
                            )
                          }
                        >
                          <ItemCard
                            actions={actions}
                            isSelected={selection.isSelected(source.id)}
                            isSelecting={selection.isActive}
                            onSelect={() => selection.pick(source.id)}
                            isOpenDisabled={!source.url}
                            leading={
                              <span className="grid size-11 place-items-center rounded-xl bg-default">
                                <HugeiconsIcon
                                  aria-hidden="true"
                                  className="text-muted"
                                  icon={Link02Icon}
                                  size={18}
                                  strokeWidth={1.75}
                                />
                              </span>
                            }
                            subtitle={
                              <Typography className="truncate" color="muted" type="body-sm">
                                {source.url ?? 'No address saved.'}
                              </Typography>
                            }
                            title={source.title}
                            onAction={(key) => handleMenuAction(source, key)}
                            onOpen={() => void handleOpen(source)}
                          />
                        </li>
                      )
                    })}
                  </ul>
                </ListScrollArea>
              </>
            )}
          </div>
        </div>
      ) : null}

      <SaveSourceDialog
        itemId={editingId}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => setAttempt((current) => current + 1)}
      />

      <Modal
        isOpen={moveTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setMoveTarget(null)
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Move source to collection</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="grid gap-3">
                <CollectionSelect
                  label="Collection"
                  value={moveTarget?.collectionId ?? null}
                  onChange={(value) =>
                    setMoveTarget((current) =>
                      current ? { ...current, collectionId: value } : current,
                    )
                  }
                />
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setMoveTarget(null)}>
                  Cancel
                </Button>
                <Button onPress={() => void handleMove()}>Move</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <ConfirmDialog
        confirmLabel="Move to Trash"
        description="This source leaves the Sources list and stays recoverable in the vault."
        open={trashTarget !== null}
        title="Move this source to Trash?"
        tone="danger"
        onCancel={() => setTrashTarget(null)}
        onConfirm={() => void confirmTrash()}
      />
    </section>
  )
}

export default SourcesPage
