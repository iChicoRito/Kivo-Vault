import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Dropdown, Label, Skeleton, Tooltip } from '@heroui/react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  Database01Icon,
  Delete02Icon,
  EyeIcon,
  File01Icon,
  FolderOpenIcon,
  HardDriveIcon,
  Image01Icon,
  Pdf01Icon,
  TextIcon,
} from '@hugeicons/core-free-icons'

import PageHeader from '../../app/PageHeader'
import { MonoRoundedDonutChart } from '../../components/charts/MonoRoundedDonutChart'
import { ConfirmDialog } from '../../components/items/dialogs'
import { FileTypeIcon } from '../../components/items/FileTypeIcon'
import { formatSize } from '../../components/items/fileSize'
import { Panel } from '../../components/ui/Panel'
import { loadStorageReport, type StorageReport } from '../../data/storage'
import { openItemFile, revealItemFile } from '../../data/files'
import { trashItems } from '../../data/items'
import { notifyError } from '../../lib/feedback'
import { ItemDetailsDialog } from '../items/ItemDetailsDialog'

// Same accent steps as the dashboard charts, biggest share first.
const SHADES = ['bg-accent', 'bg-accent/70', 'bg-accent/45', 'bg-accent/25', 'bg-accent/15']

const GROUP_ICONS: Record<string, IconSvgElement> = {
  Images: Image01Icon,
  PDFs: Pdf01Icon,
  Text: TextIcon,
  Other: File01Icon,
  Database: Database01Icon,
}

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date)
}

