import { Chip, Skeleton, Typography } from '@heroui/react'
import { Link02Icon, Note01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { FileTypeIcon } from '../../components/items/FileTypeIcon'
import { ItemCard, SelectMark } from '../../components/items/ItemCard'
import { formatSize } from '../../components/items/fileSize'
import type { ItemKind, ItemSummary } from '../../data/items'
import { notePreview } from '../notes/noteContent'

export type CollectionItemViewProps = {
  item: ItemSummary
  view: 'grid' | 'list'
  /** `undefined` while the source address is still loading, `null` when none is saved. */
  address?: string | null
  onOpen: () => void
  /** While selecting, a click picks the item instead of opening it. */
  isSelecting?: boolean
  isSelected?: boolean
  onSelect?: () => void
}

const KIND_LABEL: Record<ItemKind, string> = {
  note: 'Note',
  source: 'Source',
  file: 'File',
}

/** Stands in for the body text while a note inside the collection is still empty. */
const EMPTY_NOTE_PREVIEW = "This note doesn't have any content yet."

/** A collection holds every kind side by side, so each row names its kind and flags. */
function ItemChips({ item }: { item: ItemSummary }) {
  return (
    <>
      <Chip
        color={item.kind === 'source' ? 'accent' : 'default'}
        size="sm"
        variant={item.kind === 'source' ? 'secondary' : 'soft'}
      >
        {KIND_LABEL[item.kind]}
      </Chip>
      {item.isPinned ? (
        <Chip color="accent" size="sm" variant="soft">
          Pinned
        </Chip>
      ) : null}
      {item.isFavorite ? (
        <Chip color="warning" size="sm" variant="soft">
          Favorite
        </Chip>
      ) : null}
      {item.fileMissing ? (
        <Chip color="danger" size="sm" variant="soft">
          File is missing
        </Chip>
      ) : null}
    </>
  )
}

function KindTile({ item }: { item: ItemSummary }) {
  return (
    <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-default">
      {item.kind === 'file' ? (
        <FileTypeIcon name={item.file?.originalName ?? item.title} size={22} />
      ) : (
        <HugeiconsIcon
          icon={item.kind === 'note' ? Note01Icon : Link02Icon}
          size={22}
          strokeWidth={1.75}
        />
      )}
    </span>
  )
}

function itemSubtitle(item: ItemSummary, address: string | null | undefined) {
  if (item.kind === 'note') return notePreview(item.content ?? '') || EMPTY_NOTE_PREVIEW
  if (item.kind === 'source') {
    if (address === undefined) return null
    return address ?? 'No address saved.'
  }

  return formatSize(item.file?.byteSize)
}

/**
 * One item inside a collection, in the same two shapes the Notes, Sources, and
 * Files pages use: a full-width row card and a grid card. The whole item is the
 * open action, so a click anywhere opens the note, link, or file.
 */
export function CollectionItemView({
  item,
  view,
  address,
  onOpen,
  isSelecting = false,
  isSelected = false,
  onSelect,
}: CollectionItemViewProps) {
  const subtitle = itemSubtitle(item, address)
  const isAddressPending = item.kind === 'source' && address === undefined

  if (view === 'grid') {
    return (
      <button
        aria-label={item.title}
        aria-pressed={isSelecting ? isSelected : undefined}
        className={`kivo-item-card relative flex h-full w-full cursor-pointer flex-col gap-3 rounded-3xl border bg-surface p-4 text-left transition-[background-color,scale,border-color] duration-300 ease-out hover:z-10 hover:scale-[1.02] hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${isSelected ? 'border-accent/40' : 'border-default'}`}
        type="button"
        onClick={isSelecting ? onSelect : onOpen}
      >
        <span className="flex flex-wrap items-center gap-2">
          {isSelecting ? <SelectMark isSelected={isSelected} /> : null}
          <ItemChips item={item} />
        </span>

        <span className="grid min-w-0 gap-1">
          <Typography className="truncate font-semibold" type="body">
            {item.title}
          </Typography>
          {isAddressPending ? (
            <Skeleton aria-hidden="true" animationType="shimmer" className="h-5 w-4/5 rounded" />
          ) : subtitle ? (
            <Typography className="line-clamp-2" color="muted" type="body-sm">
              {subtitle}
            </Typography>
          ) : null}
        </span>
      </button>
    )
  }

  return (
    <ItemCard
      chips={<ItemChips item={item} />}
      leading={<KindTile item={item} />}
      subtitle={
        isAddressPending ? (
          <Skeleton aria-hidden="true" animationType="shimmer" className="h-5 w-4/5 rounded" />
        ) : subtitle ? (
          <Typography className="truncate" color="muted" type="body-sm">
            {subtitle}
          </Typography>
        ) : undefined
      }
      isSelected={isSelected}
      isSelecting={isSelecting}
      title={item.title}
      onOpen={isSelecting ? onSelect : onOpen}
    />
  )
}
