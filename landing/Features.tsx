import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type SVGProps } from 'react'
import { Chip, Typography } from '@heroui/react'
import {
  DashboardSquare01Icon,
  Layers01Icon,
  Link02Icon,
  NoteEditIcon,
  Search01Icon,
  SquareLockPasswordIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { MonoActivityHeatmap } from '@/components/charts/MonoActivityHeatmap'
import { FileTypeIcon } from '@/components/items/FileTypeIcon'
import { ItemCard } from '@/components/items/ItemCard'
import { formatSize } from '@/components/items/fileSize'
import { BentoCard, BentoGrid } from '@/components/ui/bento-grid'
import SplitText from '@/components/ui/SplitText'
import type { Collection } from '@/data/collections'
import type { ItemSummary } from '@/data/items'
import type { CredentialSummary } from '@/data/passwords'
import { CollectionFolderFloat } from '@/features/collections/CollectionFolderFloat'
import { buildActivityWeeks } from '@/features/dashboard/activity'
import { NoteGridCard } from '@/features/notes/NoteGridCard'
import { CredentialAvatar } from '@/features/passwords/CredentialAvatar'
import { setBrowserBackend } from '@/data/runtime'
import { demoInvoke, resetDemoBackend } from './demo/backend'
import { openInDemo } from './demo/KivoDemo'
import { useInView } from './useInView'

// The reused components (password avatars) read through the demo backend.
setBrowserBackend(demoInvoke)

type Vault = { items: ItemSummary[]; collections: Collection[]; credentials: CredentialSummary[] }

/** The same seed data the demo window starts with, read through the same backend. */
function useVault() {
  const [vault, setVault] = useState<Vault | null>(null)

  useEffect(() => {
    let active = true

    void (async () => {
      await resetDemoBackend()
      const [items, collections, credentials] = await Promise.all([
        demoInvoke<ItemSummary[]>('list_items', { filter: null }),
        demoInvoke<Collection[]>('list_collections'),
        demoInvoke<CredentialSummary[]>('list_credentials', { filter: null }),
      ])
      if (active) setVault({ items, collections, credentials })
    })()

    return () => {
      active = false
    }
  }, [])

  return vault
}

function icon(svg: IconSvgElement) {
  return function FeatureIcon({ className }: SVGProps<SVGSVGElement>) {
    return <HugeiconsIcon aria-hidden="true" className={className} icon={svg} strokeWidth={1.5} />
  }
}

const noop = () => {}

/** Backgrounds are a live preview only: they fade out toward the card text and take no clicks. */
function Preview({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`kivo-fade-bottom pointer-events-none absolute inset-0 transition-transform duration-500 ease-out group-hover:scale-[1.03] ${className}`}
      inert
    >
      {children}
    </div>
  )
}

/** Loops a counter on an interval; stands still for visitors who ask for reduced motion. */
/** False while the feature grid is off screen, so the loops stop costing frames. */
const PlayingContext = createContext(true)

function useTicker(ms: number) {
  const reduced = useReducedMotion()
  const playing = useContext(PlayingContext)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (reduced || !playing) return
    const timer = window.setInterval(() => setTick((value) => value + 1), ms)
    return () => window.clearInterval(timer)
  }, [ms, reduced, playing])

  return tick
}

const SPRING = { type: 'spring', stiffness: 260, damping: 26 } as const
const ENTER = { opacity: 0, filter: 'blur(6px)' }
const SHOWN = { opacity: 1, filter: 'blur(0px)' }

