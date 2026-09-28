import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Button, Dropdown, Label, Modal, Skeleton, Tooltip, Typography } from '@heroui/react'
import {
  Delete02Icon,
  EyeIcon,
  FolderOpenIcon,
  FolderRemoveIcon,
  Layers01Icon,
  SidebarLeftIcon,
  StarIcon,
  Tag01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useNavigate } from 'react-router-dom'

import {
  BranchedMenu,
  type BranchedMenuChild,
  type BranchedMenuItem,
} from '../../components/ui/BranchedMenu'
import { CollectionSelect, ConfirmDialog } from '../../components/items/dialogs'
import { deleteCollection, listCollections, type Collection } from '../../data/collections'
import { VAULT_CHANGED_EVENT } from '../../data/events'
import { listItems, moveItemsToCollection, type ItemSummary } from '../../data/items'
import { notifyError, notifySuccess, trashWithUndo } from '../../lib/feedback'
import { openItemByKind } from './itemOpen'
import {
  ITEM_DROPPED_EVENT,
  ITEM_DRAG_END_EVENT,
  ITEM_DRAG_OVER_EVENT,
  ITEM_DRAG_START_EVENT,
  type ItemDragOverDetail,
  type ItemDropDetail,
} from './itemDrag'

const ICON_COMPONENTS: Record<string, IconSvgElement> = {
  folder: FolderOpenIcon,
  star: StarIcon,
  tag: Tag01Icon,
  layers: Layers01Icon,
}

const MOVE_ERROR = 'Could not move this item. Try again.'
const OPEN_ERROR = 'Could not open this item. Try again.'
const LOAD_ERROR = 'Could not load these items.'

const DROP_TARGET_CLASS = 'outline-2 outline-offset-2 outline-focus'

/** The tree geometry the Figma frames fix: a trunk near the left edge, one
 * elbow per row, and the child labels a step further in. */
const MENU_INDENT = 48
const MENU_TRUNK = 6
const MENU_ROW_HEIGHT = 32
const MENU_WIDTH = 288

type ItemsEntry = {
  status: 'loading' | 'ready' | 'error'
  items: ItemSummary[]
}

type Notice = { tone: 'ok' | 'error'; text: string }

/** What the single row menu is open on: a folder head or one item row. */
type MenuTarget = { kind: 'folder'; collection: Collection } | { kind: 'item'; item: ItemSummary }

function collectionIcon(icon: string | null) {
  return (icon ? ICON_COMPONENTS[icon] : undefined) ?? FolderOpenIcon
}

function itemCountLabel(count: number) {
  return count === 1 ? '1 Item' : `${count} Items`
}

function itemTitle(item: ItemSummary) {
  return item.title || item.file?.originalName || 'Untitled item'
}

/** Three shimmer bars hold the height of the branch lines while the items of an
 * open collection load. */
function loadingChildren(): BranchedMenuChild[] {
  return [
    {
      value: 'loading-1',
      disabled: true,
      label: <span aria-hidden="true" className="skeleton skeleton--shimmer block h-3 w-24" />,
    },
    {
      value: 'loading-2',
      disabled: true,
      label: <span aria-hidden="true" className="skeleton skeleton--shimmer block h-3 w-20" />,
    },
    {
      value: 'loading-3',
      disabled: true,
      label: <span aria-hidden="true" className="skeleton skeleton--shimmer block h-3 w-28" />,
    },
  ]
}

function CollectionFolderPanelSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="flex w-80 shrink-0 flex-col gap-3 self-stretch rounded-3xl border border-default bg-surface p-4"
      role="status"
    >
      <span className="sr-only">Loading collection folders</span>
      <div aria-hidden="true" className="grid gap-4">
        <div className="flex items-center justify-between">
          <Skeleton animationType="shimmer" className="h-4 w-28 rounded" />
          <Skeleton animationType="shimmer" className="size-8 rounded-xl" />
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton animationType="shimmer" className="size-4 shrink-0 rounded" />
            <Skeleton animationType="shimmer" className="h-4 w-2/3 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