function percentOf(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

export function StorageManagerPage() {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [trashId, setTrashId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ itemId: string; x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLSpanElement>(null)

  function handleMenuAction(key: string) {
    const itemId = menu?.itemId
    setMenu(null)
    if (!itemId) return

    if (key === 'details') setOpenId(itemId)
    else if (key === 'open')
      void openItemFile(itemId).catch(() => notifyError('Kivo could not open this file. Try again.'))
    else if (key === 'reveal')
      void revealItemFile(itemId).catch(() => notifyError('Kivo could not show this file. Try again.'))
    else if (key === 'trash') setTrashId(itemId)
  }

  useEffect(() => {
    let active = true
    setError(false)
    loadStorageReport()
      .then((value) => {
        if (active) setReport(value)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [attempt])

  async function trash() {
    if (!trashId) return
    try {
      await trashItems([trashId])
      setTrashId(null)
      setAttempt((value) => value + 1)
    } catch {
      setError(true)
      setTrashId(null)
    }
  }

  const loading = !report && !error

  // Database plus each file group, largest first, so the bar and the rows share one order.
  const usage = report
    ? [
        ...report.groups.map((group) => ({ ...group })),
        { label: 'Database', count: null as number | null, bytes: report.databaseBytes },
      ]
        .filter((entry) => entry.bytes > 0 || entry.count)
        .sort((a, b) => b.bytes - a.bytes)
    : []
  const largestBytes = report?.largest[0]?.byteSize ?? 0
  const largestTotal = report?.largest.reduce((sum, file) => sum + file.byteSize, 0) ?? 0

  const stats = report
    ? [
        {
          label: 'Total use',
          value: formatSize(report.totalBytes),
          hint: 'Database and managed files',
          icon: HardDriveIcon,
        },
        {
          label: 'Database',
          value: formatSize(report.databaseBytes),
          hint: `${percentOf(report.databaseBytes, report.totalBytes)}% of total`,
          icon: Database01Icon,
        },
        {
          label: 'Managed files',
          value: formatSize(report.fileBytes),
          hint: `${percentOf(report.fileBytes, report.totalBytes)}% of total`,
          icon: File01Icon,
        },
        {
          label: 'Files',
          value: String(report.fileCount),
          hint: report.fileCount === 1 ? 'file in the vault' : 'files in the vault',
          icon: Image01Icon,
        },
      ]
    : []

  return (
    <section aria-labelledby="storage-title" className="grid gap-4">
      <PageHeader
        description="See how much space your local vault uses."
        title="Storage Manager"
        titleId="storage-title"
      />

      {loading ? (
        <p className="sr-only" role="status">
          Loading storage report...
        </p>
      ) : null}

      {error ? (
        <Alert role="alert" status="danger">
          <Alert.Content className="grid gap-2">
            <p className="m-0 text-sm font-semibold">Storage report could not load.</p>
            <Button
              className="justify-self-start"
              size="sm"
              variant="secondary"
              onPress={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {loading || report ? (
        <>
          <Card className="overflow-hidden p-0">
            <ul className="m-0 grid list-none grid-cols-2 gap-px bg-separator p-0 lg:grid-cols-4">
              {loading
                ? Array.from({ length: 4 }, (_, index) => (
                    <li key={index} aria-hidden="true" className="grid gap-2 bg-surface p-4">
                      <Skeleton animationType="shimmer" className="h-3 w-16 rounded-md" />
                      <Skeleton animationType="shimmer" className="h-7 w-14 rounded-md" />
                      <Skeleton animationType="shimmer" className="h-3 w-24 rounded-md" />
                    </li>
                  ))
                : stats.map((stat) => (
                    <li key={stat.label} className="grid min-w-0 gap-1 bg-surface p-4">
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <HugeiconsIcon aria-hidden="true" icon={stat.icon} size={14} strokeWidth={1.75} />
                        {stat.label}
                      </span>
                      <span className="text-2xl font-semibold tracking-tight tabular-nums">
                        {stat.value}
                      </span>
                      <span className="truncate text-xs text-muted">{stat.hint}</span>
                    </li>
                  ))}
            </ul>
          </Card>

          <div className="grid gap-3 lg:grid-cols-12">
            <Panel className="lg:col-span-8" id="storage-usage" title="Space by type">
              {report ? (
                <>
                  <div
                    aria-label={usage
                      .map((entry) => `${entry.label} ${formatSize(entry.bytes)}`)
                      .join(', ')}
                    className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-default"
                    role="img"
                  >
                    {usage.map((entry, index) =>
                      entry.bytes > 0 ? (
                        <span
                          key={entry.label}
                          className={`h-full first:rounded-l-full last:rounded-r-full ${SHADES[index % SHADES.length]}`}
                          style={{ width: `${(entry.bytes / Math.max(report.totalBytes, 1)) * 100}%` }}
                        />
                      ) : null,
                    )}
                  </div>

                  <ul className="m-0 grid list-none divide-y divide-separator p-0">
                    {usage.map((entry, index) => (
                      <li key={entry.label} className="flex items-center gap-3 py-2.5">
                        <span className={`size-2.5 shrink-0 rounded-full ${SHADES[index % SHADES.length]}`} />
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-default">
                          <HugeiconsIcon
                            aria-hidden="true"
                            className="text-muted"
                            icon={GROUP_ICONS[entry.label] ?? File01Icon}
                            size={14}
                            strokeWidth={1.75}
                          />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{entry.label}</span>
                        <span className="text-xs text-muted tabular-nums">
                          {entry.count === null
                            ? 'Notes, sources, settings'
                            : `${entry.count} ${entry.count === 1 ? 'file' : 'files'}`}
                        </span>
                        <span className="w-16 text-right text-sm font-semibold tabular-nums">
                          {formatSize(entry.bytes)}
                        </span>
                        <span className="w-10 text-right text-xs text-muted tabular-nums">
                          {percentOf(entry.bytes, report.totalBytes)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div aria-hidden="true" className="grid gap-3">
                  <Skeleton animationType="shimmer" className="h-3 rounded-full" />
                  {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} animationType="shimmer" className="h-7 rounded-md" />
                  ))}
                </div>
              )}
            </Panel>

            <Panel className="lg:col-span-4" id="storage-kinds" title="Files by type">
              {report ? (
                report.fileCount === 0 ? (
                  <p className="m-0 py-6 text-center text-sm text-muted">No files yet.</p>
                ) : (
                  <MonoRoundedDonutChart
                    data={report.groups.map((group) => ({ name: group.label, value: group.count }))}
                    label={report.groups.map((group) => `${group.label} ${group.count}`).join(', ')}
                  />
                )
              ) : (
                <Skeleton aria-hidden="true" animationType="shimmer" className="h-44 rounded-[14px]" />
              )}
            </Panel>

            <Panel
              className="lg:col-span-12"
              id="storage-largest"
              meta={
                report && report.largest.length > 0 ? (
                  <span className="text-xs text-muted tabular-nums">
                    Top {report.largest.length} · {formatSize(largestTotal)} ·{' '}
                    {percentOf(largestTotal, report.fileBytes)}% of file space
                  </span>
                ) : null
              }
              title="Largest files"
            >
              {!report ? (
                <div aria-hidden="true" className="grid gap-2">
                  {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} animationType="shimmer" className="h-14 rounded-xl" />
                  ))}
                </div>
              ) : report.largest.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-default px-6 py-10 text-center">
                  <span
                    aria-hidden="true"
                    className="flex size-12 items-center justify-center rounded-full bg-background-tertiary text-muted"
                  >
                    <HugeiconsIcon icon={File01Icon} size={22} />
                  </span>
                  <p className="m-0 text-sm text-muted">
                    No managed files yet. Add a file to see it here.
                  </p>
                </div>
              ) : (
                <div ref={listRef} className="relative grid gap-1">
                  {/* Column labels line up with the row cells from the small breakpoint up. */}
                  <div
                    aria-hidden="true"
                    className="hidden grid-cols-[1.75rem_minmax(0,1fr)_10rem_4.5rem_2rem] items-center gap-3 px-2 pb-1 text-xs text-muted sm:grid"
                  >
                    <span className="text-center">#</span>
                    <span>File</span>
                    <span>Share of files</span>
                    <span className="text-right">Size</span>
                    <span />
                  </div>
                  <ul className="m-0 grid list-none divide-y divide-separator p-0">
                    {report.largest.map((file, index) => {
                      const share = percentOf(file.byteSize, report.fileBytes)
                      const extension = file.originalName.includes('.')
                        ? file.originalName.split('.').pop()?.toUpperCase()
                        : null

                      return (
                        <li
                          key={file.itemId}
                          onContextMenu={(event) => {
                            event.preventDefault()

                            const bounds = listRef.current?.getBoundingClientRect()
                            setMenu({
                              itemId: file.itemId,
                              x: event.clientX - (bounds?.left ?? 0),
                              y: event.clientY - (bounds?.top ?? 0),
                            })
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

                            event.preventDefault()

                            const row = event.currentTarget.getBoundingClientRect()
                            const bounds = listRef.current?.getBoundingClientRect()
                            setMenu({
                              itemId: file.itemId,
                              x: row.left - (bounds?.left ?? 0) + 16,
                              y: row.top - (bounds?.top ?? 0) + 16,
                            })
                          }}
                          className="group grid grid-cols-[1.75rem_minmax(0,1fr)_4.5rem_2rem] items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-default sm:grid-cols-[1.75rem_minmax(0,1fr)_10rem_4.5rem_2rem]"
                        >
                          <span className="text-center text-xs font-semibold text-muted tabular-nums">
                            {index + 1}
                          </span>
                          <button
                            className={`flex min-w-0 items-center gap-3 rounded-md text-left ${focusRing}`}
                            type="button"
                            onClick={() => setOpenId(file.itemId)}
                          >
                            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-default transition-colors group-hover:bg-surface">
                              <FileTypeIcon name={file.originalName} size={22} />
                            </span>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="truncate text-sm font-medium">{file.title}</span>
                              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                                {extension ? (
                                  <span className="shrink-0 rounded-md bg-default px-1.5 py-px text-[0.625rem] font-semibold tracking-wide transition-colors group-hover:bg-surface">
                                    {extension}
                                  </span>
                                ) : null}
                                <span className="truncate">
                                  {file.originalName}
                                  {file.importedAt ? ` · Added ${formatDate(file.importedAt)}` : ''}
                                </span>
                              </span>
                            </span>
                          </button>
                          <span aria-hidden="true" className="hidden items-center gap-2 sm:flex">
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-default transition-colors group-hover:bg-surface">
                              <span
                                className="block h-full rounded-full bg-accent"
                                style={{ width: `${(file.byteSize / Math.max(largestBytes, 1)) * 100}%` }}
                              />
                            </span>
                            <span className="w-9 text-right text-xs text-muted tabular-nums">{share}%</span>
                          </span>
                          <span className="text-right text-sm font-semibold tabular-nums">
                            {formatSize(file.byteSize)}
                          </span>
                          <Tooltip.Root closeDelay={0} delay={200}>
                            <Button
                              isIconOnly
                              aria-label={`Move ${file.title} to Trash`}
                              className="opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              size="sm"
                              variant="ghost"
                              onPress={() => setTrashId(file.itemId)}
                            >
                              <HugeiconsIcon
                                aria-hidden="true"
                                className="text-danger"
                                icon={Delete02Icon}
                                size={16}
                                strokeWidth={1.75}
                              />
                            </Button>
                            <Tooltip.Content placement="top">Move to Trash</Tooltip.Content>
                          </Tooltip.Root>
                        </li>
                      )
                    })}
                  </ul>

                  {/* The row menu opens where the pointer was, so it anchors to this
                      zero-size mark instead of a fixed corner of the list. */}
                  <span
                    ref={menuAnchorRef}
                    aria-hidden="true"
                    className="pointer-events-none absolute"
                    style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
                  />
                  <Dropdown
                    isOpen={menu !== null}
                    onOpenChange={(isOpen) => {
                      if (!isOpen) setMenu(null)
                    }}
                  >
                    <Dropdown.Trigger aria-label="File actions" className="sr-only" />
                    <Dropdown.Popover triggerRef={menuAnchorRef}>
                      <Dropdown.Menu
                        autoFocus
                        className="kivo-row-actions-menu"
                        onAction={(key) => handleMenuAction(String(key))}
                      >
                        <Dropdown.Item id="details" textValue="Open details">
                          <HugeiconsIcon aria-hidden="true" icon={EyeIcon} size={16} />
                          <Label>Open details</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="open" textValue="Open file">
                          <HugeiconsIcon aria-hidden="true" icon={File01Icon} size={16} />
                          <Label>Open file</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="reveal" textValue="Show in folder">
                          <HugeiconsIcon aria-hidden="true" icon={FolderOpenIcon} size={16} />
                          <Label>Show in folder</Label>
                        </Dropdown.Item>
                        <Dropdown.Section
                          aria-label="Danger zone"
                          className="mt-1 border-t border-separator pt-1"
                        >
                          <Dropdown.Item id="trash" textValue="Move to Trash" variant="danger">
                            <HugeiconsIcon
                              aria-hidden="true"
                              className="text-danger"
                              icon={Delete02Icon}
                              size={16}
                            />
                            <Label>Move to Trash</Label>
                          </Dropdown.Item>
                        </Dropdown.Section>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>
              )}
            </Panel>
          </div>
        </>
      ) : null}

      <ItemDetailsDialog
        itemId={openId}
        onChanged={() => setAttempt((value) => value + 1)}
        onClose={() => setOpenId(null)}
      />
      <ConfirmDialog
        confirmLabel="Move to Trash"
        description="You can restore it from Trash."
        open={trashId !== null}
        title="Move this file to Trash?"
        tone="danger"
        onCancel={() => setTrashId(null)}
        onConfirm={() => void trash()}
      />
    </section>
  )
}
