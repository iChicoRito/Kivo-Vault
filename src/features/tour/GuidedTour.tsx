import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Card } from '@heroui/react'
import { Compass01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useNavigate } from 'react-router-dom'

import SplitText from '../../components/ui/SplitText'
import { navigationGroups } from '../../app/navigation'

type TourStep = {
  to: string
  label: string
  icon: IconSvgElement
  /** Selector for the element in focus. The page's dock/sidebar link stands in if it never shows. */
  target: string
  /** Names the highlighted element, so the reader knows where to look. */
  hint: string
  text: string
  tips: string[]
  /** Page number shown on the card: the welcome is 1, then one per page. */
  page: number
  /** Set on the step that shows how to open the page from the navigation. */
  nav?: boolean
}

const PAGE_TOURS: Record<string, Omit<TourStep, 'to' | 'label' | 'icon' | 'page'>> = {
  '/dashboard': {
    target: '#kivo-content :is([aria-labelledby="dashboard-empty-title"], section[aria-labelledby="dashboard-activity"])',
    hint: 'Your overview',
    text: 'The Dashboard is where Kivo opens. It sums up everything in your vault.',
    tips: [
      'Activity shows the days you added or changed things.',
      'Items by type shows how much you keep of each kind.',
      'Recent and Favorites give you one-click access to what you use most.',
    ],
  },
  '/items': {
    target: '#kivo-content [data-tour="items"]',
    hint: 'Search, filters, and Quick Add',
    text: 'All Items lists every note, source, file, and password together.',
    tips: [
      'Type in Search items to find anything by title.',
      'Filters narrow the list by type, collection, tag, or favorites.',
      'Quick Add creates a new item without leaving the page.',
    ],
  },
  '/notes': {
    target: '#kivo-content [data-tour="notes"]',
    hint: 'New Note button',
    text: 'Notes is your writing space for ideas, lists, and anything you want to remember.',
    tips: [
      'Press New Note to open a blank note. It saves as you type.',
      'Older versions stay in the note history, so nothing is lost.',
      'Switch between grid and list layouts above your notes.',
    ],
  },
  '/sources': {
    target: '#kivo-content [data-tour="sources"]',
    hint: 'New Source button',
    text: 'Sources keeps useful links and websites so you can find them again.',
    tips: [
      'Press New Source and paste a link to save it.',
      'Give it a title and tags so search can find it later.',
    ],
  },
  '/files': {
    target: '#kivo-content [data-tour="files"]',
    hint: 'Import files button',
    text: 'Files holds your documents, images, and other local files.',
    tips: [
      'Press Import files and pick one or more files from your computer.',
      'Kivo keeps its own copy inside your vault, so moving the original is fine.',
      'Open a file to preview it, or rename and move it into a collection.',
    ],
  },
  '/collections': {
    target: '#kivo-content button[aria-label="New collection"]',
    hint: 'New Collection button',
    text: 'Collections are folders that group related items, like a project or a trip.',
    tips: [
      'Press New Collection and give it a name.',
      'Drag items into a collection to file them.',
      'Lock a collection when it holds something private.',
    ],
  },
  '/passwords': {
    target: '#kivo-content :is([data-tour="passwords"], [aria-label="Password sections"])',
    hint: 'New Password and Lock Vault',
    text: 'The Password Manager stores your logins, encrypted on this device.',
    tips: [
      'Press New Password to save a login.',
      'The Generator tab creates strong passwords for you.',
      'Lock Vault hides your passwords again until you unlock.',
    ],
  },
  '/favorites': {
    target: '#kivo-content [data-tour="favorites"] button',
    hint: 'Type filter',
    text: 'Favorites collects the items you mark as important anywhere in Kivo.',
    tips: [
      "Choose Add to favorites from any item's menu to pin it here.",
      'Use the type filter to show only notes, sources, or files.',
    ],
  },
  '/trash': {
    target: '#kivo-content [data-tour="trash"]',
    hint: 'Empty Trash button',
    text: 'Deleted items wait in Trash, so a mistake is easy to undo.',
    tips: [
      "Open an item's menu and choose Restore to put it back.",
      'Empty Trash deletes everything here for good. This cannot be undone.',
    ],
  },
  '/storage': {
    target: '#kivo-content section[aria-labelledby="storage-usage"]',
    hint: 'Space by type',
    text: 'Storage Manager shows how much space your vault uses on this device.',
    tips: [
      'Space by type splits the total into notes, files, and more.',
      'Largest files lists what takes the most room, so you can clean up.',
    ],
  },
  '/settings': {
    target: '#kivo-content [aria-label="Settings sections"]',
    hint: 'Settings tabs',
    text: 'Settings is where you make Kivo yours.',
    tips: [
      'General: your name, vault name, and startup options.',
      'Appearance: theme and dock or sidebar navigation.',
      'Security and Data: app lock, backups, import, and export.',
    ],
  },
}

