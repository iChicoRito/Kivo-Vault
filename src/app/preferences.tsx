import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { loadPreferences, savePreferences, type Preferences } from '../data/settings'

export type ResolvedTheme = 'light' | 'dark'

export type UpdatePreferencesOptions = {
  /** Set `false` when the caller runs its own theme transition. */
  transition?: boolean
}

export type PreferencesContextValue = {
  preferences: Preferences
  resolvedTheme: ResolvedTheme
  systemTheme: ResolvedTheme
  updatePreferences: (
    patch: Partial<Preferences>,
    options?: UpdatePreferencesOptions,
  ) => Promise<void>
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
  density: 'comfortable',
  startAtLogin: false,
  notesView: 'grid',
  sourcesView: 'grid',
  collectionsView: 'grid',
  navigationStyle: 'dock',
  autoLockMinutes: 0,
  semanticSearch: false,
  autoTag: false,
  summaries: false,
  clipboardClearSeconds: 0,
  clipboardExcludeHistory: false,
  linkDetails: true,
}

const FALLBACK_PREFERENCES: PreferencesContextValue = {
  preferences: DEFAULT_PREFERENCES,
  resolvedTheme: 'dark',
  systemTheme: 'light',
  updatePreferences: async () => {},
}

/** Marks the document for the length of a palette transition, see `styles/globals.css`. */
const THEME_TRANSITION_CLASS = 'kivo-theme-transition'

/** Kept in step with the transition duration of `.kivo-theme-transition`. */
const THEME_TRANSITION_MS = 300