/** Three tilted rows of the app's note cards, drifting past at different speeds. */
function NotesPreview({ notes }: { notes: ItemSummary[] }) {
  const rows = [notes, [...notes].reverse(), [...notes.slice(2), ...notes.slice(0, 2)]]

  return (
    <Preview className="overflow-hidden">
      <div className="kivo-notes-tilt grid gap-3">
        {rows.map((row, index) => (
          <div key={index} className="flex">
            <div
              className={`kivo-marquee flex gap-3 pr-3 ${index === 1 ? 'kivo-marquee-reverse' : ''}`}
              style={{ animationDuration: `${36 + index * 10}s` }}
            >
              {[...row, ...row, ...row].map((note, noteIndex) => (
                <div key={noteIndex} className="w-64 shrink-0">
                  <NoteGridCard item={note} onOpen={noop} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Preview>
  )
}

/** Password Manager rows; a highlight glides from login to login as if picking one to copy. */
function PasswordsPreview({ credentials }: { credentials: CredentialSummary[] }) {
  const rows = credentials.slice(0, 3)
  const active = useTicker(1800) % Math.max(rows.length, 1)

  return (
    <Preview className="grid content-start gap-2 p-4">
      {rows.map((credential, index) => (
        <motion.div
          key={credential.id}
          animate={{ ...SHOWN, x: 0, scale: index === active ? 1.02 : 1 }}
          className="relative"
          initial={{ ...ENTER, x: 40 }}
          transition={{ ...SPRING, delay: index * 0.12 }}
        >
          {index === active ? (
            <motion.span
              className="absolute inset-0 rounded-3xl ring-2 ring-accent"
              layoutId="kivo-password-focus"
              transition={SPRING}
            />
          ) : null}
          <ItemCard
            chips={
              <Chip size="sm" variant="soft">
                {credential.category || 'Uncategorized'}
              </Chip>
            }
            leading={<CredentialAvatar service={credential.service} url={credential.url} />}
            subtitle={
              <Typography className="truncate" color="muted" type="body-sm">
                {index === active ? 'Password copied' : credential.username || 'No username'}
              </Typography>
            }
            title={credential.service}
          />
        </motion.div>
      ))}
    </Preview>
  )
}

function FileRow({ item }: { item: ItemSummary }) {
  return (
    <ItemCard
      leading={
        <span className="grid size-11 place-items-center rounded-xl bg-default">
          {item.kind === 'note' ? (
            <HugeiconsIcon aria-hidden="true" icon={NoteEditIcon} size={22} />
          ) : (
            <FileTypeIcon name={item.file?.originalName ?? item.title} size={22} />
          )}
        </span>
      }
      subtitle={
        <Typography color="muted" type="body-xs">
          {item.kind === 'file' ? formatSize(item.file?.byteSize) : item.kind === 'note' ? 'Note' : 'Link'}
        </Typography>
      }
      title={item.title}
    />
  )
}

const QUERIES = ['lease', 'lisbon', 'rust', 'garlic']
const TYPE_STEPS = 8 // letters typed, a pause, then the next query

/** Queries type themselves into the vault search, and the matching rows spring in and out. */
function SearchPreview({ items }: { items: ItemSummary[] }) {
  const tick = useTicker(160)
  const cycle = Math.floor(tick / (TYPE_STEPS + 14))
  const step = tick % (TYPE_STEPS + 14)
  const query = QUERIES[cycle % QUERIES.length]
  const typed = query.slice(0, Math.min(step, query.length))
  const done = typed === query
  const matches = done
    ? items.filter((item) => `${item.title} ${item.content ?? ''}`.toLowerCase().includes(query)).slice(0, 3)
    : []

  return (
    <Preview className="grid content-start gap-2 p-4">
      <div className="flex h-10 items-center gap-2 rounded-xl bg-default px-3 text-sm">
        <HugeiconsIcon aria-hidden="true" className="text-muted" icon={Search01Icon} size={16} />
        <span>{typed}</span>
        <span className="kivo-caret -ml-1.5 h-4 w-0.5 bg-foreground" />
      </div>
      <AnimatePresence mode="popLayout">
        {matches.map((item, index) => (
          <motion.div
            key={`${query}-${item.id}`}
            layout
            animate={{ ...SHOWN, y: 0, scale: 1 }}
            exit={{ ...ENTER, y: -8, scale: 0.96 }}
            initial={{ ...ENTER, y: 14, scale: 0.96 }}
            transition={{ ...SPRING, delay: index * 0.08 }}
          >
            <FileRow item={item} />
          </motion.div>
        ))}
      </AnimatePresence>
    </Preview>
  )
}

/**
 * The Collections page's folder cards. The real folders open on hover, so the
 * preview plays that hover on each folder in turn: the flap lifts and the item
 * pills fan out, then it closes as the next one opens.
 */
function CollectionsPreview({ collections, items }: { collections: Collection[]; items: ItemSummary[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const active = useTicker(2400) % Math.max(collections.length, 1)

  useEffect(() => {
    const folders = ref.current?.querySelectorAll<HTMLElement>('.folder-float') ?? []
    folders.forEach((folder, index) => {
      // React builds its enter and leave events from pointerover and pointerout.
      const type = index === active ? 'pointerover' : 'pointerout'
      folder.dispatchEvent(new PointerEvent(type, { bubbles: true, relatedTarget: document.body }))
    })
  }, [active, collections.length])

  return (
    <Preview className="p-4">
      <div ref={ref} className="grid grid-cols-3 content-start gap-3 pt-10">
        {collections.map((collection, index) => (
          <motion.div
            key={collection.id}
            animate={{ y: index === active ? -8 : 0, scale: index === active ? 1.04 : 1 }}
            transition={SPRING}
          >
            <CollectionFolderFloat
              actions={[]}
              collection={collection}
              items={items.filter((item) => item.collectionId === collection.id)}
              locked={false}
              onAction={noop}
              onOpenCollection={noop}
              onOpenItem={noop}
            />
          </motion.div>
        ))}
      </div>
    </Preview>
  )
}

/** New files and links land on top of the library one by one, pushing the rest down. */
function LibraryPreview({ items }: { items: ItemSummary[] }) {
  const library = items.filter((item) => item.kind !== 'note')
  const tick = useTicker(1700)
  const visible = library.length
    ? Array.from({ length: 4 }, (_, index) => {
        const position = tick - index
        return { key: position, item: library[((position % library.length) + library.length) % library.length] }
      })
    : []

  return (
    <Preview className="grid content-start gap-2 p-4">
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map(({ key, item }) => (
          <motion.div
            key={key}
            layout
            animate={{ ...SHOWN, scale: 1, y: 0 }}
            exit={{ ...ENTER, scale: 0.9 }}
            initial={{ ...ENTER, scale: 0.85, y: -24 }}
            transition={SPRING}
          >
            <FileRow item={item} />
          </motion.div>
        ))}
      </AnimatePresence>
    </Preview>
  )
}

/** Stand-in edit history so the dashboard's heatmap has half a year to show. */
function activityHistory(items: ItemSummary[]): ItemSummary[] {
  const history: ItemSummary[] = []
  for (let day = 0; day < 26 * 7; day += 1) {
    const edits = (day * 7919) % 11 > 5 ? ((day * 31) % 4) + 1 : 0
    for (let edit = 0; edit < edits; edit += 1) {
      history.push({ ...items[0], updatedAt: new Date(Date.now() - day * 86_400_000).toISOString() })
    }
  }
  return [...items, ...history]
}

/** The Dashboard's own activity heatmap. */
function DashboardPreview({ items }: { items: ItemSummary[] }) {
  const activity = buildActivityWeeks(activityHistory(items), new Date(), 26)
  const ref = useRef<HTMLDivElement>(null)

  // Each week column gets its index, so the CSS wave rolls across the weeks.
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>('[role="img"] > div').forEach((week, index) => {
      week.style.setProperty('--i', String(index))
    })
  }, [activity.weeks.length])

  return (
    <Preview className="kivo-heatmap-preview flex justify-center p-5">
      <div ref={ref} className="w-full max-w-2xl">
        <MonoActivityHeatmap label="Activity over the last 26 weeks" weeks={activity.weeks} />
      </div>
    </Preview>
  )
}

export default function Features() {
  const sectionRef = useRef<HTMLElement>(null)
  const playing = useInView(sectionRef)
  const vault = useVault()
  const items = vault?.items ?? []
  const notes = items.filter((item) => item.kind === 'note')

  const features = [
    {
      name: 'Notes that stay yours',
      description: 'A rich text editor with pins, tags and version history. Every change is saved as you type.',
      Icon: icon(NoteEditIcon),
      route: '/notes',
      background: <NotesPreview notes={notes} />,
      className: 'lg:col-span-2',
    },
    {
      name: 'Password vault',
      description: 'Logins encrypted with AES-256-GCM behind one master password, plus a password generator.',
      Icon: icon(SquareLockPasswordIcon),
      route: '/passwords',
      background: <PasswordsPreview credentials={vault?.credentials ?? []} />,
      className: 'lg:col-span-1',
    },
    {
      name: 'Find anything',
      description: 'Search titles, note text, tags, links and file names at once. Press Ctrl F from anywhere.',
      Icon: icon(Search01Icon),
      route: '/items',
      background: <SearchPreview items={items} />,
      className: 'lg:col-span-1',
    },
    {
      name: 'Collections',
      description: 'Group notes, links and files by project or trip. Drag items onto a folder to move them.',
      Icon: icon(Layers01Icon),
      route: '/collections',
      background: <CollectionsPreview collections={vault?.collections ?? []} items={items} />,
      className: 'lg:col-span-2',
    },
    {
      name: 'Links and files',
      description: 'Save web links and import PDFs, images and documents into your own library.',
      Icon: icon(Link02Icon),
      route: '/files',
      background: <LibraryPreview items={items} />,
      className: 'lg:col-span-1',
    },
    {
      name: 'Your vault at a glance',
      description: 'See what you worked on, what fills your storage and what waits in Trash.',
      Icon: icon(DashboardSquare01Icon),
      route: '/dashboard',
      background: <DashboardPreview items={items} />,
      className: 'lg:col-span-2',
    },
  ]

  return (
    <section
      ref={sectionRef}
      aria-labelledby="features-heading"
      className={`mx-auto max-w-6xl px-4 pb-24 sm:px-6 sm:pb-36 ${playing ? '' : 'kivo-paused'}`}
    >
      <SplitText
        className="mb-8 block text-3xl leading-tight font-semibold tracking-[-0.02em] text-balance"
        delay={30}
        duration={0.55}
        id="features-heading"
        splitType="chars"
        tag="h2"
        text="What Kivo keeps for you"
      />
      <PlayingContext value={playing}>
        <BentoGrid>
          {features.map(({ route, ...feature }) => (
            <BentoCard
              key={feature.name}
              {...feature}
              cta="Open in the demo"
              href="#demo"
              onCta={(event) => {
                event.preventDefault()
                openInDemo(route)
              }}
            />
          ))}
        </BentoGrid>
      </PlayingContext>
    </section>
  )
}
