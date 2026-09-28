import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Chip,
  Dropdown,
  EmptyState,
  FieldError,
  Input,
  InputOTP,
  Label,
  ListBox,
  Modal,
  REGEXP_ONLY_DIGITS,
  Select,
  Skeleton,
  Tabs,
  TextField,
  Typography,
} from '@heroui/react'
import {
  ArrowLeft01Icon,
  Delete02Icon,
  Download01Icon,
  EyeIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  GridViewIcon,
  Layers01Icon,
  LeftToRightListBulletIcon,
  Link02Icon,
  LockIcon,
  Note01Icon,
  NoteEditIcon,
  PlusSignIcon,
  StarIcon,
  Tag01Icon,
  CheckmarkSquare02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import PageHeader from '../../app/PageHeader'
import { usePreferences } from '../../app/preferences'
import { ItemCard, type ItemCardAction } from '../../components/items/ItemCard'
import { ListScrollArea } from '../../components/items/ListScrollArea'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import { CollectionSelect, ConfirmDialog } from '../../components/items/dialogs'
import {
  deleteCollection,
  listCollections,
  saveCollection,
  type Collection,
  type CollectionProtection,
} from '../../data/collections'
import { revealItemFile } from '../../data/files'
import { exportItemsJson, pickSaveFile } from '../../data/portability'
import {
  listItems,
  loadItem,
  moveItemsToCollection,
  type ItemSummary,
} from '../../data/items'
import type { CollectionsView } from '../../data/settings'
import { notifyError, notifySuccess, trashManyWithUndo, trashWithUndo } from '../../lib/feedback'
import { useVaultChanged } from '../../lib/useVaultChanged'
import { CollectionFolderPanel } from './CollectionFolderPanel'
import { CollectionFolderFloat } from './CollectionFolderFloat'
import { CollectionItemView } from './CollectionItemView'
import { openItemByKind } from './itemOpen'
import { startItemDrag } from './itemDrag'
import { UnlockDialog } from './UnlockDialog'

type LoadState = 'loading' | 'ready' | 'error'

const stateLabelClass = 'uppercase'
const NAME_REQUIRED_ERROR = 'Collection name is required.'
const PASSWORD_REQUIRED_ERROR = 'Enter a password for this collection.'
const PASSWORD_SHORT_ERROR = 'Password must be at least 4 characters.'
const PIN_REQUIRED_ERROR = 'Enter a 6-digit PIN.'
const SAVE_ERROR = 'Kivo could not save this collection. Try again.'
const DELETE_ERROR = 'Kivo could not delete this collection. Try again.'
const ITEMS_ERROR = 'Kivo could not load items in this collection. Try again.'
const OPEN_ERROR = 'Kivo could not open this item. Try again.'
const REVEAL_ERROR = 'Kivo could not reveal this file. It may be missing from this device.'
const REMOVE_ERROR = 'Kivo could not remove this item from the collection. Try again.'
const VIEW_ERROR = 'Kivo could not remember the collection layout. Try again.'
const EXPORT_ERROR = 'Kivo could not export this collection. Try again.'

// Kept so collections saved before the icon picker was removed still show the
// icon they stored; anything unknown falls back to the folder.
const ICON_COMPONENTS: Record<string, IconSvgElement> = {
  folder: FolderOpenIcon,
  star: StarIcon,
  tag: Tag01Icon,
  layers: Layers01Icon,
}

function collectionIcon(icon: string | null) {
  return (icon ? ICON_COMPONENTS[icon] : undefined) ?? FolderOpenIcon
}

function countCopy(count: number) {
  return count === 1 ? '1 Item on this collection' : `${count} Items on this collection`
}

// The list rows and the grid folder offer the same actions, so both build them here.
function collectionActions(collection: Collection, exporting: boolean): ItemCardAction[] {
  return [
    { id: 'view', label: `View items in ${collection.name}`, icon: EyeIcon },
    { id: 'rename', label: `Rename ${collection.name}`, icon: NoteEditIcon },
    {
      id: 'export',
      label: `Export ${collection.name}`,
      icon: Download01Icon,
      isDisabled: exporting,
    },
    {
      id: 'delete',
      label: `Delete ${collection.name}`,
      icon: Delete02Icon,
      danger: true,
    },
  ]
}

// Items inside a collection offer opening, taking the item out of the collection,
// and moving it to Trash. Files also reveal their stored copy.
function itemActions(item: ItemSummary): ItemCardAction[] {
  const actions: ItemCardAction[] = [
    {
      id: 'open',
      label: item.kind === 'note' ? 'Open note' : item.kind === 'source' ? 'Open link' : 'Open',
      icon: item.kind === 'note' ? Note01Icon : item.kind === 'source' ? Link02Icon : EyeIcon,
    },
  ]

  if (item.kind === 'file') {
    actions.push({
      id: 'reveal',
      label: 'Reveal',
      icon: FolderOpenIcon,
      isDisabled: item.fileMissing,
    })
  }

  actions.push({ id: 'move', label: 'Move to collection', icon: FolderOpenIcon })
  actions.push({ id: 'remove', label: 'Remove from collection', icon: FolderMinusIcon })
  actions.push({ id: 'trash', label: 'Move to trash', icon: Delete02Icon, danger: true })

  return actions
}

function secretError(protection: CollectionProtection, secret: string) {
  const value = secret.trim()

  if (protection === 'password') {
    if (!value) return PASSWORD_REQUIRED_ERROR
    if (value.length < 4) return PASSWORD_SHORT_ERROR
    return null
  }

  if (protection === 'pin') {
    if (!/^\d{6}$/.test(value)) return PIN_REQUIRED_ERROR
    return null
  }

  return null
}

type EditState = {
  id?: string
  name: string
  icon: string | null
  initialProtection: CollectionProtection
  protection: CollectionProtection
  secret: string
}

function CollectionChip({ collection }: { collection: Collection }) {
  const protectedCollection = collection.protection !== 'none'

  return (
    <Chip color={protectedCollection ? 'danger' : 'default'} size="sm" variant="soft">
      {protectedCollection ? (
        <>
          <HugeiconsIcon aria-hidden="true" icon={LockIcon} size={14} />
          Protected
        </>
      ) : (
        'Collection'
      )}
    </Chip>
  )
}

export function CollectionsPage() {
  const navigate = useNavigate()
  const { preferences, updatePreferences } = usePreferences()
  const view = preferences.collectionsView
  const [searchParams] = useSearchParams()

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)
  const [collections, setCollections] = useState<Collection[]>([])

  const [search, setSearch] = useState('')
  const [collectionItems, setCollectionItems] = useState<Record<string, ItemSummary[]>>({})

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [itemsState, setItemsState] = useState<LoadState>('ready')
  const [items, setItems] = useState<ItemSummary[]>([])
  const [itemsAttempt, setItemsAttempt] = useState(0)
  const [itemsView, setItemsView] = useState<'grid' | 'list'>('list')
  const [sourceUrls, setSourceUrls] = useState<Record<string, string | null>>({})
  const [itemMenu, setItemMenu] = useState<{
    item: ItemSummary
    x: number
    y: number
  } | null>(null)
  const [trashItem, setTrashItem] = useState<ItemSummary | null>(null)
  const [moveTarget, setMoveTarget] = useState<{
    id: string
    collectionId: string | null
  } | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const itemMenuAnchorRef = useRef<HTMLSpanElement>(null)

  const [unlocked, setUnlocked] = useState<Set<string>>(new Set())
  const [unlockTarget, setUnlockTarget] = useState<Collection | null>(null)
  const pendingAction = useRef<(() => void) | null>(null)

  const [edit, setEdit] = useState<EditState | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null)
  const [exporting, setExporting] = useState(false)

  const openedFromUrl = useRef(false)
  const loadedCollectionIdRef = useRef<string | null>(null)

  useVaultChanged(() => setItemsAttempt((current) => current + 1))

  const loadCollections = useCallback(async () => {
    setLoadState('loading')

    try {
      const loaded = await listCollections()
      setCollections(loaded)
      setLoadState('ready')
    } catch {
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    void loadCollections()
  }, [loadCollections, attempt])

  useEffect(() => {
    if (!selectedId) {
      setItems([])
      setItemsState('ready')
      loadedCollectionIdRef.current = null
      return
    }

    // A vault-change refresh bumps itemsAttempt with the same selection, so the
    // rows stay on screen; opening a different collection shows the skeleton again.
    const collectionChanged = loadedCollectionIdRef.current !== selectedId
    loadedCollectionIdRef.current = selectedId

    let active = true
    if (collectionChanged) setItemsState('loading')

    listItems({ collectionId: selectedId })
      .then((loaded) => {
        if (!active) return
        setItems(loaded)
        setItemsState('ready')
      })
      .catch(() => {
        if (active) setItemsState('error')
      })

    return () => {
      active = false
    }
  }, [selectedId, itemsAttempt])

  // Item summaries stay lean, so the source rows read their full records for the
  // address, the same way the Sources page fills its list.
  useEffect(() => {
    const sources = items.filter((item) => item.kind === 'source')

    if (sources.length === 0) {
      setSourceUrls({})
      return
    }

    let active = true

    Promise.allSettled(sources.map((source) => loadItem(source.id))).then((results) => {
      if (!active) return
      const entries = results.map((result, index) => [
        sources[index].id,
        result.status === 'fulfilled' ? result.value.url : null,
      ] as const)
      setSourceUrls(Object.fromEntries(entries))
    })

    return () => {
      active = false
    }
  }, [items])

  // Grid cards need every collection's titles up front. A locked collection is
  // left out entirely, so no list_items call ever runs for it; it joins the load
  // once its secret matches.
  useEffect(() => {
    if (loadState !== 'ready') return

    const targets = collections.filter(
      (collection) =>
        collection.itemCount > 0 &&
        (collection.protection === 'none' || unlocked.has(collection.id)),
    )

    let active = true

    // Each collection settles on its own, so one failing list still leaves the
    // other folders with their pills.
    Promise.allSettled(
      targets.map(async (collection) => {
        const loaded = await listItems({ collectionId: collection.id })
        return [collection.id, loaded] as const
      }),
    ).then((results) => {
      if (!active) return
      const entries = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      setCollectionItems(Object.fromEntries(entries))
    })

    return () => {
      active = false
    }
  }, [collections, loadState, unlocked])

  // Opens a collection linked from the URL once, without re-opening after the user goes back.
  useEffect(() => {
    if (openedFromUrl.current || selectedId || loadState !== 'ready') return

    const requestedId = searchParams.get('collection')
    if (!requestedId) return

    const requested = collections.find((collection) => collection.id === requestedId)
    if (!requested) return

    openedFromUrl.current = true
    runGated(requested, () => openCollection(requested))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, loadState, searchParams, selectedId])

  function isLocked(collection: Collection) {
    return collection.protection !== 'none' && !unlocked.has(collection.id)
  }

  // Every action that reads a protected collection runs through here: the action
  // runs straight away when the collection is open or already unlocked, and waits
  // for the dialog otherwise.
  function runGated(collection: Collection, action: () => void) {
    if (!isLocked(collection)) {
      action()
      return
    }

    pendingAction.current = action
    setUnlockTarget(collection)
  }

  function handleUnlocked(id: string) {
    setUnlocked((current) => {
      const next = new Set(current)
      next.add(id)
      return next
    })
    setUnlockTarget(null)

    const action = pendingAction.current
    pendingAction.current = null
    action?.()
  }

  function cancelUnlock() {
    pendingAction.current = null
    setUnlockTarget(null)
  }

  function openCollection(collection: Collection) {
    setActionError(null)
    setSelectedId(collection.id)
  }

  function openCreate() {
    setEditError(null)
    setEdit({
      name: '',
      icon: 'folder',
      initialProtection: 'none',
      protection: 'none',
      secret: '',
    })
  }

  function openRename(collection: Collection) {
    setEditError(null)
    setEdit({
      id: collection.id,
      name: collection.name,
      icon: collection.icon,
      initialProtection: collection.protection,
      protection: collection.protection,
      secret: '',
    })
  }

  async function handleSave() {
    if (!edit) return

    const name = edit.name.trim()

    if (!name) {
      setEditError(NAME_REQUIRED_ERROR)
      return
    }

    const isCreate = !edit.id
    const protectionChanged = isCreate
      ? edit.protection !== 'none'
      : edit.protection !== edit.initialProtection

    if (protectionChanged && edit.protection !== 'none') {
      const validation = secretError(edit.protection, edit.secret)
      if (validation) {
        setEditError(validation)
        return
      }
    }

    setEditError(null)

    const payload: {
      id?: string
      name: string
      icon?: string | null
      protection?: CollectionProtection
      secret?: string | null
    } = {
      id: edit.id,
      name,
      icon: edit.icon,
    }

    // A create always states its protection; an edit only when it changed, so a
    // plain rename leaves the stored hash alone.
    if (isCreate || protectionChanged) {
      payload.protection = edit.protection
      if (edit.protection !== 'none') payload.secret = edit.secret.trim()
    }

    try {
      await saveCollection(payload)
      setEdit(null)
      await loadCollections()
      notifySuccess('Collection saved')
    } catch {
      setEditError(SAVE_ERROR)
      notifyError(SAVE_ERROR)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return

    const id = deleteTarget.id
    setDeleteTarget(null)
    setActionError(null)

    try {
      await deleteCollection(id)
      if (selectedId === id) setSelectedId(null)
      await loadCollections()
      notifySuccess('Collection deleted')
    } catch {
      notifyError(DELETE_ERROR)
    }
  }

  function handleMenuAction(collection: Collection, key: string) {
    if (key === 'view') runGated(collection, () => openCollection(collection))
    else if (key === 'rename') runGated(collection, () => openRename(collection))
    else if (key === 'export') runGated(collection, () => void handleExportCollection(collection))
    else if (key === 'delete') runGated(collection, () => setDeleteTarget(collection))
  }

  // Export reads the collection once more so the file holds the live item ids,
  // not the counts the list was rendered with.
  async function handleExportCollection(collection: Collection) {
    setActionError(null)
    setExporting(true)

    try {
      const name = collection.name.replace(/[\\/:*?"<>|]/g, '_')
      const path = await pickSaveFile(`${name}.json`)
      if (!path) return

      const loaded = await listItems({ collectionId: collection.id })
      if (loaded.length === 0) return

      await exportItemsJson(loaded.map((item) => item.id), path)
      notifySuccess('Collection exported as JSON')
    } catch {
      notifyError(EXPORT_ERROR)
    } finally {
      setExporting(false)
    }
  }

  async function handleItemOpen(item: ItemSummary) {
    setActionError(null)

    try {
      await openItemByKind(item, (id) => navigate(`/notes/${id}`))
    } catch {
      setActionError(OPEN_ERROR)
    }
  }

  async function handleItemReveal(item: ItemSummary) {
    setActionError(null)

    try {
      await revealItemFile(item.id)
    } catch {
      setActionError(REVEAL_ERROR)
    }
  }

  async function handleItemRemove(item: ItemSummary) {
    setActionError(null)

    try {
      await moveItemsToCollection([item.id], null)
      setItemsAttempt((current) => current + 1)
      await loadCollections()
    } catch {
      setActionError(REMOVE_ERROR)
    }
  }

  const selection = useSelection()

  // Selection belongs to one open collection.
  useEffect(() => selection.clear(), [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function trashSelected(ids: string[]) {
    const moved = await trashManyWithUndo(ids)
    if (!moved) return
    selection.clear()
    setItemsAttempt((current) => current + 1)
    await loadCollections()
  }

  async function handleItemTrash() {
    if (!trashItem) return

    const target = trashItem.id
    setTrashItem(null)
    setActionError(null)

    const moved = await trashWithUndo({ ids: [target], label: 'Item' })

    if (moved) {
      setItemsAttempt((current) => current + 1)
      await loadCollections()
    }
  }

  function openItemMove(item: ItemSummary) {
    setMoveTarget({ id: item.id, collectionId: item.collectionId })
  }

  async function handleItemMove() {
    if (!moveTarget) return

    try {
      await moveItemsToCollection([moveTarget.id], moveTarget.collectionId)
      setMoveTarget(null)
      setItemsAttempt((current) => current + 1)
      await loadCollections()
      notifySuccess('Item moved to collection')
    } catch {
      notifyError('Kivo could not move this item. Try again.')
    }
  }

  function handleItemMenuAction(item: ItemSummary, key: string) {
    if (key === 'select') selection.pick(item.id)
    else if (key === 'open') void handleItemOpen(item)
    else if (key === 'reveal') void handleItemReveal(item)
    else if (key === 'move') openItemMove(item)
    else if (key === 'remove') void handleItemRemove(item)
    else if (key === 'trash') setTrashItem(item)
  }

  async function changeView(next: CollectionsView) {
    if (next === view) return

    try {
      setActionError(null)
      await updatePreferences({ collectionsView: next })
    } catch {
      setActionError(VIEW_ERROR)
    }
  }

  const trimmedSearch = search.trim()
  const filtered = collections.filter((collection) =>
    collection.name.toLowerCase().includes(trimmedSearch.toLowerCase()),
  )
  const selected = collections.find((collection) => collection.id === selectedId) ?? null
  const itemMenuActions: ItemCardAction[] = itemMenu
    ? [
        {
          id: 'select',
          label: selection.isSelected(itemMenu.item.id) ? 'Deselect' : 'Select',
          icon: CheckmarkSquare02Icon,
        },
        ...itemActions(itemMenu.item),
      ]
    : []

  return (
    <section
      aria-labelledby={selected ? 'collection-detail-title' : 'collections-title'}
      className="grid gap-8"
    >
      {/* An open collection is a drill-in: the chrome that belongs to the
          collection list stays away until Back. */}
      {!selected ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <PageHeader
              description="Organize items into named collections."
              title="Collections"
              titleId="collections-title"
            />
            <Button aria-label="New collection" onPress={openCreate}>
              <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
              New Collection
            </Button>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <TextField className="w-full max-w-md" value={search} onChange={setSearch}>
              <Label>Search collection</Label>
              <Input fullWidth placeholder="I am looking for..." variant="secondary" />
            </TextField>

            <Tabs
              className="w-fit"
              selectedKey={view}
              onSelectionChange={(key) => {
                if (key === 'grid' || key === 'list') void changeView(key)
              }}
            >
              <Tabs.ListContainer>
                <Tabs.List aria-label="Collection layout">
                  <Tabs.Tab id="grid">
                    <span className="flex items-center gap-2">
                      <HugeiconsIcon aria-hidden="true" icon={GridViewIcon} size={16} />
                      Grid
                    </span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="list">
                    <span className="flex items-center gap-2">
                      <HugeiconsIcon aria-hidden="true" icon={LeftToRightListBulletIcon} size={16} />
                      List
                    </span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
          </div>
        </>
      ) : null}

      {actionError ? (
        <Typography className="font-semibold text-danger" role="alert" type="body">
          {actionError}
        </Typography>
      ) : null}

      {!selected && loadState === 'loading' ? (
        <div
          aria-labelledby="collections-loading-title"
          aria-live="polite"
          className="grid gap-5"
          role="status"
        >
          <Card>
            <Card.Content className="grid gap-2">
              <Typography className={stateLabelClass} color="muted" type="body-xs" weight="bold">
                LOADING
              </Typography>
              <Typography id="collections-loading-title" type="h2">
                Loading your collections
              </Typography>
              <Typography color="muted" type="body">
                Kivo is reading collections saved in this vault.
              </Typography>
            </Card.Content>
          </Card>

          <ListScrollArea>
            <ul
              aria-hidden="true"
              className={
                view === 'grid'
                  ? 'grid gap-5 pt-10 [grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))]'
                  : 'grid gap-2'
              }
            >
              {Array.from({ length: 4 }, (_, index) => (
                <li key={index} className="min-w-0">
                  {view === 'grid' ? (
                    <div className="relative grid justify-items-center gap-2 rounded-3xl border border-default bg-surface p-3">
                      <Skeleton className="absolute right-3 top-3 h-5 w-20 rounded-full" />
                      <Skeleton className="h-[124px] w-full max-w-[168px] rounded-2xl" />
                      <div className="grid w-full justify-items-center gap-1 px-2 py-1">
                        <Skeleton className="h-5 w-2/3 rounded-md" />
                        <Skeleton className="h-4 w-3/5 rounded-md" />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-3xl border border-default bg-surface p-3">
                      <Skeleton className="size-14 shrink-0 rounded-2xl" />
                      <div className="grid min-w-0 flex-1 gap-2">
                        <Skeleton className="h-5 w-20 rounded-full" />
                        <Skeleton className="h-5 w-2/5 rounded-md" />
                        <Skeleton className="h-4 w-1/4 rounded-md" />
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </ListScrollArea>
        </div>
      ) : null}

      {!selected && loadState === 'error' ? (
        <Alert role="alert" status="danger">
          <Alert.Content className="grid gap-3">
            <Typography className={stateLabelClass} color="muted" type="body-xs" weight="bold">
              ERROR
            </Typography>
            <Typography type="h2">Your collections could not load</Typography>
            <Typography type="body">
              Kivo could not read saved collections. Try again to reload this list.
            </Typography>
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

      {loadState === 'ready' && !selectedId && collections.length === 0 ? (
        <EmptyState className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={FolderOpenIcon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            <Typography align="center" type="h3">
              No collections yet.
            </Typography>
            <Typography align="center" color="muted" type="body">
              Collections you create will appear here.
            </Typography>
          </div>
          <Button onPress={openCreate}>
            <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
            Create Collection
          </Button>
        </EmptyState>
      ) : null}

      {loadState === 'ready' && !selectedId && collections.length > 0 && filtered.length === 0 ? (
        <EmptyState className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={FolderOpenIcon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            <Typography align="center" type="h3">
              No collections match your search.
            </Typography>
            <Typography align="center" color="muted" type="body">
              Try a different word, or clear the search to see every collection.
            </Typography>
          </div>
          <Button onPress={openCreate}>
            <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
            Create Collection
          </Button>
        </EmptyState>
      ) : null}

      {loadState === 'ready' && !selectedId && filtered.length > 0 ? (
        view === 'grid' ? (
          <ListScrollArea>
            {/* The top padding clears the room an open folder's pills spring into,
                so the scroll box never cuts them off. */}
            <ul className="grid gap-5 pt-10 [grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))]">
              {filtered.map((collection) => (
                <li key={collection.id} className="min-w-0">
                  <CollectionFolderFloat
                    actions={collectionActions(collection, exporting)}
                    collection={collection}
                    items={collectionItems[collection.id] ?? []}
                    locked={isLocked(collection)}
                    onAction={(key) => handleMenuAction(collection, key)}
                    onOpenCollection={(target) =>
                      runGated(target, () => openCollection(target))
                    }
                    onOpenItem={(item) => void handleItemOpen(item)}
                  />
                </li>
              ))}
            </ul>
          </ListScrollArea>
        ) : (
          <ListScrollArea>
            <ul className="grid gap-2">
              {filtered.map((collection) => {
                const actions = collectionActions(collection, exporting)

                return (
                  <li key={collection.id} className="min-w-0">
                    <ItemCard
                      actions={actions}
                      chips={<CollectionChip collection={collection} />}
                      leading={
                        <span
                          aria-hidden="true"
                          className="grid size-14 place-items-center rounded-2xl bg-default"
                        >
                          <HugeiconsIcon
                            icon={collectionIcon(collection.icon)}
                            size={24}
                            strokeWidth={1.75}
                          />
                        </span>
                      }
                      subtitle={
                        <Typography color="muted" type="body-sm">
                          {countCopy(collection.itemCount)}
                        </Typography>
                      }
                      title={collection.name}
                      onAction={(key) => handleMenuAction(collection, key)}
                      onOpen={() => runGated(collection, () => openCollection(collection))}
                    />
                  </li>
                )
              })}
            </ul>
          </ListScrollArea>
        )
      ) : null}

      {loadState === 'ready' && selected ? (
        <div ref={detailRef} className="relative grid gap-4">
          <Button
            className="justify-self-start"
            variant="ghost"
            onPress={() => setSelectedId(null)}
          >
            <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} size={18} />
            Back
          </Button>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid gap-1">
              <Typography id="collection-detail-title" type="h2">
                {selected.name}
              </Typography>
              <Typography color="muted" type="body-sm">
                {countCopy(selected.itemCount)}
              </Typography>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Tabs
                className="w-fit"
                selectedKey={itemsView}
                onSelectionChange={(key) => {
                  if (key === 'grid' || key === 'list') setItemsView(key)
                }}
              >
                <Tabs.ListContainer>
                  <Tabs.List aria-label="Collection items layout">
                    <Tabs.Tab id="grid">
                      <span className="flex items-center gap-2">
                        <HugeiconsIcon aria-hidden="true" icon={GridViewIcon} size={16} />
                        Grid
                      </span>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab id="list">
                      <span className="flex items-center gap-2">
                        <HugeiconsIcon
                          aria-hidden="true"
                          icon={LeftToRightListBulletIcon}
                          size={16}
                        />
                        List
                      </span>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </div>
          </div>

          {itemsState === 'loading' ? (
            <div className="grid gap-3" role="status">
              <Typography color="muted" type="body">
                Loading items in this collection
              </Typography>
              <ListScrollArea>
                <ul
                  aria-hidden="true"
                  className={
                    itemsView === 'grid'
                      ? 'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]'
                      : 'grid gap-2'
                  }
                >
                  {Array.from({ length: 4 }, (_, index) => (
                    <li key={index} className="min-w-0">
                      {itemsView === 'grid' ? (
                        <div className="grid h-full gap-3 rounded-3xl border border-default bg-surface p-4">
                          <div className="flex gap-2">
                            <Skeleton className="h-5 w-12 rounded-full" />
                            <Skeleton className="h-5 w-16 rounded-full" />
                          </div>
                          <div className="grid gap-2">
                            <Skeleton className="h-5 w-2/3 rounded-md" />
                            <Skeleton className="h-4 w-full rounded-md" />
                            <Skeleton className="h-4 w-3/5 rounded-md" />
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3 rounded-3xl border border-default bg-surface p-3">
                          <Skeleton className="size-11 shrink-0 rounded-xl" />
                          <div className="grid min-w-0 flex-1 gap-2">
                            <div className="flex gap-2">
                              <Skeleton className="h-5 w-12 rounded-full" />
                              <Skeleton className="h-5 w-16 rounded-full" />
                            </div>
                            <Skeleton className="h-5 w-2/5 rounded-md" />
                            <Skeleton className="h-4 w-1/4 rounded-md" />
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </ListScrollArea>
            </div>
          ) : null}

          {itemsState === 'error' ? (
            <Typography className="font-semibold text-danger" role="alert" type="body">
              {ITEMS_ERROR}
            </Typography>
          ) : null}

          {itemsState === 'ready' ? (
            items.length === 0 ? (
              <EmptyState
                aria-label="Empty list"
                className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center"
              >
                <span
                  aria-hidden="true"
                  className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
                >
                  <HugeiconsIcon icon={FolderOpenIcon} size={24} />
                </span>
                <div className="grid max-w-lg gap-2">
                  <Typography align="center" type="h3">
                    No items in this collection.
                  </Typography>
                  <Typography align="center" color="muted" type="body">
                    Move items into this collection to see them here.
                  </Typography>
                </div>
              </EmptyState>
            ) : (
              <>
              <div className="empty:hidden">
                <SelectionBar
                  actionLabel="Move to Trash"
                  confirmTrash
                  selection={selection}
                  visibleIds={items.map((entry) => entry.id)}
                  onAction={(ids) => void trashSelected(ids)}
                />
              </div>
              <div className="flex gap-4">
              <CollectionFolderPanel />
              <div className="min-w-0 flex-1">
              <ListScrollArea>
                <ul
                  className={
                    itemsView === 'grid'
                      ? 'grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]'
                      : 'grid gap-2'
                  }
                >
                  {items.map((item) => (
                    <li
                      key={item.id}
                      data-item-drag-id={item.id}
                      className="relative min-w-0 select-none"
                      onPointerDown={(event) =>
                        startItemDrag(
                          event,
                          selection.isSelected(item.id)
                            ? selection.selectedIn(items.map((entry) => entry.id))
                            : [item.id],
                        )
                      }
                      onContextMenu={(event) => {
                        event.preventDefault()

                        const bounds = detailRef.current?.getBoundingClientRect()
                        setItemMenu({
                          item,
                          x: event.clientX - (bounds?.left ?? 0),
                          y: event.clientY - (bounds?.top ?? 0),
                        })
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                          return

                        event.preventDefault()

                        const row = event.currentTarget.getBoundingClientRect()
                        const bounds = detailRef.current?.getBoundingClientRect()
                        setItemMenu({
                          item,
                          x: row.left - (bounds?.left ?? 0) + 16,
                          y: row.top - (bounds?.top ?? 0) + 16,
                        })
                      }}
                    >
                      <CollectionItemView
                        address={sourceUrls[item.id]}
                        isSelected={selection.isSelected(item.id)}
                        isSelecting={selection.isActive}
                        item={item}
                        view={itemsView}
                        onOpen={() => void handleItemOpen(item)}
                        onSelect={() => selection.pick(item.id)}
                      />
                    </li>
                  ))}
                </ul>
              </ListScrollArea>
              </div>
              </div>
              </>
            )
          ) : null}

          {/* The item menu opens where the pointer was, so it anchors to this
              zero-size mark instead of a fixed corner of the row. */}
          <span
            ref={itemMenuAnchorRef}
            aria-hidden="true"
            className="pointer-events-none absolute z-20"
            style={{ left: itemMenu?.x ?? 0, top: itemMenu?.y ?? 0 }}
          />

          <Dropdown
            isOpen={itemMenu !== null}
            onOpenChange={(isOpen) => {
              if (!isOpen) setItemMenu(null)
            }}
          >
            <Dropdown.Trigger aria-label="Item actions" className="sr-only" />
            <Dropdown.Popover triggerRef={itemMenuAnchorRef}>
              <Dropdown.Menu
                autoFocus
                className="kivo-row-actions-menu"
                onAction={(key) => {
                  if (itemMenu) handleItemMenuAction(itemMenu.item, String(key))
                }}
              >
                {itemMenuActions
                  .filter((action) => action.danger !== true)
                  .map((action) => (
                    <Dropdown.Item
                      key={action.id}
                      id={action.id}
                      isDisabled={action.isDisabled}
                      textValue={action.label}
                    >
                      <HugeiconsIcon aria-hidden="true" icon={action.icon} size={16} />
                      <Label>{action.label}</Label>
                    </Dropdown.Item>
                  ))}
                {itemMenuActions.some((action) => action.danger === true) ? (
                  <Dropdown.Section
                    aria-label="Danger zone"
                    className="mt-1 border-t border-separator pt-1"
                  >
                    {itemMenuActions
                      .filter((action) => action.danger === true)
                      .map((action) => (
                        <Dropdown.Item
                          key={action.id}
                          id={action.id}
                          isDisabled={action.isDisabled}
                          textValue={action.label}
                          variant="danger"
                        >
                          <HugeiconsIcon
                            aria-hidden="true"
                            className="text-danger"
                            icon={action.icon}
                            size={16}
                          />
                          <Label>{action.label}</Label>
                        </Dropdown.Item>
                      ))}
                  </Dropdown.Section>
                ) : null}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      ) : null}

      <Modal
        isOpen={edit !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setEdit(null)
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.CloseTrigger className="size-8 rounded-full" />
              <Modal.Header>
                <Modal.Heading className="pr-8 text-xl font-semibold">
                  {edit?.id ? 'Edit Collection' : 'New Collection'}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="grid gap-6">
                <TextField
                  isInvalid={editError === NAME_REQUIRED_ERROR}
                  value={edit?.name ?? ''}
                  onChange={(value) =>
                    setEdit((current) => (current ? { ...current, name: value } : current))
                  }
                >
                  <Label>Collection Name</Label>
                  <Input fullWidth placeholder="Enter collection name" variant="secondary" />
                  {editError === NAME_REQUIRED_ERROR ? <FieldError>{editError}</FieldError> : null}
                </TextField>

                <Select
                  fullWidth
                  placeholder="Select one"
                  selectedKey={edit && edit.protection !== 'none' ? edit.protection : null}
                  variant="secondary"
                  onSelectionChange={(key) =>
                    setEdit((current) =>
                      current
                        ? {
                            ...current,
                            protection: (key === null
                              ? 'none'
                              : String(key)) as CollectionProtection,
                            secret: '',
                          }
                        : current,
                    )
                  }
                >
                  <Label>Password Type (Optional)</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="none" textValue="None">
                        None
                      </ListBox.Item>
                      <ListBox.Item id="password" textValue="Password">
                        Password
                      </ListBox.Item>
                      <ListBox.Item id="pin" textValue="PIN">
                        PIN
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>

                {edit?.protection === 'password' ? (
                  <TextField
                    isInvalid={editError !== null}
                    value={edit.secret}
                    onChange={(value) =>
                      setEdit((current) => (current ? { ...current, secret: value } : current))
                    }
                  >
                    <Label>Password</Label>
                    <Input
                      fullWidth
                      autoComplete="new-password"
                      placeholder="Enter Password"
                      type="password"
                      variant="secondary"
                    />
                  </TextField>
                ) : null}

                {edit?.protection === 'pin' ? (
                  <div className="grid gap-2">
                    <Label>Enter 6 Digit PIN</Label>
                    <InputOTP
                      aria-label="PIN"
                      className="kivo-otp"
                      maxLength={6}
                      pattern={REGEXP_ONLY_DIGITS}
                      value={edit.secret}
                      onChange={(value) =>
                        setEdit((current) => (current ? { ...current, secret: value } : current))
                      }
                    >
                      <InputOTP.Group>
                        <InputOTP.Slot index={0} />
                        <InputOTP.Slot index={1} />
                        <InputOTP.Slot index={2} />
                        <InputOTP.Slot index={3} />
                        <InputOTP.Slot index={4} />
                        <InputOTP.Slot index={5} />
                      </InputOTP.Group>
                    </InputOTP>
                  </div>
                ) : null}

                {editError && editError !== NAME_REQUIRED_ERROR ? (
                  <Typography className="font-semibold text-danger" role="alert" type="body">
                    {editError}
                  </Typography>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="mt-8 flex flex-col gap-3">
                <Button fullWidth onPress={() => void handleSave()}>
                  {edit?.id ? 'Save Changes' : 'Create Collection'}
                </Button>
                <Button fullWidth variant="secondary" onPress={() => setEdit(null)}>
                  Cancel
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

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
                <Modal.Heading>Move item to collection</Modal.Heading>
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
                <Button onPress={() => void handleItemMove()}>Move</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <ConfirmDialog
        confirmLabel="Delete collection"
        description="Items in this collection stay in your library. Only the collection is removed."
        open={deleteTarget !== null}
        title={deleteTarget ? `Delete collection "${deleteTarget.name}"?` : 'Delete collection?'}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      />

      <ConfirmDialog
        confirmLabel="Move to trash"
        description="This item leaves every list. You can restore it from Trash."
        open={trashItem !== null}
        title="Move this item to Trash?"
        tone="danger"
        onCancel={() => setTrashItem(null)}
        onConfirm={() => void handleItemTrash()}
      />

      <UnlockDialog
        collection={unlockTarget}
        onCancel={cancelUnlock}
        onUnlocked={handleUnlocked}
      />
    </section>
  )
}

export default CollectionsPage
