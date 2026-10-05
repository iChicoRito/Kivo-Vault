import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Alert,
  Button,
  Chip,
  EmptyState,
  FieldError,
  Input,
  Label,
  Modal,
  Skeleton,
  TextField,
  Typography,
} from '@heroui/react'
import {
  Delete02Icon,
  EyeIcon,
  FileAddIcon,
  FolderOpenIcon,
  FolderTransferIcon,
  NoteEditIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import PageHeader from '../../app/PageHeader'
import { CollectionSelect, ConfirmDialog } from '../../components/items/dialogs'
import { FileTypeIcon } from '../../components/items/FileTypeIcon'
import { ItemCard, type ItemCardAction } from '../../components/items/ItemCard'
import { FilterMenu } from '../../components/items/FilterMenu'
import { useLibraryFilters } from '../../components/items/useLibraryFilters'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import { ListScrollArea } from '../../components/items/ListScrollArea'
import { formatSize } from '../../components/items/fileSize'
import {
  listItems,
  loadItem,
  moveItemsToCollection,
  saveItem,
  type ItemSummary,
} from '../../data/items'
import { openItemFile, pickFiles, revealItemFile } from '../../data/files'
import { notifyError, notifySuccess, trashManyWithUndo, trashWithUndo } from '../../lib/feedback'
import { CollectionFolderPanel } from '../collections/CollectionFolderPanel'
import { startItemDrag } from '../collections/itemDrag'
import { DialogHeader } from '../../components/DialogHeader'
import { describeImport, useFileImport } from './useFileImport'

type LoadState = 'loading' | 'ready' | 'error'

const stateLabelClass = 'uppercase'

const IMPORT_ERROR = 'Kivo could not import one or more files. Try again.'
const OPEN_ERROR = 'Kivo could not open this file. It may be missing from this device.'
const REVEAL_ERROR = 'Kivo could not reveal this file. It may be missing from this device.'
const RENAME_ERROR = 'Kivo could not rename this file. Try again.'
const MOVE_ERROR = 'Kivo could not move this file. Try again.'

type RenameState = { id: string; title: string } | null
type MoveState = { id: string; collectionId: string | null } | null

function FilesLoadingSkeleton() {
  return (
    <ul aria-hidden="true" className="grid gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <li key={index} className="min-w-0">
          <div className="kivo-item-card relative rounded-3xl border border-default bg-surface">
            <div className="flex items-center gap-3 rounded-3xl p-3">
              <Skeleton className="size-11 shrink-0 rounded-xl" />
              <span className="grid min-w-0 flex-1 gap-1">
                <Skeleton className="h-4 w-2/3 rounded-md" />
                <Skeleton className="h-3 w-16 rounded-md" />
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function FilesPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [collectionLocked, setCollectionLocked] = useState(false)
  const [files, setFiles] = useState<ItemSummary[]>([])
  const { importPaths, dialog: importDialog } = useFileImport()

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [renameTarget, setRenameTarget] = useState<RenameState>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<MoveState>(null)
  const [trashTarget, setTrashTarget] = useState<string | null>(null)

  const { filter, menuProps, hasActiveFilters, refreshVersion, reload } = useLibraryFilters('file')
  const selection = useSelection()

  useEffect(() => {
    let active = true
    setLoadState('loading')
    setCollectionLocked(false)
    selection.clear()

    listItems(filter)
      .then((loaded) => {
        if (!active) return
        setFiles(loaded)
        setLoadState('ready')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setCollectionLocked(String(reason).includes('This collection is locked'))
        setLoadState('error')
      })

    return () => {
      active = false
    }
  }, [filter, refreshVersion])

  async function handleImport() {
    setActionError(null)

    let paths: string[] | null

    try {
      paths = await pickFiles()
    } catch {
      notifyError(IMPORT_ERROR)
      return
    }

    if (!paths || paths.length === 0) return

    setBusy(true)

    try {
      const summary = await importPaths(paths)

      reload()

      if (summary.failed > 0) notifyError(IMPORT_ERROR)
      else if (summary.imported === 1 && summary.skipped === 0) notifySuccess('File imported')
      else if (summary.imported + summary.skipped > 0) notifySuccess(describeImport(summary))
    } finally {
      setBusy(false)
    }
  }

  async function handleOpen(id: string) {
    setActionError(null)

    try {
      await openItemFile(id)
    } catch {
      setActionError(OPEN_ERROR)
    }
  }

  async function handleReveal(id: string) {
    setActionError(null)

    try {
      await revealItemFile(id)
    } catch {
      setActionError(REVEAL_ERROR)
    }
  }

  function handleFileAction(file: ItemSummary, key: string) {
    if (key === 'open') void handleOpen(file.id)
    else if (key === 'reveal') void handleReveal(file.id)
    else if (key === 'rename') openRename(file)
    else if (key === 'move') {
      setMoveTarget({ id: file.id, collectionId: file.collectionId })
    } else if (key === 'trash') setTrashTarget(file.id)
  }

  function openRename(file: ItemSummary) {
    setRenameError(null)
    setRenameTarget({ id: file.id, title: file.title })
  }

  async function handleRename() {
    if (!renameTarget) return

    const title = renameTarget.title.trim()

    if (!title) {
      setRenameError('File title is required.')
      return
    }

    setRenameError(null)

    try {
      const loaded = await loadItem(renameTarget.id)

      await saveItem({
        id: loaded.id,
        kind: loaded.kind,
        title,
        description: loaded.description,
        collectionId: loaded.collectionId,
        isFavorite: loaded.isFavorite,
        isPinned: loaded.isPinned,
      })

      setRenameTarget(null)
      reload()
    } catch {
      setRenameError(RENAME_ERROR)
      notifyError(RENAME_ERROR)
    }
  }

  async function handleMove() {
    if (!moveTarget) return

    try {
      await moveItemsToCollection([moveTarget.id], moveTarget.collectionId)
      setMoveTarget(null)
      reload()
      notifySuccess('File moved to collection')
    } catch {
      notifyError(MOVE_ERROR)
    }
  }

  async function trashSelected(ids: string[]) {
    const moved = await trashManyWithUndo(ids)
    if (!moved) return
    reload()
    selection.clear()
  }

  async function handleTrash() {
    if (!trashTarget) return

    const id = trashTarget
    setTrashTarget(null)
    setActionError(null)

    const moved = await trashWithUndo({ ids: [id], label: 'File' })

    if (moved) reload()
  }

  const heading = (
    <PageHeader
      description="Keep local files within reach."
      title="Files"
      titleId="files-title"
    />
  )

  return (
    <section aria-labelledby="files-title" className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        {heading}
        {loadState === 'ready' ? (
          <Button data-tour="files" isDisabled={busy} onPress={() => void handleImport()}>
            Import files
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FilterMenu {...menuProps} />
      </div>

      {loadState === 'error' ? (
        <Alert aria-labelledby="files-error-title" role="alert" status="danger">
          <Alert.Content className="grid gap-3">
            <Typography className={stateLabelClass} color="muted" type="body-xs" weight="bold">
              ERROR
            </Typography>
            <Typography id="files-error-title" type="h2">
              {collectionLocked ? 'This collection is locked' : 'Your files could not load'}
            </Typography>
            <Typography type="body">
              {collectionLocked
                ? 'Open this collection from Collections, then try again.'
                : 'Kivo could not read saved file records. Try again to reload this list.'}
            </Typography>
            {collectionLocked ? (
              <Link className="underline" to="/collections">Open Collections</Link>
            ) : null}
            <Button
              className="justify-self-start"
              variant="secondary"
              onPress={reload}
            >
              Try again
            </Button>
            {hasActiveFilters ? (
              <Button className="justify-self-start" variant="secondary" onPress={menuProps.onClear}>
                Clear filters
              </Button>
            ) : null}
          </Alert.Content>
        </Alert>
      ) : null}

      {loadState === 'ready' && actionError ? (
        <Typography className="font-semibold text-danger" role="alert" type="body">
          {actionError}
        </Typography>
      ) : null}

      {loadState === 'ready' && files.length === 0 && !hasActiveFilters ? (
        <EmptyState className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={FileAddIcon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            <Typography align="center" type="h3">
              No files yet.
            </Typography>
            <Typography align="center" color="muted" type="body">
              Files added to this device will appear here.
            </Typography>
          </div>
          <Button isDisabled={busy} onPress={() => void handleImport()}>
            <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
            Import Files
          </Button>
        </EmptyState>
      ) : null}

      {loadState === 'ready' && files.length === 0 && hasActiveFilters ? (
        <EmptyState className="grid justify-items-start gap-3">
          <Typography type="h2">No files match your filters.</Typography>
          <Typography color="muted" type="body">
            Choose different filters, or clear them to see more files.
          </Typography>
          <Button variant="secondary" onPress={menuProps.onClear}>Clear filters</Button>
        </EmptyState>
      ) : null}

      {loadState === 'loading' || (loadState === 'ready' && files.length > 0) ? (
        <div className="flex gap-4">
          <CollectionFolderPanel />
          <div className="min-w-0 flex-1">
            {loadState === 'loading' ? (
              <div aria-live="polite" className="grid gap-4" role="status">
                <Typography className="sr-only">
                  Loading your files. Kivo is reading file records for this vault.
                </Typography>
                <ListScrollArea>
                  <FilesLoadingSkeleton />
                </ListScrollArea>
              </div>
            ) : (
              <>
              <div className="mb-3 empty:hidden">
                <SelectionBar
                  actionLabel="Move to Trash"
                  confirmTrash
                  selection={selection}
                  visibleIds={files.map((entry) => entry.id)}
                  onAction={(ids) => void trashSelected(ids)}
                />
              </div>
              <ListScrollArea>
                <ul className="grid gap-2">
                  {files.map((file) => {
                    const actions: ItemCardAction[] = [
                      { id: 'open', label: 'Open', icon: EyeIcon, isDisabled: file.fileMissing },
                      {
                        id: 'reveal',
                        label: 'Reveal',
                        icon: FolderOpenIcon,
                        isDisabled: file.fileMissing,
                      },
                      { id: 'rename', label: 'Rename', icon: NoteEditIcon },
                      { id: 'move', label: 'Move to collection', icon: FolderOpenIcon },
                      { id: 'trash', label: 'Move to trash', icon: Delete02Icon, danger: true },
                    ]

                    return (
                      <li
                        key={file.id}
                        data-item-drag-id={file.id}
                        className="min-w-0 select-none"
                        onPointerDown={(event) =>
                          startItemDrag(
                            event,
                            selection.isSelected(file.id)
                              ? selection.selectedIn(files.map((entry) => entry.id))
                              : [file.id],
                          )
                        }
                      >
                        <ItemCard
                          actions={actions}
                          isSelected={selection.isSelected(file.id)}
                          isSelecting={selection.isActive}
                          onSelect={() => selection.pick(file.id)}
                          chips={
                            file.fileMissing ? (
                              <Chip color="danger" size="sm" variant="soft">
                                File is missing
                              </Chip>
                            ) : undefined
                          }
                          isOpenDisabled={file.fileMissing}
                          leading={
                            <span className="grid size-11 place-items-center rounded-xl bg-default">
                              <FileTypeIcon name={file.file?.originalName ?? file.title} size={22} />
                            </span>
                          }
                          subtitle={
                            <Typography color="muted" type="body-xs">
                              {formatSize(file.file?.byteSize)}
                            </Typography>
                          }
                          title={file.title}
                          onAction={(key) => handleFileAction(file, key)}
                          onOpen={() => {
                            void handleOpen(file.id)
                          }}
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

      {loadState === 'ready' ? (
        <>
      <Modal
        isOpen={renameTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRenameTarget(null)
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <DialogHeader
                description="Only the name in Kivo changes. The file itself stays the same."
                icon={PencilEdit02Icon}
                title="Rename file"
              />
              <Modal.Body>
                <TextField
                  isInvalid={renameError !== null}
                  value={renameTarget?.title ?? ''}
                  onChange={(value) =>
                    setRenameTarget((current) => (current ? { ...current, title: value } : current))
                  }
                >
                  <Label>File title</Label>
                  <Input fullWidth variant="secondary" />
                  {renameError ? <FieldError>{renameError}</FieldError> : null}
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setRenameTarget(null)}>
                  Cancel
                </Button>
                <Button onPress={() => void handleRename()}>Save name</Button>
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
              <DialogHeader
                description="Pick where this file should live."
                icon={FolderTransferIcon}
                title="Move file to collection"
              />
              <Modal.Body>
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
        description="This file leaves your library and stays in Trash. The stored file is not deleted."
        open={trashTarget !== null}
        title="Move this file to Trash?"
        tone="danger"
        onCancel={() => setTrashTarget(null)}
        onConfirm={() => void handleTrash()}
      />
        </>
      ) : null}
      {importDialog}
    </section>
  )
}
