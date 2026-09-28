import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Button, Card, EmptyState, Skeleton, Typography } from '@heroui/react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  Delete02Icon,
  FolderOpenIcon,
  HardDriveIcon,
  Layers01Icon,
  LibraryIcon,
  Link02Icon,
  NoteEditIcon,
  PlusSignIcon,
  StarIcon,
} from '@hugeicons/core-free-icons'
import { Link, useNavigate } from 'react-router-dom'

import PageHeader from '../../app/PageHeader'
import { MonoActivityHeatmap } from '../../components/charts/MonoActivityHeatmap'
import { MonoRoundedDonutChart } from '../../components/charts/MonoRoundedDonutChart'
import { MonoRoundedTreemapChart } from '../../components/charts/MonoRoundedTreemapChart'
import { listCollections, type Collection } from '../../data/collections'
import { loadVaultSummary, type VaultSummary } from '../../data/dashboard'
import { listItems, type ItemKind, type ItemSummary } from '../../data/items'
import { useVaultChanged } from '../../lib/useVaultChanged'
import { Panel } from '../../components/ui/Panel'
import { QuickAddDialog } from '../quick-add/QuickAddDialog'
import { QuickAddMenu } from '../quick-add/QuickAddMenu'
import type { QuickAddAction } from '../quick-add/QuickAddTiles'
import { ItemDetailsDialog } from '../items/ItemDetailsDialog'
import { buildActivityWeeks } from './activity'

type LoadState = 'loading' | 'ready' | 'error'

type InitialAction = QuickAddAction

const ACTIVITY_WEEKS = 26
const LIST_LIMIT = 6