const pages = navigationGroups.flatMap((group) => group.links)

const steps: TourStep[] = [
  {
    to: '/dashboard',
    label: 'Welcome to Kivo',
    icon: Compass01Icon,
    target: '.kivo-dock, [data-navigation="sidebar"] nav[aria-label="Primary navigation"]',
    hint: 'Navigation',
    text: "Here's a quick look around. This bar opens every page in Kivo. The tour uses it to visit each page, so you learn where everything is.",
    tips: [
      'Press Next to move on, or Back to see a step again.',
      'Press Esc or Skip tour at any time to leave.',
      'Ctrl+K opens the command palette to jump anywhere.',
    ],
    page: 1,
  },
  // Each page gets two steps: first its icon in the navigation, which opens it,
  // then the page's main action.
  ...pages.flatMap((link, i) => [
    {
      to: i === 0 ? '/dashboard' : pages[i - 1].to,
      label: `Go to ${link.label}`,
      icon: link.icon,
      target: `nav[aria-label="Primary navigation"] a[href="${link.to}"]`,
      hint: `${link.label} in the navigation`,
      text: `Pages open from the navigation. Press the highlighted icon to open ${link.label}, or press Next.`,
      tips: [],
      page: i + 2,
      nav: true,
    },
    { to: link.to, label: link.label, icon: link.icon, page: i + 2, ...PAGE_TOURS[link.to] },
  ]),
]

const PAGE_COUNT = pages.length + 1

const PAD = 8
const RADIUS = 16
const GAP = 16
const EDGE = 16
/** How long a page gets to render its target before the dock/sidebar link stands in. */
const FALLBACK_MS = 1500
/** The target has to hold still this long, so the spotlight never lands on a page mid-layout. */
const SETTLE_MS = 150

type Box = { x: number; y: number; w: number; h: number }
type Layout = { hole: Box; vw: number; vh: number; cardH: number }

function visibleRect(selector: string) {
  const rect = document.querySelector(selector)?.getBoundingClientRect()
  return rect && rect.width > 0 && rect.height > 0 ? rect : null
}

/** The whole window minus a rounded box; `evenodd` turns the box into a hole. */
function holeClip({ x, y, w, h }: Box, vw: number, vh: number) {
  const r = Math.min(RADIUS, w / 2, h / 2)
  const arc = `A${r} ${r} 0 0 1`
  return `path(evenodd, 'M0 0H${vw}V${vh}H0Z M${x + r} ${y}H${x + w - r}${arc} ${x + w} ${y + r}V${y + h - r}${arc} ${x + w - r} ${y + h}H${x + r}${arc} ${x} ${y + h - r}V${y + r}${arc} ${x + r} ${y}Z')`
}

/** Below the target when it fits, else above, else over the bottom of a target that fills the window. */
function cardPosition({ hole, vw, vh, cardH }: Layout, width: number) {
  const below = hole.y + hole.h + GAP
  const above = hole.y - GAP - cardH
  const top = below + cardH <= vh - EDGE ? below : above >= EDGE ? above : vh - cardH - EDGE * 1.5
  const left = Math.min(Math.max(hole.x + hole.w / 2 - width / 2, EDGE), vw - width - EDGE)
  return { top, left }
}

// Fades in only: on Next the card vanishes at once, so the next text never shows in the old spot.
const FADE = 'transition-[opacity,translate] duration-300 ease-out motion-reduce:transition-none'