type Point = { x: number; y: number }

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function viewportCenter(): Point {
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

/** Distance from the origin to the furthest viewport corner, so the circle clears the window. */
function revealRadius({ x, y }: Point) {
  return Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
}

/**
 * Wipes the incoming palette in as a circle growing out of the point the user
 * pressed. The origin and radius are handed to the stylesheet, which clips the
 * browser's snapshot of `root` with them, so the wipe covers the whole window
 * in one pass rather than animating the live tree.
 */
function revealThemeChange(applyTheme: () => void, origin: Point) {
  const style = document.documentElement.style

  style.setProperty('--kivo-reveal-x', `${origin.x}px`)
  style.setProperty('--kivo-reveal-y', `${origin.y}px`)
  style.setProperty('--kivo-reveal-radius', `${revealRadius(origin)}px`)

  // A swap that interrupts another is skipped, which rejects `ready`; the theme
  // is applied either way, so there is nothing to recover.
  document.startViewTransition(applyTheme).ready.catch(() => {})
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null)

export function usePreferences(): PreferencesContextValue {
  return useContext(PreferencesContext) ?? FALLBACK_PREFERENCES
}

function normalizePreferences(value: Preferences | null | undefined): Preferences {
  return {
    theme: value?.theme ?? DEFAULT_PREFERENCES.theme,
    density: value?.density ?? DEFAULT_PREFERENCES.density,
    startAtLogin: value?.startAtLogin ?? DEFAULT_PREFERENCES.startAtLogin,
    notesView: value?.notesView === 'list' ? 'list' : DEFAULT_PREFERENCES.notesView,
    sourcesView: value?.sourcesView === 'list' ? 'list' : 'grid',
    collectionsView: value?.collectionsView === 'list' ? 'list' : 'grid',
    navigationStyle: value?.navigationStyle === 'sidebar' ? 'sidebar' : 'dock',
    autoLockMinutes: [0, 5, 15, 30, 60].includes(value?.autoLockMinutes ?? 0) ? value?.autoLockMinutes ?? 0 : 0,
    semanticSearch: value?.semanticSearch ?? DEFAULT_PREFERENCES.semanticSearch,
    autoTag: value?.autoTag ?? DEFAULT_PREFERENCES.autoTag,
    summaries: value?.summaries ?? DEFAULT_PREFERENCES.summaries,
    clipboardClearSeconds: [0, 30, 60, 120].includes(value?.clipboardClearSeconds ?? 0)
      ? value?.clipboardClearSeconds ?? 0
      : 0,
    clipboardExcludeHistory: value?.clipboardExcludeHistory ?? DEFAULT_PREFERENCES.clipboardExcludeHistory,
    linkDetails: value?.linkDetails ?? DEFAULT_PREFERENCES.linkDetails,
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export type PreferencesProviderProps = {
  children: ReactNode
  initialPreferences?: Preferences
}

export function PreferencesProvider({ children, initialPreferences }: PreferencesProviderProps) {
  const [preferences, setPreferencesState] = useState<Preferences | null>(
    initialPreferences ? normalizePreferences(initialPreferences) : null,
  )
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)
  const preferencesRef = useRef<Preferences | null>(preferences)
  const appliedThemeRef = useRef<ResolvedTheme | null>(null)
  const skipRevealRef = useRef(false)
  const themeTransitionTimerRef = useRef<number | null>(null)
  const pressedAtRef = useRef<Point | null>(null)
  const current = preferences ?? DEFAULT_PREFERENCES
  const resolvedTheme: ResolvedTheme = current.theme === 'system' ? systemTheme : current.theme

  useEffect(() => {
    if (initialPreferences) return

    let active = true

    void loadPreferences()
      .then((loaded) => {
        if (!active) return

        const next = normalizePreferences(loaded)
        preferencesRef.current = next
        setPreferencesState(next)
      })
      .catch(() => {
        if (!active) return

        preferencesRef.current = DEFAULT_PREFERENCES
        setPreferencesState(DEFAULT_PREFERENCES)
      })

    return () => {
      active = false
    }
  }, [initialPreferences])

  // The wipe grows out of wherever the user last pressed, so a theme picked from
  // the menu reads as coming out of that menu rather than out of nowhere.
  useEffect(() => {
    const rememberPress = (event: PointerEvent) => {
      pressedAtRef.current = { x: event.clientX, y: event.clientY }
    }

    window.addEventListener('pointerdown', rememberPress, { capture: true, passive: true })

    return () => {
      window.removeEventListener('pointerdown', rememberPress, { capture: true })
    }
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'dark' : 'light')

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', update)
      return () => {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', update)
        }
      }
    }

    if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(update)
      return () => {
        if (typeof mediaQuery.removeListener === 'function') {
          mediaQuery.removeListener(update)
        }
      }
    }
  }, [])

  // Applied before paint so a saved dark theme never flashes light styling.
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    if (!preferences) return

    const root = document.documentElement
    const appliedTheme = appliedThemeRef.current
    appliedThemeRef.current = resolvedTheme

    // A caller can take over the palette swap -- the MagicUI toggler runs its own
    // view transition -- and a wipe here would be a second, nested one that the
    // browser skips. The flag is spent on the next effect run either way.
    const skipReveal = skipRevealRef.current
    skipRevealRef.current = false

    const applyRootAttributes = () => {
      root.dataset.theme = resolvedTheme
      root.dataset.density = preferences.density
    }

    // Repainting the palette is the only change worth animating, and only once a
    // previous palette exists: the first application is the saved theme arriving,
    // not a swap the user asked for.
    if (appliedTheme === null || appliedTheme === resolvedTheme || skipReveal) {
      applyRootAttributes()
      return
    }

    if (typeof document.startViewTransition === 'function' && !prefersReducedMotion()) {
      const origin = pressedAtRef.current ?? viewportCenter()
      pressedAtRef.current = null

      revealThemeChange(applyRootAttributes, origin)
      return
    }

    // Without view transitions the palette is interpolated instead, which keeps
    // the swap smooth rather than cutting. Reduced motion needs neither, and the
    // stylesheet already declines to transition, so both paths stay instant.
    root.classList.add(THEME_TRANSITION_CLASS)

    if (themeTransitionTimerRef.current !== null) {
      window.clearTimeout(themeTransitionTimerRef.current)
    }

    themeTransitionTimerRef.current = window.setTimeout(() => {
      themeTransitionTimerRef.current = null
      root.classList.remove(THEME_TRANSITION_CLASS)
    }, THEME_TRANSITION_MS)

    applyRootAttributes()
  }, [preferences, resolvedTheme])

  useEffect(() => {
    return () => {
      const root = document.documentElement

      if (themeTransitionTimerRef.current !== null) {
        window.clearTimeout(themeTransitionTimerRef.current)
      }

      root.classList.remove(THEME_TRANSITION_CLASS)
      delete root.dataset.theme
      delete root.dataset.density
    }
  }, [])

  const updatePreferences = useCallback(
    async (patch: Partial<Preferences>, options?: UpdatePreferencesOptions) => {
      const previous = preferencesRef.current ?? DEFAULT_PREFERENCES
      const next = { ...previous, ...patch }

      if (options?.transition === false) skipRevealRef.current = true

      preferencesRef.current = next
      setPreferencesState(next)

      try {
        await savePreferences(next)
      } catch (error) {
        preferencesRef.current = previous
        setPreferencesState(previous)
        throw error
      }
    },
    [],
  )

  const value = useMemo<PreferencesContextValue>(() => {
    return { preferences: current, resolvedTheme, systemTheme, updatePreferences }
  }, [current, resolvedTheme, systemTheme, updatePreferences])

  if (!preferences) return null

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export default PreferencesProvider
