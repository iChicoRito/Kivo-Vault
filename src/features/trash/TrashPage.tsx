import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Tabs,
  TextField,
  Typography,
} from '@heroui/react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  Delete02Icon,
  DeletePutBackIcon,
  FolderOpenIcon,
  InformationCircleIcon,
  Link02Icon,
  NoteEditIcon,
} from '@hugeicons/core-free-icons'

import PageHeader from '../../app/PageHeader'
import { ConfirmDialog } from '../../components/items/dialogs'
import { ItemTable, ItemTableSkeleton } from '../../components/items/ItemTable'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import { formatSize } from '../../components/items/fileSize'
import {
  deleteItemsPermanently,
  listItems,
  restoreItems,
  type ItemKind,
  type ItemSummary,
} from '../../data/items'
import { notifyError, notifySuccess } from '../../lib/feedback'
import { useVaultChanged } from '../../lib/useVaultChanged'

type LoadState = 'loading' | 'ready' | 'error'
type KindFilter = 'all' | ItemKind

const PAGE_SIZE = 50

const KIND_TABS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'note', label: 'Notes' },
  { id: 'source', label: 'Sources' },
  { id: 'file', label: 'Files' },
]

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function trashedAt(item: ItemSummary) {
  return item.deletedAt ?? item.updatedAt
}