export default function GuidedTour({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0)
  // `null` while the step's target is still loading: the card and ring stay
  // hidden, so they appear once, in place, instead of sliding across the window.
  const [layout, setLayout] = useState<Layout | null>(null)
  const navigate = useNavigate()
  const headingRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const step = steps[index]
  const isLast = index === steps.length - 1
  const titleId = 'kivo-tour-title'

  useEffect(() => {
    headingRef.current?.focus()
  }, [index])

  // The app behind the tour is blurred and cannot be clicked or tabbed into.
  useEffect(() => {
    const shell = document.getElementById('kivo-shell')
    shell?.setAttribute('inert', '')
    return () => shell?.removeAttribute('inert')
  }, [])

  // Pages load data and the dock magnifies, so the target is re-measured every
  // frame; state only changes when something moved.
  // ponytail: rAF polling, swap for ResizeObserver + scroll listeners if it ever shows in a profile.
  useEffect(() => {
    const startedAt = performance.now()
    const fallback = `nav[aria-label="Primary navigation"] a[href="${step.to}"]`
    let frame = 0
    let scrolled = false
    let lastKey = ''
    let stableSince = 0
    let shown = false

    setLayout(null)

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)

      let selector = step.target
      let rect = visibleRect(selector)
      if (!rect && now - startedAt > FALLBACK_MS) {
        selector = fallback
        rect = visibleRect(selector)
      }
      if (!rect) return

      if (!scrolled) {
        scrolled = true
        document.querySelector(selector)?.scrollIntoView?.({ block: 'nearest' })
        return
      }

      const next: Layout = {
        hole: { x: rect.left - PAD, y: rect.top - PAD, w: rect.width + PAD * 2, h: rect.height + PAD * 2 },
        vw: window.innerWidth,
        vh: window.innerHeight,
        cardH: cardRef.current?.offsetHeight || 320,
      }
      const key = JSON.stringify(next)
      if (key !== lastKey) {
        lastKey = key
        stableSince = now
      }

      // The first reveal waits for the target to settle; after that the
      // spotlight follows it (dock magnification, late content) right away.
      if (!shown && now - stableSince < SETTLE_MS) return
      shown = true
      setLayout((prev) => (prev && JSON.stringify(prev) === key ? prev : next))
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [step])

  const goTo = (next: number) => {
    setIndex(next)
    navigate(steps[next].to)
  }

  const finish = () => {
    navigate('/dashboard')
    onDone()
  }

  const finishRef = useRef(finish)
  finishRef.current = finish

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) finishRef.current()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  const vw = layout?.vw ?? window.innerWidth
  const cardWidth = Math.min(400, vw - EDGE * 2)
  const { top, left } = layout ? cardPosition(layout, cardWidth) : { top: 0, left: 0 }

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-background/45 backdrop-blur-[6px]"
        style={{ clipPath: layout ? holeClip(layout.hole, layout.vw, layout.vh) : undefined }}
      />

      {layout ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute rounded-2xl ring-2 ring-accent ${
            step.nav ? 'animate-pulse motion-reduce:animate-none' : ''
          }`}
          style={{ top: layout.hole.y, left: layout.hole.x, width: layout.hole.w, height: layout.hole.h }}
        />
      ) : null}

      {/* The app is inert during the tour, so a press on the highlighted icon lands here and opens the page. */}
      {layout && step.nav ? (
        <button
          aria-label={step.label}
          className="absolute cursor-pointer rounded-2xl outline-none"
          style={{ top: layout.hole.y, left: layout.hole.x, width: layout.hole.w, height: layout.hole.h }}
          type="button"
          onClick={() => goTo(index + 1)}
        />
      ) : null}

      <div
        ref={cardRef}
        aria-labelledby={titleId}
        aria-modal="true"
        role="dialog"
        className={`absolute ${layout ? `${FADE} translate-y-0 opacity-100` : 'pointer-events-none translate-y-2 opacity-0'}`}
        style={{ top, left, width: cardWidth }}
      >
        <Card className="grid gap-4 shadow-xl">
          <div className="flex items-center justify-between gap-3 text-sm text-muted">
            <span>Guided tour</span>
            <span aria-live="polite">
              {step.page} of {PAGE_COUNT}
            </span>
          </div>

          <div className="h-1 overflow-hidden rounded-full bg-default" aria-hidden="true">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${((index + 1) / steps.length) * 100}%` }}
            />
          </div>

          <div className="grid gap-3" key={step.label}>
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
                <HugeiconsIcon aria-hidden="true" icon={step.icon} size={18} strokeWidth={1.75} />
              </span>
              <div className="grid min-w-0">
                <SplitText
                  className="typography typography--h3 outline-none"
                  delay={30}
                  duration={0.55}
                  id={titleId}
                  ref={headingRef}
                  splitType="chars"
                  tabIndex={-1}
                  tag="h2"
                  text={step.label}
                  textAlign="start"
                />
                <span className="text-xs font-medium text-accent">Highlighted: {step.hint}</span>
              </div>
            </div>

            <p className="typography typography--body">{step.text}</p>

            {step.tips.length > 0 ? (
              <ul className="grid gap-2">
                {step.tips.map((tip) => (
                  <li key={tip} className="flex gap-2 text-sm text-muted">
                    <HugeiconsIcon
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 text-accent"
                      icon={Tick02Icon}
                      size={16}
                      strokeWidth={2}
                    />
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onPress={finish}>
              Skip tour
            </Button>
            <div className="flex gap-2">
              {index > 0 ? (
                <Button size="sm" variant="secondary" onPress={() => goTo(index - 1)}>
                  Back
                </Button>
              ) : null}
              <Button size="sm" variant="primary" onPress={isLast ? finish : () => goTo(index + 1)}>
                {isLast ? 'Finish' : 'Next'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>,
    document.body,
  )
}
