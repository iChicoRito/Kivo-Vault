import { useEffect, useRef, useState, type RefObject } from 'react'

import { buttonVariants, ScrollShadow } from '@heroui/react'
import { Outlet } from 'react-router-dom'
import { useNavigate, useLocation } from 'react-router-dom'

import { GradualBlur } from '../components/ui/GradualBlur'
import { AnimatedThemeToggler } from '../components/ui/animated-theme-toggler'
import { notifyError } from '../lib/feedback'
import { cn } from '../lib/utils'
import AppDock from './AppDock'
import AppSidebar from './AppSidebar'
import NavbarSearch from './NavbarSearch'
import { CommandPalette } from './CommandPalette'
import { shortcuts, matchesShortcut } from './shortcuts'
import DotField from '../components/ui/DotField'
import { QuickAddDialog } from '../features/quick-add/QuickAddDialog'
import { ShortcutsDialog } from '../features/shortcuts/ShortcutsDialog'
import GuidedTour from '../features/tour/GuidedTour'
import { usePreferences } from './preferences'

function ThemeToggle() {
  const { resolvedTheme, updatePreferences } = usePreferences()

  return (
    <AnimatedThemeToggler
      className={cn(
        buttonVariants({ isIconOnly: true, variant: 'ghost' }),
        'kivo-theme-toggler [&_svg]:size-4',
      )}
      theme={resolvedTheme}
      onThemeChange={(theme) => {
        // The toggler runs its own view transition, so the provider applies the
        // palette without starting a second one.
        void updatePreferences({ theme }, { transition: false }).catch(() => {
          notifyError('Kivo could not change the theme. Try again.')
        })
      }}
    />
  )
}

// Scrolling down tucks the navbar away so the reading area gets the whole
// window; any scroll up brings it back. The direction has to accumulate a
// little first: sub-pixel wheel steps and pointer jitter would otherwise
// flicker the bar mid-scroll.
function useHideOnScroll(scrollerRef: RefObject<HTMLElement | null>) {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    let lastY = scroller.scrollTop
    let travel = 0

    const onScroll = () => {
      const y = scroller.scrollTop
      travel += y - lastY
      lastY = y

      if (Math.abs(travel) < 8) return

      const scrollingDown = travel > 0
      travel = 0
      // Near the top the bar always shows; below that, down hides the bar and
      // up reveals it.
      setHidden(scrollingDown && y > 64)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scrollerRef])

  return hidden
}

function AppNavbar({ hidden }: { hidden: boolean }) {
  return (
    <header
      id="kivo-navbar"
      data-hidden={hidden ? 'true' : undefined}
      className="sticky top-0 z-20 flex min-h-14 items-center justify-between gap-3 pt-4 pb-4"
    >
      {/* Progressive blur over the scrolling content. It sits behind the
          navbar's own controls (zIndex -1) so the field and toggle stay crisp. */}
      <GradualBlur
        curve="bezier"
        divCount={6}
        exponential
        height="100%"
        position="top"
        strength={2.5}
        zIndex={-1}
      />
      <NavbarSearch />
      <div className="flex items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  )
}

// Canvas cannot read CSS variables, so the muted text color is resolved from the theme.
function readMuted() {
  return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#71717a'
}

/** Faint dot field behind every page. Opacity is the one knob for how visible it is. */
function AppBackground() {
  const [color, setColor] = useState(readMuted)

  // Theme switches flip a class or data attribute on <html>; re-read the color then.
  useEffect(() => {
    const observer = new MutationObserver(() => setColor(readMuted()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    return () => observer.disconnect()
  }, [])

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 opacity-25">
      <DotField
        bulgeStrength={67}
        dotRadius={1.5}
        dotSpacing={14}
        glowRadius={0}
        gradientFrom={color}
        gradientTo={color}
        sparkle={false}
        waveAmplitude={0}
      />
    </div>
  )
}

export default function AppShell({ startTour = false }: { startTour?: boolean }) {
  const mainRef = useRef<HTMLDivElement>(null)
  const hidden = useHideOnScroll(mainRef)
  const navigate = useNavigate()
  const location = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickAction, setQuickAction] = useState<'file' | 'source' | 'collection' | undefined>()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [touring, setTouring] = useState(startTour)
  const { navigationStyle } = usePreferences().preferences

  // Settings restarts the tour by opening the Dashboard with `{ tour: true }`.
  // The state is cleared right away, so going back through history does not replay it.
  const tourRequested = (location.state as { tour?: boolean } | null)?.tour === true
  useEffect(() => {
    if (!tourRequested) return
    setTouring(true)
    navigate(location.pathname, { replace: true, state: null })
  }, [tourRequested, navigate, location.pathname])

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const match = shortcuts.find((shortcut) => matchesShortcut(event, shortcut.id))
      if (!match) return
      if (match.id === 'search') return // NavbarSearch owns search focus.
      if (match.id === 'favorite') return // No selected item in the shell; do not override browser bookmarks.
      if (event.repeat) return
      event.preventDefault()
      if (match.id === 'palette') setPaletteOpen(true)
      else if (match.id === 'newNote') navigate('/notes/new')
      else if (match.id === 'quickAdd') { setQuickAction(undefined); setQuickOpen(true) }
      else navigate(`/${match.id}`)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [navigate, location.pathname])

  return (
    <div
      className="relative isolate min-h-screen bg-background text-foreground"
      data-navigation={navigationStyle}
      id="kivo-shell"
    >
      <AppBackground />
      {navigationStyle === 'sidebar' ? <AppSidebar /> : null}
      <div id="kivo-workspace" className="min-w-0">
        <ScrollShadow
          ref={mainRef}
          aria-label="Kivo application"
          className="min-w-0"
          id="kivo-main"
          role="main"
          tabIndex={-1}
        >
          <AppNavbar hidden={hidden} />

          <div id="kivo-content">
            <Outlet />
          </div>
        </ScrollShadow>

        {navigationStyle === 'dock' ? <AppDock /> : null}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onQuickAdd={(action) => { setQuickAction(action); setQuickOpen(true) }} onShortcuts={() => setShortcutsOpen(true)} />
        <QuickAddDialog key={quickAction ?? 'menu'} open={quickOpen} initialAction={quickAction ?? null} onClose={() => setQuickOpen(false)} />
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        {touring ? <GuidedTour onDone={() => setTouring(false)} /> : null}
      </div>
    </div>
  )
}
