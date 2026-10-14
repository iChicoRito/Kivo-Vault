import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Chip,
  Dropdown,
  Input,
  Label,
  Modal,
  Skeleton,
  Switch,
  TextArea,
  TextField,
  Typography,
} from '@heroui/react'
import {
  ArrowDown01Icon,
  InformationCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import {
  CollectionSelect,
  TagPicker,
} from '../../components/items/dialogs'
import { openItemFile, revealItemFile } from '../../data/files'
import {
  loadItem,
  saveItem,
  setItemTags,
  type ItemInput,
  type ItemKind,
  type VaultItem,
} from '../../data/items'
import { notifyError, notifySuccess } from '../../lib/feedback'
import { FilePreviewDialog } from '../preview/FilePreviewDialog'
import { matchesShortcut } from '../../app/shortcuts'
import { indexFile, listIndexState, type IndexState } from '../../data/indexing'
import { DialogHeader } from '../../components/DialogHeader'

/** One fact in the details grid: a small label over its value. Dates render as `<time>`. */
function DetailCell({ label, value, isDate = false }: { label: string; value: string; isDate?: boolean }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 text-sm font-medium tabular-nums">
        {isDate ? <time dateTime={value}>{formatDate(value)}</time> : value}
      </dd>
    </div>
  )
}

type ItemDetailsDialogProps = {
  itemId: string | null
  onClose: () => void
  onChanged: () => void
}

type LoadState = 'loading' | 'ready' | 'error'

const KIND_LABELS: Record<ItemKind, string> = {
  note: 'Note',
  source: 'Source',
  file: 'File',
}