const COLLAPSED_ROW_CLASS =
  'size-10 shrink-0 rounded-xl text-muted transition-colors ease-out hover:bg-default hover:text-foreground [&_svg]:size-5'

export function CollectionFolderPanel() {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [overId, setOverId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [openIds, setOpenIds] = useState<string[]>([])
  const [itemsById, setItemsById] = useState<Record<string, ItemsEntry>>({})
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [moveTarget, setMoveTarget] = useState<ItemSummary | null>(null)
  const [moveCollectionId, setMoveCollectionId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null)
  const inFlight = useRef(new Set<string>())
  const openedFirst = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLSpanElement>(null)

  const loadItems = useCallback((collectionId: string, refresh = false) => {
    if (refresh) inFlight.current.delete(collectionId)
    if (inFlight.current.has(collectionId)) return

    inFlight.current.add(collectionId)

    setItemsById((current) => {
      // A refresh keeps the rows that are already there, so the tree does not
      // blink back to bars after a drop.
      if (current[collectionId]?.status === 'ready') return current
      return { ...current, [collectionId]: { status: 'loading', items: [] } }
    })

    listItems({ collectionId })
      .then((items) => {
        setItemsById((current) => ({
          ...current,
          [collectionId]: { status: 'ready', items },
        }))
      })
      .catch(() => {
        setItemsById((current) => ({
          ...current,
          [collectionId]: { status: 'error', items: [] },
        }))
      })
      .finally(() => {
        inFlight.current.delete(collectionId)
      })
  }, [])

  useEffect(() => {
    let active = true

    listCollections()
      .then((loaded) => {
        if (active) {
          setCollections(loaded)
          setIsLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setCollections(null)
          setIsLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  // The pages dispatch these events, so the panel needs no props. The drop
  // handler reads the loaded collections to name the collection that took the
  // card, which is why this effect follows them.
  useEffect(() => {
    function handleStart() {
      setIsDragging(true)
      setNotice(null)
    }

    function handleEnd() {
      setIsDragging(false)
      setOverId(null)
    }

    function handleOver(event: Event) {
      setOverId((event as CustomEvent<ItemDragOverDetail>).detail?.collectionId ?? null)
    }

    async function handleDropped(event: Event) {
      const detail = (event as CustomEvent<ItemDropDetail>).detail

      if (!detail) return

      const target = collections?.find((collection) => collection.id === detail.collectionId)

      setOverId(null)
      setNotice(null)

      try {
        await moveItemsToCollection(detail.itemIds, detail.collectionId)
      } catch {
        setNotice({ tone: 'error', text: MOVE_ERROR })
        return
      }

      setNotice({
        tone: 'ok',
        text: target ? `Moved to ${target.name}` : 'Item moved',
      })

      try {
        setCollections(await listCollections())
      } catch {
        // The move itself succeeded, so the collections the panel has stay.
      }

      // The item left one collection and joined another, so every open tree
      // refetches its rows.
      const open = openIds
      for (const id of open) loadItems(id, true)
      if (!open.includes(detail.collectionId)) loadItems(detail.collectionId, true)
    }

    window.addEventListener(ITEM_DRAG_START_EVENT, handleStart)
    window.addEventListener(ITEM_DRAG_END_EVENT, handleEnd)
    window.addEventListener(ITEM_DRAG_OVER_EVENT, handleOver)
    window.addEventListener(ITEM_DROPPED_EVENT, handleDropped)

    return () => {
      window.removeEventListener(ITEM_DRAG_START_EVENT, handleStart)
      window.removeEventListener(ITEM_DRAG_END_EVENT, handleEnd)
      window.removeEventListener(ITEM_DRAG_OVER_EVENT, handleOver)
      window.removeEventListener(ITEM_DROPPED_EVENT, handleDropped)
    }
  }, [collections, openIds, loadItems])

  // Every vault write announces itself, so the panel reloads its collections and
  // each open branch without the caller passing props. A refresh keeps the rows
  // on screen while they refetch, so the tree never folds or blinks.
  useEffect(() => {
    function handleVaultChanged() {
      listCollections()
        .then((loaded) => setCollections(loaded))
        .catch(() => undefined)

      for (const id of openIds) loadItems(id, true)
    }

    window.addEventListener(VAULT_CHANGED_EVENT, handleVaultChanged)

    return () => window.removeEventListener(VAULT_CHANGED_EVENT, handleVaultChanged)
  }, [openIds, loadItems])

  // Every collection shows, empty or not, so the list never changes shape in
  // the middle of a drag, and an empty folder is always a drop target.
  const visible = collections ?? []

  // The first collection that holds items starts unfolded, so the panel shows
  // its items right away. An empty first collection would unfold on nothing.
  const firstWithItems = visible.findIndex((collection) => collection.itemCount > 0)
  const firstOpenIndex = firstWithItems >= 0 ? firstWithItems : 0

  useEffect(() => {
    if (openedFirst.current) return

    const first = visible[firstOpenIndex]
    if (!first) return

    openedFirst.current = true
    setOpenIds([first.id])
    loadItems(first.id)
  }, [visible, firstOpenIndex, loadItems])

  if (isLoading) return <CollectionFolderPanelSkeleton />
  if (!collections || visible.length === 0) return null

  function handleToggle(index: number, menuIsOpen: boolean) {
    const collection = visible[index]

    if (!collection) return

    if (menuIsOpen) {
      setOpenIds((current) =>
        current.includes(collection.id) ? current : [...current, collection.id],
      )
      loadItems(collection.id)
      return
    }

    setOpenIds((current) => current.filter((id) => id !== collection.id))
  }

  async function openItem(item: ItemSummary) {
    setNotice(null)

    try {
      await openItemByKind(item, (id) => navigate(`/notes/${id}`))
    } catch {
      setNotice({ tone: 'error', text: OPEN_ERROR })
    }
  }

  const itemLookup: Record<string, ItemSummary> = {}
  const menuItems: BranchedMenuItem[] = visible.map((collection) => {
    const entry = itemsById[collection.id]
    let children: BranchedMenuChild[]

    if (entry?.status === 'loading') children = loadingChildren()
    else if (entry?.status === 'error') {
      children = [{ value: `${collection.id}-error`, disabled: true, label: LOAD_ERROR }]
    } else {
      children = (entry?.items ?? []).map((item) => {
        itemLookup[item.id] = item
        return { value: item.id, label: itemTitle(item) }
      })
    }

    return {
      value: collection.id,
      ariaLabel: `${collection.name} ${itemCountLabel(collection.itemCount)}`,
      icon: (
        <HugeiconsIcon
          aria-hidden="true"
          icon={collectionIcon(collection.icon)}
          size={18}
          strokeWidth={1.75}
        />
      ),
      label: collection.name,
      className: overId === collection.id ? DROP_TARGET_CLASS : undefined,
      data: { 'data-collection-drop': collection.id },
      children,
    }
  })

  function findTarget(value: string | undefined): MenuTarget | null {
    if (!value) return null

    const item = itemLookup[value]
    if (item) return { kind: 'item', item }

    const collection = visible.find((candidate) => candidate.id === value)
    return collection ? { kind: 'folder', collection } : null
  }

  function openMenuAt(target: MenuTarget, x: number, y: number) {
    setMenuPoint({ x, y })
    setMenuTarget(target)
  }

  // Right click lands the menu where the pointer is, the same way the item cards
  // do it. The anchor is a zero-size span inside the panel's relative wrapper.
  function handleRowContextMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    node: BranchedMenuItem | BranchedMenuChild,
  ) {
    event.preventDefault()

    const target = findTarget(node.value)
    if (!target) return

    const bounds = panelRef.current?.getBoundingClientRect()
    openMenuAt(target, event.clientX - (bounds?.left ?? 0), event.clientY - (bounds?.top ?? 0))
  }

  // The menu key and Shift + F10 open the menu from the keyboard, under the row
  // that has focus.
  function handleMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-bm-row]')
    const target = findTarget(row?.dataset.bmRow)
    if (!target || !row) return

    event.preventDefault()

    const bounds = panelRef.current?.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    openMenuAt(target, rect.left - (bounds?.left ?? 0) + 16, rect.bottom - (bounds?.top ?? 0))
  }

  function handleMenuAction(key: string) {
    const target = menuTarget
    if (!target) return

    setMenuTarget(null)

    if (target.kind === 'folder') {
      if (key === 'open') navigate(`/collections?collection=${target.collection.id}`)
      else if (key === 'delete') setDeleteTarget(target.collection)
      return
    }

    const item = target.item

    if (key === 'open') void openItem(item)
    else if (key === 'move') {
      setMoveCollectionId(item.collectionId)
      setMoveTarget(item)
    } else if (key === 'remove') void handleRemove(item)
    else if (key === 'trash') void trashWithUndo({ ids: [item.id], label: 'Item' })
  }

  async function handleMove() {
    if (!moveTarget) return

    try {
      await moveItemsToCollection([moveTarget.id], moveCollectionId)
      setMoveTarget(null)
      notifySuccess('Item moved to collection')
    } catch {
      notifyError('Kivo could not move this item. Try again.')
    }
  }

  async function handleRemove(item: ItemSummary) {
    try {
      await moveItemsToCollection([item.id], null)
      notifySuccess('Item removed from collection')
    } catch {
      notifyError('Kivo could not remove this item from the collection. Try again.')
    }
  }

  async function handleDeleteCollection() {
    if (!deleteTarget) return

    const id = deleteTarget.id
    setDeleteTarget(null)

    try {
      await deleteCollection(id)
      notifySuccess('Collection deleted')
    } catch {
      notifyError('Kivo could not delete this collection. Try again.')
    }
  }

  const showExpanded = isOpen || isDragging
  const toggleLabel = showExpanded ? 'Collapse collection folder' : 'Expand collection folder'

  return (
    // The list row measures this wrapper, never the panel itself, so the panel
    // takes the height of the list area beside it and a long tree scrolls
    // inside the panel instead of stretching the page. The floor keeps the
    // panel readable next to a list that is shorter than the tree.
    <div
      ref={panelRef}
      className={`relative min-h-96 shrink-0 transition-[width] duration-300 ease-out ${
        showExpanded ? 'w-80' : 'w-16'
      }`}
    >
      <aside
        aria-label="Collection folders"
        className={`absolute inset-0 flex flex-col gap-3 rounded-3xl border border-default bg-surface ${
          showExpanded ? 'p-4' : 'px-2 py-4'
        }`}
      >
        <div
          className={`flex items-center gap-2 ${showExpanded ? 'justify-between' : 'justify-center'}`}
        >
          {showExpanded ? (
            <Typography className="truncate" color="muted" type="body-sm" weight="medium">
              Collection Folder
            </Typography>
          ) : null}

          <Button
            aria-expanded={showExpanded}
            aria-label={toggleLabel}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setIsOpen((value) => !value)}
          >
            <HugeiconsIcon aria-hidden="true" icon={SidebarLeftIcon} size={18} />
          </Button>
        </div>

        {showExpanded ? (
          <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={handleMenuKey}>
            <BranchedMenu
              accentColor="var(--foreground)"
              className="kivo-collection-menu"
              color="var(--foreground)"
              defaultActive=""
              defaultOpen={firstOpenIndex}
              indent={MENU_INDENT}
              items={menuItems}
              lineColor="color-mix(in oklab, var(--foreground) 28%, transparent)"
              rowHeight={MENU_ROW_HEIGHT}
              trunk={MENU_TRUNK}
              width={MENU_WIDTH}
              onContextMenu={handleRowContextMenu}
              onSelect={(value) => {
                const item = itemLookup[value]

                if (item) void openItem(item)
              }}
              onToggle={handleToggle}
            />
          </div>
        ) : (
          <ul className="flex flex-col items-center gap-2">
            {visible.map((collection) => (
              <li
                key={collection.id}
                className={`rounded-xl ${overId === collection.id ? DROP_TARGET_CLASS : ''}`}
                data-collection-drop={collection.id}
              >
                <Tooltip.Root>
                  <Button
                    aria-label={`Open collection ${collection.name}`}
                    className={COLLAPSED_ROW_CLASS}
                    isIconOnly
                    variant="ghost"
                    onPress={() => navigate(`/collections?collection=${collection.id}`)}
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={collectionIcon(collection.icon)}
                      size={20}
                      strokeWidth={1.75}
                    />
                  </Button>
                  <Tooltip.Content>{collection.name}</Tooltip.Content>
                </Tooltip.Root>
              </li>
            ))}
          </ul>
        )}

        {notice ? (
          <Typography
            className={notice.tone === 'error' ? 'font-semibold text-danger' : undefined}
            color="muted"
            role={notice.tone === 'error' ? 'alert' : 'status'}
            type="body-xs"
          >
            {notice.text}
          </Typography>
        ) : null}
      </aside>

      {/* The popover anchors to this zero-size mark so the menu opens where the
          pointer was, rather than at a fixed corner of the panel. */}
      <span
        ref={menuAnchorRef}
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{ left: menuPoint.x, top: menuPoint.y }}
      />

      <Dropdown
        isOpen={menuTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMenuTarget(null)
        }}
      >
        <Dropdown.Trigger aria-label="Collection row actions" className="sr-only" />
        <Dropdown.Popover triggerRef={menuAnchorRef}>
          <Dropdown.Menu
            autoFocus
            className="kivo-row-actions-menu"
            onAction={(key) => handleMenuAction(String(key))}
          >
            {menuTarget?.kind === 'folder' ? (
              <>
                <Dropdown.Item id="open" key="open" textValue="Open collection">
                  <HugeiconsIcon aria-hidden="true" icon={FolderOpenIcon} size={16} />
                  <Label>Open collection</Label>
                </Dropdown.Item>
                <Dropdown.Section
                  aria-label="Danger zone"
                  className="mt-1 border-t border-separator pt-1"
                >
                  <Dropdown.Item
                    id="delete"
                    key="delete"
                    textValue="Delete collection"
                    variant="danger"
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      className="text-danger"
                      icon={Delete02Icon}
                      size={16}
                    />
                    <Label>Delete collection</Label>
                  </Dropdown.Item>
                </Dropdown.Section>
              </>
            ) : menuTarget?.kind === 'item' ? (
              <>
                <Dropdown.Item id="open" key="open" textValue="Open">
                  <HugeiconsIcon aria-hidden="true" icon={EyeIcon} size={16} />
                  <Label>Open</Label>
                </Dropdown.Item>
                <Dropdown.Item id="move" key="move" textValue="Move to Collection…">
                  <HugeiconsIcon aria-hidden="true" icon={FolderOpenIcon} size={16} />
                  <Label>Move to Collection…</Label>
                </Dropdown.Item>
                <Dropdown.Item id="remove" key="remove" textValue="Remove from Collection">
                  <HugeiconsIcon aria-hidden="true" icon={FolderRemoveIcon} size={16} />
                  <Label>Remove from Collection</Label>
                </Dropdown.Item>
                <Dropdown.Section
                  aria-label="Danger zone"
                  className="mt-1 border-t border-separator pt-1"
                >
                  <Dropdown.Item id="trash" key="trash" textValue="Move to Trash" variant="danger">
                    <HugeiconsIcon
                      aria-hidden="true"
                      className="text-danger"
                      icon={Delete02Icon}
                      size={16}
                    />
                    <Label>Move to Trash</Label>
                  </Dropdown.Item>
                </Dropdown.Section>
              </>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <Modal
        isOpen={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null)
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Move item to collection</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <CollectionSelect
                  label="Collection"
                  value={moveCollectionId}
                  onChange={setMoveCollectionId}
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
        confirmLabel="Delete collection"
        description="This removes the collection. The items inside stay in your library."
        open={deleteTarget !== null}
        title="Delete this collection?"
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteCollection()}
      />
    </div>
  )
}
