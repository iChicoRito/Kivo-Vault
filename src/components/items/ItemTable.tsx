import { useRef, useState } from 'react'
import {
  Chip,
  Dropdown,
  EmptyState,
  Label,
  Pagination,
  Skeleton,
  Typography,
} from '@heroui/react'
import {
  CheckmarkSquare02Icon,
  Delete02Icon,
  DeletePutBackIcon,
  EyeIcon,
  FolderOpenIcon,
  InboxIcon,
  Link02Icon,
  NoteEditIcon,
  StarIcon,
  StarOffIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

import type { ItemKind, ItemSummary } from '../../data/items'
import { ITEM_DRAG_ID_ATTRIBUTE, startItemDrag } from '../../features/collections/itemDrag'
import { SelectMark } from './ItemCard'
import { ListScrollArea } from './ListScrollArea'
import type { Selection } from './useSelection'

export type ItemTableProps = {
  items: ItemSummary[]
  totalItems: number
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onOpen?: (id: string) => void
  onToggleFavorite?: (id: string, next: boolean) => void
  onMove?: (id: string) => void
  onTrash?: (id: string) => void
  onRestore?: (id: string) => void
  onDeletePermanently?: (id: string) => void
  emptyMessage?: string
  /** Adds a Select entry to the row menu and checkboxes while selecting. */
  selection?: Selection
  /** Lets rows be dragged onto the collection panel, with every selected row riding along. */
  draggable?: boolean
}

const KIND_LABELS: Record<ItemKind, string> = {
  note: 'Note',
  source: 'Source',
  file: 'File',
}

const KIND_ICONS: Record<ItemKind, IconSvgElement> = {
  note: NoteEditIcon,
  source: Link02Icon,
  file: FolderOpenIcon,
}

export function ItemTableSkeleton({ label }: { label: string }) {
  return (
    <div aria-label={label} aria-live="polite" className="grid gap-4" role="status">
      <span className="sr-only">{label}</span>
      <ListScrollArea>
        <ul aria-hidden="true" className="grid gap-2">
          {Array.from({ length: 5 }, (_, index) => (
            <li key={index}>
              <div className="relative grid grid-cols-[auto_1fr] items-center gap-3 rounded-3xl border border-default bg-surface p-3">
                <Skeleton animationType="shimmer" className="size-11 rounded-xl" />
                <div className="grid min-w-0 gap-1">
                  <Skeleton animationType="shimmer" className="h-5 w-14 rounded-full" />
                  <Skeleton animationType="shimmer" className="h-5 w-2/3 rounded-md" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </ListScrollArea>
    </div>
  )
}

export function ItemTable({
  items,
  totalItems,
  page,
  pageSize,
  onPageChange,
  onOpen,
  onToggleFavorite,
  onMove,
  onTrash,
  onRestore,
  onDeletePermanently,
  emptyMessage = 'No items yet.',
  selection,
  draggable = false,
}: ItemTableProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, totalItems)
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)
  const [menuItem, setMenuItem] = useState<ItemSummary | null>(null)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const tableRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLSpanElement>(null)

  function handleRowAction(item: ItemSummary, key: string) {
    if (key === 'select') selection?.pick(item.id)
    else if (key === 'open') onOpen?.(item.id)
    else if (key === 'favorite') onToggleFavorite?.(item.id, !item.isFavorite)
    else if (key === 'move') onMove?.(item.id)
    else if (key === 'trash') onTrash?.(item.id)
    else if (key === 'restore') onRestore?.(item.id)
    else if (key === 'delete-permanently') onDeletePermanently?.(item.id)
  }

  return (
    <div ref={tableRef} className="relative grid gap-4">
      {items.length === 0 ? (
        <EmptyState className="flex min-h-[200px] w-full flex-col items-center justify-center gap-4 text-center">
          <HugeiconsIcon aria-hidden="true" className="text-muted" icon={InboxIcon} size={24} />
          <span className="text-sm text-muted">{emptyMessage}</span>
        </EmptyState>
      ) : (
        <ListScrollArea>
          <ul aria-label="All items" className="grid gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                {...(draggable ? { [ITEM_DRAG_ID_ATTRIBUTE]: item.id } : {})}
                className={draggable ? 'select-none' : undefined}
                onPointerDown={
                  draggable
                    ? (event) =>
                        startItemDrag(
                          event,
                          selection?.isSelected(item.id)
                            ? selection.selectedIn(items.map((entry) => entry.id))
                            : [item.id],
                        )
                    : undefined
                }
                onContextMenu={(event) => {
                  event.preventDefault()

                  const bounds = tableRef.current?.getBoundingClientRect()
                  setMenuItem(item)
                  setMenuPoint({
                    x: event.clientX - (bounds?.left ?? 0),
                    y: event.clientY - (bounds?.top ?? 0),
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

                  event.preventDefault()

                  const row = event.currentTarget.getBoundingClientRect()
                  const bounds = tableRef.current?.getBoundingClientRect()
                  setMenuItem(item)
                  setMenuPoint({
                    x: row.left - (bounds?.left ?? 0) + 16,
                    y: row.top - (bounds?.top ?? 0) + 16,
                  })
                }}
              >
                <div
                  className={`kivo-item-card relative rounded-3xl border bg-surface transition-[background-color,scale,border-color] duration-300 ease-out hover:z-10 hover:scale-[1.02] hover:bg-surface-hover ${selection?.isSelected(item.id) ? 'border-accent/40' : 'border-default'}`}
                >
                  <button
                    aria-label={item.title}
                    aria-pressed={selection?.isActive ? selection.isSelected(item.id) : undefined}
                    className="flex w-full items-center gap-3 rounded-3xl p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    type="button"
                    onClick={() =>
                      selection?.isActive ? selection.pick(item.id) : onOpen?.(item.id)
                    }
                  >
                    {selection?.isActive ? (
                      <SelectMark isSelected={selection.isSelected(item.id)} />
                    ) : null}
                    <span className="grid size-11 place-items-center rounded-xl bg-default">
                      <HugeiconsIcon
                        aria-hidden="true"
                        className="text-muted"
                        icon={KIND_ICONS[item.kind]}
                        size={18}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Chip color="accent" size="sm" variant="secondary">
                          {KIND_LABELS[item.kind]}
                        </Chip>
                        {item.kind === 'file' && item.fileMissing ? (
                          <Chip color="danger" size="sm" variant="soft">
                            File is missing
                          </Chip>
                        ) : null}
                      </span>
                      <Typography className="truncate font-semibold" type="body">
                        {item.title}
                      </Typography>
                    </span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </ListScrollArea>
      )}

      {/* The row menu opens where the pointer was, so it anchors to this
          zero-size mark instead of a fixed corner of the row. */}
      <span
        ref={menuAnchorRef}
        aria-hidden="true"
        className="pointer-events-none absolute z-20"
        style={{ left: menuPoint.x, top: menuPoint.y }}
      />

      <Dropdown
        isOpen={menuItem !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setMenuItem(null)
        }}
      >
        <Dropdown.Trigger aria-label="Item actions" className="sr-only" />
        <Dropdown.Popover triggerRef={menuAnchorRef}>
          <Dropdown.Menu
            autoFocus
            className="kivo-row-actions-menu"
            onAction={(key) => {
              if (menuItem) handleRowAction(menuItem, String(key))
            }}
          >
            {selection ? (
              <Dropdown.Item
                id="select"
                textValue={menuItem && selection.isSelected(menuItem.id) ? 'Deselect' : 'Select'}
              >
                <HugeiconsIcon aria-hidden="true" icon={CheckmarkSquare02Icon} size={16} />
                <Label>{menuItem && selection.isSelected(menuItem.id) ? 'Deselect' : 'Select'}</Label>
              </Dropdown.Item>
            ) : null}
            {onOpen ? (
              <Dropdown.Item id="open" textValue="Open details">
                <HugeiconsIcon aria-hidden="true" icon={EyeIcon} size={16} />
                <Label>Open details</Label>
              </Dropdown.Item>
            ) : null}
            {onToggleFavorite ? (
              <Dropdown.Item
                id="favorite"
                textValue={menuItem?.isFavorite ? 'Remove favorite' : 'Add to favorites'}
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  icon={menuItem?.isFavorite ? StarOffIcon : StarIcon}
                  size={16}
                />
                <Label>{menuItem?.isFavorite ? 'Remove favorite' : 'Add to favorites'}</Label>
              </Dropdown.Item>
            ) : null}
            {onMove ? (
              <Dropdown.Item id="move" textValue="Move to collection">
                <HugeiconsIcon aria-hidden="true" icon={FolderOpenIcon} size={16} />
                <Label>Move to collection</Label>
              </Dropdown.Item>
            ) : null}
            {onRestore ? (
              <Dropdown.Item id="restore" textValue="Restore">
                <HugeiconsIcon aria-hidden="true" icon={DeletePutBackIcon} size={16} />
                <Label>Restore</Label>
              </Dropdown.Item>
            ) : null}
            <Dropdown.Section
              aria-label="Danger zone"
              className="mt-1 border-t border-separator pt-1"
            >
              {onTrash ? (
                <Dropdown.Item id="trash" textValue="Move to trash" variant="danger">
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="text-danger"
                    icon={Delete02Icon}
                    size={16}
                  />
                  <Label>Move to trash</Label>
                </Dropdown.Item>
              ) : null}
              {onDeletePermanently ? (
                <Dropdown.Item
                  id="delete-permanently"
                  textValue="Delete permanently"
                  variant="danger"
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="text-danger"
                    icon={Delete02Icon}
                    size={16}
                  />
                  <Label>Delete permanently</Label>
                </Dropdown.Item>
              ) : null}
            </Dropdown.Section>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      {totalItems > 0 ? (
        <Pagination size="sm">
          <Pagination.Summary>
            Showing {start} to {end} of {totalItems} items
          </Pagination.Summary>
          <Pagination.Content>
            <Pagination.Item>
              <Pagination.Previous isDisabled={page <= 1} onPress={() => onPageChange(page - 1)}>
                <Pagination.PreviousIcon />
                Prev
              </Pagination.Previous>
            </Pagination.Item>
            {pageNumbers.map((number) => (
              <Pagination.Item key={number}>
                <Pagination.Link isActive={number === page} onPress={() => onPageChange(number)}>
                  {number}
                </Pagination.Link>
              </Pagination.Item>
            ))}
            <Pagination.Item>
              <Pagination.Next
                isDisabled={page >= totalPages}
                onPress={() => onPageChange(page + 1)}
              >
                Next
                <Pagination.NextIcon />
              </Pagination.Next>
            </Pagination.Item>
          </Pagination.Content>
        </Pagination>
      ) : null}
    </div>
  )
}