const SAVE_ERROR = 'Kivo could not save this change. Your saved details are unchanged.'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date)
}

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unitIndex]}`
}

function buildItemInput(item: VaultItem, patch: Partial<ItemInput>): ItemInput {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    description: item.description,
    content: item.content ?? undefined,
    url: item.url ?? undefined,
    collectionId: item.collectionId,
    isFavorite: item.isFavorite,
    isPinned: item.isPinned,
    ...patch,
  }
}

export function ItemDetailsDialog({ itemId, onClose, onChanged }: ItemDetailsDialogProps) {
  const [item, setItem] = useState<VaultItem | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [indexStatus, setIndexStatus] = useState<IndexState['status'] | null>(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [favorite, setFavorite] = useState(false)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])

  function applyFields(source: VaultItem) {
    setTitle(source.title)
    setDescription(source.description)
    setFavorite(source.isFavorite)
    setCollectionId(source.collectionId)
    setTags(source.tags)
  }

  useEffect(() => {
    if (!itemId) {
      setItem(null)
      setLoadState('loading')
      setSaveError(null)
      return
    }

    let active = true
    setLoadState('loading')
    setSaveError(null)

    loadItem(itemId)
      .then((loaded) => {
        if (!active) return
        setItem(loaded)
        applyFields(loaded)
        setLoadState('ready')
      })
      .catch(() => {
        if (active) setLoadState('error')
      })

    return () => {
      active = false
    }
  }, [itemId])

  useEffect(() => {
    if (!itemId || item?.kind !== 'file' || !item.file?.originalName.toLowerCase().endsWith('.pdf')) { setIndexStatus(null); return }
    let active = true
    listIndexState().then((states) => { if (active) setIndexStatus(states.find((state) => state.itemId === itemId)?.status ?? null) }).catch(() => { if (active) setIndexStatus(null) })
    return () => { active = false }
  }, [itemId, item])

  async function persist(patch: Partial<ItemInput>, syncForm = false): Promise<boolean> {
    if (!item) return false

    setSaveError(null)

    try {
      const saved = await saveItem(buildItemInput(item, patch))
      setItem(saved)
      if (syncForm) applyFields(saved)
      onChanged()
      return true
    } catch {
      setSaveError(SAVE_ERROR)
      notifyError(SAVE_ERROR)
      if (syncForm) applyFields(item)
      return false
    }
  }

  async function handleFavoriteChange(next: boolean) {
    const previous = favorite
    setFavorite(next)

    const saved = await persist({ isFavorite: next })
    if (!saved) setFavorite(previous)
  }

  useEffect(() => {
    if (!itemId || !item || loadState !== 'ready') return
    function onKey(event: KeyboardEvent) {
      if (!matchesShortcut(event, 'favorite')) return
      event.preventDefault()
      void handleFavoriteChange(!favorite)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [itemId, item, favorite, loadState])

  async function handleCollectionChange(next: string | null) {
    const previous = collectionId
    setCollectionId(next)

    const saved = await persist({ collectionId: next })
    if (!saved) setCollectionId(previous)
  }

  async function handleTagsChange(next: string[]) {
    if (!item) return

    const previous = tags
    setTags(next)
    setSaveError(null)

    try {
      const savedTags = await setItemTags(item.id, next)
      setTags(savedTags)
      onChanged()
    } catch {
      setTags(previous)
      setSaveError(SAVE_ERROR)
      notifyError(SAVE_ERROR)
    }
  }

  async function handleSaveDetails() {
    const trimmedTitle = title.trim()

    if (!trimmedTitle) {
      setSaveError('A title is required.')
      return
    }

    const saved = await persist({ title: trimmedTitle, description }, true)
    if (saved) notifySuccess('Item saved')
  }

  function handleOpenFile() {
    if (!item) return

    void openItemFile(item.id).catch(() => {
      const message = 'Kivo could not open this file.'
      setSaveError(message)
      notifyError(message)
    })
  }

  function handleRevealFile() {
    if (!item) return

    void revealItemFile(item.id).catch(() => {
      const message = 'Kivo could not reveal this file.'
      setSaveError(message)
      notifyError(message)
    })
  }

  return (
    <Modal
      isOpen={itemId !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl">
            <DialogHeader
              description="Everything Kivo knows about this item."
              icon={InformationCircleIcon}
              title="Item details"
            />

            <Modal.Body>
              {loadState === 'loading' ? (
                <div
                  aria-label="Loading item details"
                  className="grid gap-3"
                  role="status"
                >
                  <span className="sr-only">Loading item details</span>
                  <div aria-hidden="true" className="grid gap-2">
                    <Skeleton className="h-4 w-12" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                  <div aria-hidden="true" className="grid gap-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-24 w-full" />
                  </div>
                  <Skeleton aria-hidden="true" className="h-9 w-28" />
                  <div aria-hidden="true" className="flex items-center gap-3">
                    <Skeleton className="h-5 w-9 rounded-full" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                  <div aria-hidden="true" className="grid gap-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                  <div aria-hidden="true" className="grid gap-2">
                    <Skeleton className="h-4 w-8" />
                    {[0, 1].map((index) => (
                      <div key={index} className="flex items-center gap-2 px-2 py-1">
                        <Skeleton className="size-4 shrink-0 rounded-sm" />
                        <Skeleton className={index === 0 ? 'h-4 w-24' : 'h-4 w-20'} />
                      </div>
                    ))}
                  </div>
                  <dl aria-hidden="true" className="grid gap-1">
                    {[0, 1].map((index) => (
                      <div key={index} className="flex items-center justify-between gap-2">
                        <Skeleton className="h-4 w-16" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    ))}
                  </dl>
                </div>
              ) : null}

              {loadState === 'error' ? (
                <Alert role="alert" status="danger">
                  <Alert.Content className="grid gap-2">
                    <Typography type="h2">This item could not load</Typography>
                    <Typography type="body">
                      Kivo could not read this item. Close this panel and try again.
                    </Typography>
                  </Alert.Content>
                </Alert>
              ) : null}

              {loadState === 'ready' && item ? (
                <div className="grid gap-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" variant="soft">
                      {KIND_LABELS[item.kind]}
                    </Chip>
                    {item.isPinned ? (
                      <Chip color="accent" size="sm" variant="soft">
                        Pinned
                      </Chip>
                    ) : null}
                  </div>

                  <div className="grid gap-4">
                    <TextField value={title} onChange={setTitle}>
                      <Label>Title</Label>
                      <Input fullWidth variant="secondary" />
                    </TextField>

                    <TextField value={description} onChange={setDescription}>
                      <Label>Description</Label>
                      <TextArea fullWidth variant="secondary" />
                    </TextField>
                  </div>

                  {saveError ? (
                    <Typography className="font-semibold text-danger" role="alert" type="body">
                      {saveError}
                    </Typography>
                  ) : null}

                  <Switch isSelected={favorite} onChange={(next) => void handleFavoriteChange(next)}>
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      Favorite
                    </Switch.Content>
                  </Switch>

                  <CollectionSelect
                    label="Collection"
                    value={collectionId}
                    onChange={(next) => void handleCollectionChange(next)}
                  />

                  <TagPicker
                    label="Tags"
                    value={tags}
                    itemId={item.id}
                    onChange={(next) => void handleTagsChange(next)}
                  />

                  {/* One box: the file and its actions on top, the facts in a grid below. */}
                  <section aria-label="Details" className="grid gap-4 rounded-2xl border border-default p-4">
                    {item.kind === 'file' ? (
                      <div className="grid gap-3 border-b border-default pb-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {item.file ? (
                            <dl className="m-0 grid min-w-0 flex-1 gap-0.5">
                              <dt className="text-xs text-muted">Original name</dt>
                              <dd className="m-0 truncate text-sm font-medium" title={item.file.originalName}>
                                {item.file.originalName}
                              </dd>
                            </dl>
                          ) : null}
                          <Dropdown>
                            <Button isDisabled={item.fileMissing} size="sm" variant="secondary">
                              File actions
                              <HugeiconsIcon aria-hidden="true" icon={ArrowDown01Icon} size={16} />
                            </Button>
                            <Dropdown.Popover>
                              <Dropdown.Menu
                                onAction={(key) => {
                                  if (key === 'preview') setPreviewOpen(true)
                                  else if (key === 'open') void handleOpenFile()
                                  else if (key === 'reveal') void handleRevealFile()
                                }}
                              >
                                <Dropdown.Item id="preview" textValue="Preview">
                                  <Label>Preview</Label>
                                </Dropdown.Item>
                                <Dropdown.Item id="open" textValue="Open">
                                  <Label>Open</Label>
                                </Dropdown.Item>
                                <Dropdown.Item id="reveal" textValue="Reveal">
                                  <Label>Reveal</Label>
                                </Dropdown.Item>
                              </Dropdown.Menu>
                            </Dropdown.Popover>
                          </Dropdown>
                        </div>

                        {item.fileMissing ? (
                          <Typography className="font-semibold text-danger" role="alert" type="body-sm">
                            This file is missing from the vault folder.
                          </Typography>
                        ) : null}
                        {indexStatus === 'no_text' ? <Typography color="muted" type="body-xs">No searchable text in this PDF</Typography> : null}
                        {indexStatus === 'pending' ? <Typography color="muted" type="body-xs">Indexing PDF text...</Typography> : null}
                        {indexStatus === 'failed' ? <Button className="justify-self-start" size="sm" variant="secondary" onPress={() => { void indexFile(item.id).then((state) => setIndexStatus(state.status)).catch(() => notifyError('Could not retry PDF indexing.')) }}>Retry PDF indexing</Button> : null}
                      </div>
                    ) : null}

                    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3">
                      {item.file ? (
                        <>
                          <DetailCell label="Size" value={formatByteSize(item.file.byteSize)} />
                          <DetailCell label="Imported" value={item.file.importedAt} isDate />
                        </>
                      ) : null}
                      <DetailCell label="Created" value={item.createdAt} isDate />
                      <DetailCell label="Updated" value={item.updatedAt} isDate />
                    </dl>
                  </section>
                </div>
              ) : null}
            </Modal.Body>

            <Modal.Footer>
              <Button variant="secondary" onPress={onClose}>
                Close
              </Button>
              {loadState === 'ready' && item ? (
                <Button isDisabled={!title.trim()} onPress={() => void handleSaveDetails()}>
                  Save changes
                </Button>
              ) : null}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <FilePreviewDialog itemId={previewOpen ? item?.id ?? null : null} onClose={() => setPreviewOpen(false)} />
    </Modal>
  )
}

export default ItemDetailsDialog