const KIND_ICONS: Record<ItemKind, IconSvgElement> = {
  note: NoteEditIcon,
  source: Link02Icon,
  file: FolderOpenIcon,
}

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : shortDate.format(date)
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unitIndex]}`
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      className={`rounded-sm text-xs text-muted no-underline hover:text-foreground ${focusRing}`}
      to={to}
    >
      {children}
    </Link>
  )
}

function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="grid gap-1">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex items-center gap-3 py-1.5">
          <Skeleton animationType="shimmer" className="size-7 rounded-md" />
          <Skeleton animationType="shimmer" className="h-3.5 flex-1 rounded-md" />
          <Skeleton animationType="shimmer" className="h-3 w-10 rounded-md" />
        </li>
      ))}
    </ul>
  )
}

type EmptyCopy = { icon: IconSvgElement; title: string; description: string }

// A small version of the page empty states: icon, title and one line.
function EmptyNote({ icon, title, description }: EmptyCopy) {
  return (
    <EmptyState className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-default px-4 py-8 text-center">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-background-tertiary text-muted"
      >
        <HugeiconsIcon icon={icon} size={18} />
      </span>
      <div className="grid gap-1">
        <Typography align="center" type="body" weight="medium">
          {title}
        </Typography>
        <Typography align="center" color="muted" type="body-sm">
          {description}
        </Typography>
      </div>
    </EmptyState>
  )
}

function ItemRows({
  items,
  empty,
  onOpen,
}: {
  items: ItemSummary[]
  empty: EmptyCopy
  onOpen: (id: string) => void
}) {
  if (items.length === 0) return <EmptyNote {...empty} />

  return (
    <ul className="-mx-2 m-0 grid list-none p-0">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <button
            className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-default ${focusRing}`}
            type="button"
            onClick={() => onOpen(item.id)}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-default">
              <HugeiconsIcon
                aria-hidden="true"
                className="text-muted"
                icon={KIND_ICONS[item.kind]}
                size={14}
                strokeWidth={1.75}
              />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
            <time className="shrink-0 text-xs text-muted tabular-nums" dateTime={item.updatedAt}>
              {formatDate(item.updatedAt)}
            </time>
          </button>
        </li>
      ))}
    </ul>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()

  const [summary, setSummary] = useState<VaultSummary | null>(null)
  const [items, setItems] = useState<ItemSummary[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)

  const [openItemId, setOpenItemId] = useState<string | null>(null)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [initialAction, setInitialAction] = useState<InitialAction | null>(null)

  useVaultChanged(() => setAttempt((value) => value + 1))

  useEffect(() => {
    let active = true
    setLoadState((state) => (state === 'ready' ? state : 'loading'))

    Promise.all([
      loadVaultSummary(),
      // ponytail: loads every item summary for the heatmap; add a per-day count command if vaults get large
      listItems(),
      listCollections(),
    ])
      .then(([loadedSummary, loadedItems, loadedCollections]) => {
        if (!active) return
        setSummary(loadedSummary)
        setItems(loadedItems)
        setCollections(loadedCollections)
        setLoadState('ready')
      })
      .catch(() => {
        if (active) setLoadState('error')
      })

    return () => {
      active = false
    }
  }, [attempt])

  function reload() {
    setAttempt((value) => value + 1)
  }

  function openQuickAdd(action: InitialAction | null) {
    setInitialAction(action)
    setQuickAddOpen(true)
  }

  const loading = loadState === 'loading'
  const ready = loadState === 'ready' && summary !== null
  const favorites = items.filter((item) => item.isFavorite).slice(0, LIST_LIMIT)
  const recent = [...items]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, LIST_LIMIT)
  const topCollections = collections.slice(0, LIST_LIMIT)
  const maxCollectionCount = Math.max(1, ...topCollections.map((collection) => collection.itemCount))
  // ItemSummary has no createdAt, so activity means "last edited".
  const activity = buildActivityWeeks(items, new Date(), ACTIVITY_WEEKS)
  const activityDays = activity.weeks.flat()
  const activityStats = [
    ['Active days', String(activityDays.filter((day) => day.count > 0).length)],
    ['Busiest day', plural(Math.max(0, ...activityDays.map((day) => day.count)), 'edit')],
    ['This week', plural(activity.weeks.at(-1)?.reduce((sum, day) => sum + day.count, 0) ?? 0, 'edit')],
  ]

  const kpis = summary
    ? [
        {
          label: 'Items',
          value: summary.itemCount,
          hint: `${summary.noteCount} notes · ${summary.sourceCount} sources · ${summary.fileCount} files`,
          to: '/items',
          icon: LibraryIcon,
        },
        {
          label: 'Favorites',
          value: summary.favoriteCount,
          hint: `${summary.itemCount > 0 ? Math.round((summary.favoriteCount / summary.itemCount) * 100) : 0}% of items`,
          to: '/favorites',
          icon: StarIcon,
        },
        {
          label: 'Collections',
          value: summary.collectionCount,
          hint: plural(summary.tagCount, 'tag'),
          to: '/collections',
          icon: Layers01Icon,
        },
        {
          label: 'Trash',
          value: summary.trashCount,
          hint: 'Waiting to be cleared',
          to: '/trash',
          icon: Delete02Icon,
        },
        {
          label: 'Storage used',
          value: formatBytes(summary.fileBytes + summary.databaseBytes),
          hint: `${formatBytes(summary.fileBytes)} files · ${formatBytes(summary.databaseBytes)} database`,
          to: '/storage',
          icon: HardDriveIcon,
        },
      ]
    : []

  return (
    <section aria-labelledby="dashboard-title" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          description="Your vault at a glance."
          title="Dashboard"
          titleId="dashboard-title"
        />
        <QuickAddMenu onAdded={reload} />
      </div>

      {loadState === 'error' ? (
        <Alert aria-labelledby="dashboard-error-title" role="alert" status="danger">
          <Alert.Content className="grid gap-2">
            <h2 className="m-0 text-sm font-semibold" id="dashboard-error-title">
              Your dashboard could not load
            </h2>
            <p className="m-0 text-sm">Kivo could not read this vault. Try again.</p>
            <Button className="justify-self-start" size="sm" variant="secondary" onPress={reload}>
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {ready && summary.itemCount === 0 ? (
        <EmptyState
          aria-labelledby="dashboard-empty-title"
          className="flex min-h-[32rem] flex-col items-center justify-center gap-5 rounded-3xl border border-dashed border-default px-6 py-16 text-center"
        >
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-background-tertiary text-muted"
          >
            <HugeiconsIcon icon={LibraryIcon} size={24} />
          </span>
          <div className="grid max-w-lg gap-2">
            {/* An h2 under the page's h1, styled like the h3 titles of the other empty states. */}
            <h2 className="typography typography--h3 typography--align-center" id="dashboard-empty-title">
              Your vault is looking a little empty.
            </h2>
            <Typography align="center" color="muted" type="body">
              Start adding the things that matter to you.
            </Typography>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onPress={() => openQuickAdd('note')}>
              <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
              Add Note
            </Button>
            <Button variant="secondary" onPress={() => openQuickAdd('file')}>
              Add File
            </Button>
            <Button variant="secondary" onPress={() => openQuickAdd('source')}>
              Save Link
            </Button>
            <Button variant="secondary" onPress={() => openQuickAdd('collection')}>
              Create Collection
            </Button>
          </div>
        </EmptyState>
      ) : null}

      {loading || (ready && summary.itemCount > 0) ? (
        <div
          aria-labelledby={loading ? 'dashboard-loading-title' : undefined}
          aria-live={loading ? 'polite' : undefined}
          className="grid gap-3"
          role={loading ? 'status' : undefined}
        >
          {loading ? (
            <Typography className="sr-only" id="dashboard-loading-title" type="h2">
              Loading your dashboard
            </Typography>
          ) : null}

          <Card className="overflow-hidden p-0">
            <ul className="m-0 grid list-none grid-cols-2 gap-px bg-separator p-0 lg:grid-cols-5">
              {loading
                ? Array.from({ length: 5 }, (_, index) => (
                    <li
                      key={index}
                      aria-hidden="true"
                      className="grid gap-2 bg-surface p-4 last:col-span-2 lg:last:col-span-1"
                    >
                      <Skeleton animationType="shimmer" className="h-3 w-16 rounded-md" />
                      <Skeleton animationType="shimmer" className="h-7 w-12 rounded-md" />
                      <Skeleton animationType="shimmer" className="h-3 w-24 rounded-md" />
                    </li>
                  ))
                : kpis.map((kpi) => (
                    <li key={kpi.label} className="min-w-0 bg-surface last:col-span-2 lg:last:col-span-1">
                      <Link
                        aria-label={`${kpi.label} ${kpi.value}. ${kpi.hint}`}
                        className={`grid h-full gap-1 p-4 no-underline transition-colors hover:bg-surface-hover ${focusRing} focus-visible:-outline-offset-2`}
                        to={kpi.to}
                      >
                        <span className="flex items-center gap-1.5 text-xs text-muted">
                          <HugeiconsIcon
                            aria-hidden="true"
                            icon={kpi.icon}
                            size={14}
                            strokeWidth={1.75}
                          />
                          {kpi.label}
                        </span>
                        <span className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
                          {kpi.value}
                        </span>
                        <span className="truncate text-xs text-muted">{kpi.hint}</span>
                      </Link>
                    </li>
                  ))}
            </ul>
          </Card>

          <div className="grid gap-3 lg:grid-cols-12">
            <Panel
              className="lg:col-span-8"
              id="dashboard-activity"
              meta={
                ready ? (
                  <span className="text-xs text-muted tabular-nums">
                    {plural(activity.total, 'edit')} · last {ACTIVITY_WEEKS} weeks
                  </span>
                ) : null
              }
              title="Activity"
            >
              {ready ? (
                <>
                  <MonoActivityHeatmap
                    label={`Items last edited per day over the last ${ACTIVITY_WEEKS} weeks: ${activity.total} in total.`}
                    weeks={activity.weeks}
                  />
                  <dl className="m-0 grid grid-cols-3 divide-x divide-separator">
                    {activityStats.map(([label, value]) => (
                      <div key={label} className="grid gap-0.5 px-4 first:pl-0">
                        <dt className="text-xs text-muted">{label}</dt>
                        <dd className="m-0 text-sm font-semibold tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <Skeleton aria-hidden="true" animationType="shimmer" className="h-48 rounded-[14px]" />
              )}
            </Panel>

            <Panel className="lg:col-span-4" id="dashboard-types" title="Items by type">
              {ready ? (
                <MonoRoundedDonutChart
                  data={[
                    { name: 'Notes', value: summary.noteCount },
                    { name: 'Sources', value: summary.sourceCount },
                    { name: 'Files', value: summary.fileCount },
                  ]}
                  label={`Notes ${summary.noteCount}, sources ${summary.sourceCount}, files ${summary.fileCount}.`}
                />
              ) : (
                <Skeleton aria-hidden="true" animationType="shimmer" className="h-44 rounded-[14px]" />
              )}
            </Panel>

            <Panel
              className="lg:col-span-4"
              id="dashboard-recent"
              meta={ready ? <PanelLink to="/items">View all</PanelLink> : null}
              title="Recent"
            >
              {ready ? (
                <ItemRows
                  empty={{
                    icon: NoteEditIcon,
                    title: 'Nothing edited yet.',
                    description: 'Notes, links and files you change show up here.',
                  }}
                  items={recent}
                  onOpen={setOpenItemId}
                />
              ) : (
                <RowsSkeleton />
              )}
            </Panel>

            <Panel
              className="lg:col-span-4"
              id="dashboard-favorites"
              meta={ready ? <PanelLink to="/favorites">View all</PanelLink> : null}
              title="Favorites"
            >
              {ready ? (
                <ItemRows
                  empty={{
                    icon: StarIcon,
                    title: 'No favorites yet.',
                    description: 'Star an item to keep it close at hand.',
                  }}
                  items={favorites}
                  onOpen={setOpenItemId}
                />
              ) : (
                <RowsSkeleton />
              )}
            </Panel>

            <Panel
              className="lg:col-span-4"
              id="dashboard-collections"
              meta={ready ? <PanelLink to="/collections">View all</PanelLink> : null}
              title="Collections"
            >
              {!ready ? (
                <RowsSkeleton />
              ) : topCollections.length === 0 ? (
                <EmptyNote
                  description="Group related items into a collection."
                  icon={FolderOpenIcon}
                  title="No collections yet."
                />
              ) : (
                <ul className="-mx-2 m-0 grid list-none p-0">
                  {topCollections.map((collection) => (
                    <li key={collection.id}>
                      <button
                        className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-default ${focusRing}`}
                        aria-label={`${collection.name}, ${plural(collection.itemCount, 'item')}`}
                        type="button"
                        onClick={() => navigate(`/items?collection=${collection.id}`)}
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-default">
                          <HugeiconsIcon
                            aria-hidden="true"
                            className="text-muted"
                            icon={Layers01Icon}
                            size={14}
                            strokeWidth={1.75}
                          />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{collection.name}</span>
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-default"
                        >
                          <span
                            className="block h-full rounded-full bg-accent"
                            style={{ width: `${(collection.itemCount / maxCollectionCount) * 100}%` }}
                          />
                        </span>
                        <span className="w-6 shrink-0 text-right text-xs text-muted tabular-nums">
                          {collection.itemCount}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              className="lg:col-span-12"
              id="dashboard-storage"
              meta={ready ? <PanelLink to="/storage">Manage</PanelLink> : null}
              title="Storage"
            >
              {ready ? (
                <>
                  <MonoRoundedTreemapChart
                    label={`Managed files ${formatBytes(summary.fileBytes)}, database ${formatBytes(summary.databaseBytes)}.`}
                    tiles={[
                      {
                        name: 'Managed files',
                        value: summary.fileBytes,
                        display: formatBytes(summary.fileBytes),
                      },
                      {
                        name: 'Database',
                        value: summary.databaseBytes,
                        display: formatBytes(summary.databaseBytes),
                      },
                    ]}
                  />
                  <dl className="m-0 grid grid-cols-3 divide-x divide-separator">
                    {[
                      ['Managed files', formatBytes(summary.fileBytes)],
                      ['Database', formatBytes(summary.databaseBytes)],
                      ['Files stored', String(summary.fileCount)],
                    ].map(([label, value]) => (
                      <div key={label} className="grid gap-0.5 px-4 first:pl-0">
                        <dt className="text-xs text-muted">{label}</dt>
                        <dd className="m-0 text-sm font-semibold tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <Skeleton aria-hidden="true" animationType="shimmer" className="h-52 rounded-[14px]" />
              )}
            </Panel>
          </div>
        </div>
      ) : null}

      <ItemDetailsDialog
        itemId={openItemId}
        onChanged={reload}
        onClose={() => setOpenItemId(null)}
      />

      <QuickAddDialog
        initialAction={initialAction}
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
      />
    </section>
  )
}
