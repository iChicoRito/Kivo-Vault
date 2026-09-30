import { useEffect, useState } from 'react'
import {
  Button,
  Input,
  Kbd,
  Label,
  Modal,
  Skeleton,
  Select,
  ListBox,
  TextField,
  Typography,
} from '@heroui/react'
import { FolderOpenIcon, Link02Icon, NoteEditIcon, Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

import { listItems, type ItemFilter, type ItemKind, type ItemSummary } from '../data/items'
import { searchRelatedItems, type RelatedResult } from '../data/insights'
import { listTags, type Tag } from '../data/tags'
import { listCollections, type Collection } from '../data/collections'
import { FilterMenu, type KindFilter } from '../components/items/FilterMenu'
import { usePreferences } from '../app/preferences'
import { ItemDetailsDialog } from '../features/items/ItemDetailsDialog'
import { DialogHeader } from '../components/DialogHeader'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

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

const RESULT_LIMIT = 8

export function NavbarSearch() {
  const { preferences } = usePreferences()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<ItemKind | null>(null)
  const [items, setItems] = useState<ItemSummary[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [attempt, setAttempt] = useState(0)
  const [openItemId, setOpenItemId] = useState<string | null>(null)
  const [related, setRelated] = useState<RelatedResult[]>([])
  const [relatedState, setRelatedState] = useState<LoadState>('idle')
  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [filterKind, setFilterKind] = useState<KindFilter>('all')
  const [filterCollection, setFilterCollection] = useState<string | null>(null)
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [filterFavorites, setFilterFavorites] = useState(false)

  const trimmedQuery = query.trim()
  const semanticSearch = preferences.semanticSearch

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setIsOpen(true)
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    if (!trimmedQuery) {
      setItems([])
      setLoadState('idle')
      return
    }

    let active = true
    setLoadState('loading')

    listItems({ query: trimmedQuery, ...(kind ? { kind } : {}) })
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
  }, [attempt, trimmedQuery, kind])

  useEffect(() => {
    if (!semanticSearch) return

    let active = true

    void Promise.all([listTags(), listCollections()])
      .then(([loadedTags, loadedCollections]) => {
        if (!active) return
        setTags(Array.isArray(loadedTags) ? loadedTags : [])
        setCollections(Array.isArray(loadedCollections) ? loadedCollections : [])
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [semanticSearch])

  useEffect(() => {
    if (!semanticSearch || !trimmedQuery) {
      setRelated([])
      setRelatedState('idle')
      return
    }

    const filter: ItemFilter = {}

    if (filterKind !== 'all') filter.kind = filterKind
    if (filterCollection) filter.collectionId = filterCollection
    if (filterTag) filter.tag = filterTag
    if (filterFavorites) filter.favorite = true

    let active = true
    setRelatedState('loading')

    searchRelatedItems(trimmedQuery, Object.keys(filter).length ? filter : undefined)
      .then((loaded) => {
        if (!active) return
        setRelated(Array.isArray(loaded) ? loaded : [])
        setRelatedState('ready')
      })
      .catch(() => {
        if (active) setRelatedState('error')
      })

    return () => {
      active = false
    }
  }, [attempt, semanticSearch, trimmedQuery, filterKind, filterCollection, filterTag, filterFavorites])

  function clearRelatedFilters() {
    setFilterKind('all')
    setFilterCollection(null)
    setFilterTag(null)
    setFilterFavorites(false)
  }

  function closeSearch() {
    setIsOpen(false)
    setQuery('')
    setKind(null)
    setItems([])
    setLoadState('idle')
    setRelated([])
    setRelatedState('idle')
    clearRelatedFilters()
  }

  function openItem(id: string) {
    setOpenItemId(id)
    closeSearch()
  }

  const visibleItems = items.slice(0, RESULT_LIMIT)
  const hasMore = items.length > RESULT_LIMIT
  const visibleRelated = related.slice(0, RESULT_LIMIT)

  return (
    <div className="min-w-0 max-w-[520px] flex-1">
      {/* The navbar field is only a launcher; typing happens in the dialog. */}
      <button
        aria-haspopup="dialog"
        aria-label="Search the vault"
        className="flex h-10 w-full min-w-0 items-center gap-2 rounded-(--field-radius) bg-(--default) px-3 text-left text-sm text-muted transition-colors hover:bg-(--default-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        type="button"
        onClick={() => setIsOpen(true)}
      >
        <HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={16} strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">Search the vault</span>
        <Kbd>
          <Kbd.Abbr keyValue="ctrl" />
          <Kbd.Content>F</Kbd.Content>
        </Kbd>
      </button>

      <Modal
        isOpen={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeSearch()
        }}
      >
        <Modal.Backdrop variant="blur">
          <Modal.Container placement="center" size="lg">
            <Modal.Dialog>
              <DialogHeader
                description="Find notes, sources, and files by title, tag, or collection."
                icon={Search01Icon}
                title="Search the vault"
              />

              <Modal.Body className="grid gap-3">
                <TextField className="w-full" value={query} onChange={setQuery}>
                  <Label className="sr-only">Search</Label>
                  <Input autoFocus fullWidth placeholder="Search the vault" variant="secondary" />
                </TextField>
                <Select aria-label="Filter by type" selectedKey={kind ?? 'all'} onSelectionChange={(value) => setKind(value === 'all' || value === null ? null : value as ItemKind)}><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><ListBox>{(['all', 'note', 'source', 'file'] as const).map((value) => <ListBox.Item key={value} id={value} textValue={value === 'all' ? 'All types' : KIND_LABELS[value]}>{value === 'all' ? 'All types' : KIND_LABELS[value]}</ListBox.Item>)}</ListBox></Select.Popover></Select>

                {loadState === 'loading' ? (
                  <div
                    aria-label="Searching the vault"
                    aria-live="polite"
                    className="grid gap-2 px-1 py-2"
                    role="status"
                  >
                    <span className="sr-only">Searching the vault...</span>
                    {Array.from({ length: 4 }, (_, index) => (
                      <div
                        key={index}
                        aria-hidden="true"
                        className="flex min-w-0 items-center gap-3 rounded-[calc(var(--radius)*2)] px-2 py-1.5"
                      >
                        <Skeleton className="size-8 shrink-0 rounded-(--radius)" />
                        <div className="grid min-w-0 flex-1 gap-2">
                          <Skeleton className="h-4 w-3/5" />
                          <Skeleton className="h-3 w-1/4" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {loadState === 'error' ? (
                  <div className="grid justify-items-start gap-2 px-1 py-2">
                    <Typography type="body-xs">Your search could not run. Try again.</Typography>
                    <Button variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
                      Try again
                    </Button>
                  </div>
                ) : null}

                {loadState === 'ready' && items.length === 0 ? (
                  <div className="grid gap-1 px-1 py-2">
                    <Typography type="body" weight="semibold">
                      No matches.
                    </Typography>
                    <Typography color="muted" type="body-xs">
                      Try a different word, tag, or collection name.
                    </Typography>
                  </div>
                ) : null}

                {loadState === 'ready' && visibleItems.length > 0 ? (
                  <ul aria-label="Search results" className="grid gap-1">
                    {visibleItems.map((item) => (
                      <li key={item.id} className="min-w-0">
                        <button
                          className="flex w-full min-w-0 items-center gap-3 rounded-[calc(var(--radius)*2)] px-2 py-1.5 text-left hover:bg-(--default) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          type="button"
                          onClick={() => openItem(item.id)}
                        >
                          <HugeiconsIcon
                            aria-hidden="true"
                            className="shrink-0 text-muted"
                            icon={KIND_ICONS[item.kind]}
                            size={16}
                            strokeWidth={1.75}
                          />
                          <span className="min-w-0 flex-1"><Typography className="block truncate" type="body">{item.title}</Typography>{item.matchSnippet ? <span className="block truncate text-xs text-muted">{item.matchSnippet.split(new RegExp(`(${trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, index) => part.toLowerCase() === trimmedQuery.toLowerCase() ? <mark key={index}>{part}</mark> : part)}</span> : null}</span>
                          <Typography color="muted" type="body-xs">
                            {KIND_LABELS[item.kind]}
                          </Typography>
                        </button>
                      </li>
                    ))}
                    {hasMore ? (
                      <li className="px-2 py-1">
                        <Typography color="muted" type="body-xs">
                          Showing first {RESULT_LIMIT} of {items.length} matches.
                        </Typography>
                      </li>
                    ) : null}
                  </ul>
                ) : null}

                {semanticSearch ? (
                  <div className="grid gap-2 border-t border-default pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Typography type="body" weight="semibold">
                        Related on this device
                      </Typography>
                      <FilterMenu
                        kind={filterKind}
                        collectionId={filterCollection}
                        tag={filterTag}
                        favoritesOnly={filterFavorites}
                        collections={collections}
                        tags={tags}
                        onKindChange={setFilterKind}
                        onCollectionChange={setFilterCollection}
                        onTagChange={setFilterTag}
                        onFavoritesChange={setFilterFavorites}
                        onClear={clearRelatedFilters}
                      />
                    </div>
                    <Typography color="muted" type="body-xs">
                      Matches shared words. No text is generated.
                    </Typography>

                    {relatedState === 'loading' ? (
                      <div
                        aria-label="Finding related items"
                        className="grid gap-2 px-1 py-2"
                        role="status"
                      >
                        <span className="sr-only">Finding related items...</span>
                        {Array.from({ length: 2 }, (_, index) => (
                          <div
                            key={index}
                            aria-hidden="true"
                            className="flex min-w-0 items-center gap-3 rounded-[calc(var(--radius)*2)] px-2 py-1.5"
                          >
                            <Skeleton className="size-8 shrink-0 rounded-(--radius)" />
                            <Skeleton className="h-4 w-1/2" />
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {relatedState === 'error' ? (
                      <Typography className="px-1 py-1" type="body-xs">
                        The related search could not run.
                      </Typography>
                    ) : null}

                    {relatedState === 'ready' && related.length === 0 ? (
                      <Typography className="px-1 py-1" color="muted" type="body-xs">
                        No related items share these words.
                      </Typography>
                    ) : null}

                    {relatedState === 'ready' && visibleRelated.length > 0 ? (
                      <ul aria-label="Related items" className="grid gap-1">
                        {visibleRelated.map((result) => (
                          <li key={result.item.id} className="min-w-0">
                            <button
                              className="flex w-full min-w-0 items-center gap-3 rounded-[calc(var(--radius)*2)] px-2 py-1.5 text-left hover:bg-(--default) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                              type="button"
                              onClick={() => openItem(result.item.id)}
                            >
                              <HugeiconsIcon
                                aria-hidden="true"
                                className="shrink-0 text-muted"
                                icon={KIND_ICONS[result.item.kind]}
                                size={16}
                                strokeWidth={1.75}
                              />
                              <span className="min-w-0 flex-1">
                                <Typography className="block truncate" type="body">
                                  {result.item.title}
                                </Typography>
                                {result.matchedTerms.length > 0 ? (
                                  <span className="block truncate text-xs text-muted">
                                    {result.matchedTerms.join(', ')}
                                  </span>
                                ) : null}
                              </span>
                              <Typography color="muted" type="body-xs">
                                {KIND_LABELS[result.item.kind]}
                              </Typography>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <ItemDetailsDialog
        itemId={openItemId}
        onChanged={() => setAttempt((value) => value + 1)}
        onClose={() => setOpenItemId(null)}
      />
    </div>
  )
}

export default NavbarSearch