export function TrashPage() {
  const [items, setItems] = useState<ItemSummary[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)
  const [kind, setKind] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  // One id from a row menu, or many from the selection bar.
  const [deleteTarget, setDeleteTarget] = useState<string[] | null>(null)
  const selection = useSelection()
  const [emptyOpen, setEmptyOpen] = useState(false)

  useVaultChanged(() => setAttempt((value) => value + 1))

  useEffect(() => {
    let active = true
    setLoadState((state) => (state === 'ready' ? state : 'loading'))

    listItems({ trashed: true })
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
  }, [attempt])

  // A new filter starts from the first page.
  useEffect(() => setPage(1), [kind, query])

  function reload() {
    setAttempt((value) => value + 1)
  }

  async function runAction(
    action: () => Promise<void>,
    successMessage: string,
    failureMessage: string,
  ) {
    try {
      await action()
      notifySuccess(successMessage)
    } catch {
      notifyError(failureMessage)
    }
  }

  async function handleRestore(id: string) {
    await runAction(
      async () => {
        await restoreItems([id])
        reload()
      },
      'Restored from Trash',
      'Kivo could not restore this item. Try again.',
    )
  }

  async function restoreSelected(ids: string[]) {
    await runAction(
      async () => {
        await restoreItems(ids)
        selection.clear()
        reload()
      },
      `${ids.length} ${ids.length === 1 ? 'item' : 'items'} restored`,
      'Kivo could not restore these items. Try again.',
    )
  }

  async function handleDeletePermanently() {
    if (deleteTarget === null) return

    const ids = deleteTarget

    await runAction(
      async () => {
        await deleteItemsPermanently(ids)
        setDeleteTarget(null)
        selection.clear()
        reload()
      },
      'Deleted forever',
      'Kivo could not delete this item. Try again.',
    )
  }

  async function handleEmptyTrash() {
    const ids = items.map((item) => item.id)

    await runAction(
      async () => {
        await deleteItemsPermanently(ids)
        setEmptyOpen(false)
        reload()
      },
      'Trash emptied',
      'Kivo could not empty the Trash. Try again.',
    )
  }

  const countOf = (value: KindFilter) =>
    value === 'all' ? items.length : items.filter((item) => item.kind === value).length
  const fileBytes = items.reduce((sum, item) => sum + (item.file?.byteSize ?? 0), 0)
  const oldest = items.reduce<string | null>((min, item) => {
    const value = trashedAt(item)
    return min === null || value < min ? value : min
  }, null)
  const oldestDate = oldest ? new Date(oldest) : null

  const needle = query.trim().toLowerCase()
  const visible = items.filter(
    (item) =>
      (kind === 'all' || item.kind === kind) &&
      (!needle || item.title.toLowerCase().includes(needle)),
  )
  const pageItems = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const stats: Array<{ label: string; value: string; hint: string; icon: IconSvgElement }> = [
    {
      label: 'In Trash',
      value: String(items.length),
      hint:
        oldestDate && !Number.isNaN(oldestDate.getTime())
          ? `Oldest from ${dateFormat.format(oldestDate)}`
          : 'Nothing waiting',
      icon: Delete02Icon,
    },
    { label: 'Notes', value: String(countOf('note')), hint: 'Deleted notes', icon: NoteEditIcon },
    { label: 'Sources', value: String(countOf('source')), hint: 'Deleted links', icon: Link02Icon },
    {
      label: 'Files',
      value: String(countOf('file')),
      hint: `${formatSize(fileBytes)} still on disk`,
      icon: FolderOpenIcon,
    },
  ]

  return (
    <section aria-labelledby="trash-title" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          description="Review deleted items before permanent removal."
          title="Trash"
          titleId="trash-title"
        />
        <Button
          data-tour="trash"
          isDisabled={items.length === 0}
          variant="danger"
          onPress={() => setEmptyOpen(true)}
        >
          <HugeiconsIcon aria-hidden="true" icon={Delete02Icon} size={16} strokeWidth={1.75} />
          Empty Trash
        </Button>
      </div>

      {loadState === 'error' ? (
        <Alert aria-labelledby="trash-error-title" role="alert" status="danger">
          <Alert.Content className="grid gap-2">
            <h2 className="m-0 text-sm font-semibold" id="trash-error-title">
              Trash could not load
            </h2>
            <p className="m-0 text-sm">
              Kivo could not read items in trash. Try again to reload this list.
            </p>
            <Button className="justify-self-start" size="sm" variant="secondary" onPress={reload}>
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : (
        <>
          <Card className="overflow-hidden p-0">
            <ul className="m-0 grid list-none grid-cols-2 gap-px bg-separator p-0 lg:grid-cols-4">
              {stats.map((stat) => (
                <li key={stat.label} className="grid min-w-0 gap-1 bg-surface p-4">
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <HugeiconsIcon aria-hidden="true" icon={stat.icon} size={14} strokeWidth={1.75} />
                    {stat.label}
                  </span>
                  {loadState === 'loading' ? (
                    <>
                      <Skeleton animationType="shimmer" className="h-7 w-10 rounded-md" />
                      <Skeleton animationType="shimmer" className="h-3 w-24 rounded-md" />
                    </>
                  ) : (
                    <>
                      <span className="text-2xl font-semibold tracking-tight tabular-nums">
                        {stat.value}
                      </span>
                      <span className="truncate text-xs text-muted">{stat.hint}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          {loadState === 'ready' && items.length === 0 ? (
            <EmptyState className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center">
              <span
                aria-hidden="true"
                className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
              >
                <HugeiconsIcon icon={Delete02Icon} size={24} />
              </span>
              <div className="grid max-w-lg gap-2">
                <Typography align="center" type="h3">
                  Trash is empty.
                </Typography>
                <Typography align="center" color="muted" type="body">
                  Deleted notes, sources, and files wait here until you restore or remove them.
                </Typography>
              </div>
            </EmptyState>
          ) : (
          <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <TextField className="w-full max-w-sm" value={query} onChange={setQuery}>
              <Label>Search Trash</Label>
              <Input fullWidth placeholder="Search by title" variant="secondary" />
            </TextField>

            <Tabs
              className="w-fit"
              selectedKey={kind}
              onSelectionChange={(key) => setKind(key as KindFilter)}
            >
              <Tabs.ListContainer>
                <Tabs.List aria-label="Item type">
                  {KIND_TABS.map((tab) => (
                    <Tabs.Tab key={tab.id} id={tab.id}>
                      <span className="flex items-center gap-1.5">
                        {tab.label}
                        <span className="text-xs text-muted tabular-nums">{countOf(tab.id)}</span>
                      </span>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
          </div>

          <p className="m-0 flex items-center gap-2 text-xs text-muted">
            <HugeiconsIcon aria-hidden="true" icon={InformationCircleIcon} size={14} strokeWidth={1.75} />
            Items stay here until you restore or delete them. Right-click a row for options.
          </p>

          {loadState === 'loading' ? <ItemTableSkeleton label="Loading trash" /> : null}

          {loadState === 'ready' ? (
            <SelectionBar
              actionLabel="Delete permanently"
              secondaryAction={{
                label: 'Restore',
                icon: DeletePutBackIcon,
                onAction: (ids) => void restoreSelected(ids),
              }}
              selection={selection}
              visibleIds={visible.map((item) => item.id)}
              onAction={setDeleteTarget}
            />
          ) : null}

          {loadState === 'ready' ? (
            <ItemTable
              emptyMessage={items.length === 0 ? 'Trash is empty.' : 'No matching items in Trash.'}
              items={pageItems}
              page={page}
              pageSize={PAGE_SIZE}
              totalItems={visible.length}
              selection={selection}
              onDeletePermanently={(id) => setDeleteTarget([id])}
              onPageChange={setPage}
              onRestore={(id) => {
                void handleRestore(id)
              }}
            />
          ) : null}
          </>
          )}
        </>
      )}

      <ConfirmDialog
        confirmLabel="Delete permanently"
        description="This cannot be undone. The item and its managed file, when present, are removed from this device."
        open={deleteTarget !== null}
        title={
          deleteTarget && deleteTarget.length > 1
            ? `Permanently delete ${deleteTarget.length} items?`
            : 'Permanently delete this item?'
        }
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeletePermanently()}
      />

      <ConfirmDialog
        confirmLabel="Empty Trash"
        description="All items in Trash are permanently deleted. This cannot be undone. Managed files are removed from this device."
        open={emptyOpen}
        title="Empty Trash?"
        tone="danger"
        onCancel={() => setEmptyOpen(false)}
        onConfirm={() => void handleEmptyTrash()}
      />
    </section>
  )
}

export default TrashPage
