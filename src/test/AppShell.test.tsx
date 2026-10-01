import '@testing-library/jest-dom/vitest'

import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsMock = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
  loadProfile: vi.fn(),
}))

const windowMock = vi.hoisted(() => ({ close: vi.fn() }))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))

vi.mock('../data/settings', () => settingsMock)
vi.mock('../lib/feedback', () => feedbackMock)
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowMock }))

import AppShell from '../app/AppShell'
import { LockProvider } from '../app/lock'
import { navigationGroups } from '../app/navigation'
import { DEFAULT_PREFERENCES, PreferencesProvider } from '../app/preferences'
import type { Preferences } from '../data/settings'
import { getTauriInvoke, setMediaQueryMatches } from './setup'

const destinationLabels = [
  'Dashboard',
  'All Items',
  'Notes',
  'Sources',
  'Files',
  'Collections',
  'Password Manager',
  'Favorites',
  'Trash',
  'Storage Manager',
  'Settings',
] as const

const hrefByLabel: Record<string, string> = {
  Dashboard: '/dashboard',
  'All Items': '/items',
  Notes: '/notes',
  Sources: '/sources',
  Files: '/files',
  Collections: '/collections',
  'Password Manager': '/passwords',
  Favorites: '/favorites',
  Trash: '/trash',
  'Storage Manager': '/storage',
  Settings: '/settings',
}

const deferredControls = ['Quick Add', 'Command Palette', 'Vault Lock']

function RouteMarker() {
  const { pathname } = useLocation()
  return <h1>{pathname}</h1>
}

function renderShell(
  initialPath: string | { pathname: string; state: unknown } = '/dashboard',
  preferences: Partial<Preferences> = {},
) {
  return render(
    <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, ...preferences }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<RouteMarker />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

function dock() {
  return screen.getByRole('navigation', { name: 'Primary navigation' })
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsMock.loadProfile.mockResolvedValue({ ownerName: '', vaultName: '', setupCompletedAt: null })
})

async function activateWithEnter(element: HTMLElement) {
  let keyDown: KeyboardEvent | undefined

  await act(async () => {
    element.focus()
    keyDown = createEvent.keyDown(element, { key: 'Enter', code: 'Enter' })
    fireEvent(element, keyDown)

    if (!keyDown.defaultPrevented && element instanceof HTMLAnchorElement) {
      // jsdom does not perform anchor default actions for KeyboardEvent.
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }

    fireEvent.keyUp(element, { key: 'Enter', code: 'Enter' })
  })

  if (!keyDown) throw new Error('Enter key event was not created')
  return keyDown
}

describe('AppShell', () => {
  it('starts the guided tour when a page asks for it through the location state', async () => {
    renderShell({ pathname: '/dashboard', state: { tour: true } })

    expect(await screen.findByRole('dialog')).toHaveTextContent('Welcome to Kivo')
  })

  it('does not start the guided tour on a normal visit', () => {
    renderShell('/dashboard')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders every destination in the dock in documented order', () => {
    renderShell()

    const links = within(dock()).getAllByRole('link')

    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([...destinationLabels])

    for (const label of destinationLabels) {
      expect(within(dock()).getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'href',
        hrefByLabel[label],
      )
    }
  })

  it('shows the sidebar instead of the dock when the sidebar style is saved', async () => {
    renderShell('/notes', { navigationStyle: 'sidebar' })

    const sidebar = document.getElementById('kivo-sidebar')
    expect(sidebar).not.toBeNull()
    expect(document.getElementById('kivo-dock-nav')).toBeNull()
    expect(document.getElementById('kivo-shell')).toHaveAttribute('data-navigation', 'sidebar')

    const links = within(dock()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([...destinationLabels])
    expect(within(dock()).getByRole('link', { name: 'Notes' })).toHaveAttribute('aria-current', 'page')

    fireEvent.click(within(dock()).getByRole('link', { name: 'Sources' }))
    expect(await screen.findByRole('heading', { name: '/sources' })).toBeInTheDocument()
  })

  it('shows the owner in the sidebar footer with Lock and Quit actions', async () => {
    getTauriInvoke().mockImplementation(async (command: string) => command === 'has_password_verifier')
    settingsMock.loadProfile.mockResolvedValue({
      ownerName: 'Ada Lovelace',
      vaultName: "Ada's Vault",
      setupCompletedAt: '2026-01-01',
    })
    windowMock.close.mockResolvedValue(undefined)
    render(
      <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, navigationStyle: 'sidebar' }}>
        <LockProvider>
          <MemoryRouter initialEntries={['/notes']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="*" element={<RouteMarker />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </LockProvider>
      </PreferencesProvider>,
    )

    const trigger = await screen.findByRole('button', { name: 'Profile menu for Ada Lovelace' })
    expect(within(trigger).getByText('AL')).toBeInTheDocument()
    expect(within(trigger).getByText("Ada's Vault")).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'Lock Kivo' })).toBeNull()

    fireEvent.click(trigger)
    expect(await screen.findByRole('menuitem', { name: 'Lock Kivo' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quit Kivo' }))
    await waitFor(() => expect(windowMock.close).toHaveBeenCalledTimes(1))
  })

  it('leaves Lock Kivo out of the sidebar menu when there is no app lock, and shows Quit in red', async () => {
    getTauriInvoke().mockImplementation(async (command: string) => (command === 'has_password_verifier' ? false : undefined))
    settingsMock.loadProfile.mockResolvedValue({ ownerName: 'Ada Lovelace', vaultName: '', setupCompletedAt: '2026-01-01' })
    render(
      <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, navigationStyle: 'sidebar' }}>
        <LockProvider>
          <MemoryRouter initialEntries={['/notes']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="*" element={<RouteMarker />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </LockProvider>
      </PreferencesProvider>,
    )

    await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('has_password_verifier'))
    fireEvent.click(await screen.findByRole('button', { name: 'Profile menu for Ada Lovelace' }))
    const quit = await screen.findByRole('menuitem', { name: 'Quit Kivo' })
    expect(screen.queryByRole('menuitem', { name: 'Lock Kivo' })).not.toBeInTheDocument()
    expect(quit.querySelector('svg')).toHaveClass('text-danger')
  })

  it('documents the PASSWORDS group with one destination', () => {
    const passwordsGroup = navigationGroups.find((group) => group.label === 'PASSWORDS')

    expect(passwordsGroup).toBeDefined()
    expect(passwordsGroup?.links.map((link) => link.label)).toEqual(['Password Manager'])
    expect(passwordsGroup?.links.map((link) => link.to)).toEqual(['/passwords'])

    renderShell()

    expect(
      within(dock()).getByRole('link', { name: 'Password Manager', exact: true }),
    ).toHaveAttribute('href', '/passwords')
  })

  it('keeps the dock mounted on every route', () => {
    renderShell('/notes')

    expect(screen.getByRole('heading', { name: '/notes' })).toBeInTheDocument()
    expect(within(dock()).getAllByRole('link')).toHaveLength(destinationLabels.length)
  })

  it('omits deferred controls from the navigation shell', () => {
    renderShell()

    expect(dock()).toBeInTheDocument()

    for (const label of deferredControls) {
      expect(screen.queryByRole('link', { name: label, exact: true })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: label, exact: true })).not.toBeInTheDocument()
    }
  })

  it('shows an icon beside every destination', () => {
    renderShell()

    const links = within(dock()).getAllByRole('link')
    expect(links).toHaveLength(destinationLabels.length)

    for (const link of links) {
      expect(link.querySelector('svg')).not.toBeNull()
    }
  })

  it('shows the vault search in the navbar instead of a wordmark', () => {
    renderShell()

    expect(screen.getByRole('button', { name: 'Search the vault' })).toBeInTheDocument()
    expect(screen.queryByText('Kivo')).not.toBeInTheDocument()
  })

  it('tucks the navbar away while the page scrolls down and brings it back on scroll up', () => {
    renderShell()

    const navbar = document.getElementById('kivo-navbar')
    const main = document.getElementById('kivo-main')
    if (!navbar || !main) throw new Error('shell navbar and scroll area were not rendered')

    let scrollTop = 0
    Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => scrollTop })

    // The first stretch of the page keeps the bar in place.
    scrollTop = 20
    fireEvent.scroll(main)
    expect(navbar).not.toHaveAttribute('data-hidden')

    scrollTop = 322
    fireEvent.scroll(main)
    expect(navbar).toHaveAttribute('data-hidden', 'true')

    // Travel below the threshold does not flip the bar back.
    scrollTop = 324
    fireEvent.scroll(main)
    expect(navbar).toHaveAttribute('data-hidden', 'true')

    scrollTop = 300
    fireEvent.scroll(main)
    expect(navbar).not.toHaveAttribute('data-hidden')
  })

  it('drags the dock along with the scroll instead of hiding it', async () => {
    renderShell()

    const dockNav = document.getElementById('kivo-dock-nav')
    const main = document.getElementById('kivo-main')
    if (!dockNav || !main) throw new Error('shell dock and scroll area were not rendered')

    let scrollTop = 0
    Object.defineProperty(main, 'scrollTop', { configurable: true, get: () => scrollTop })

    scrollTop = 400
    fireEvent.scroll(main)

    await waitFor(() => expect(dockNav.style.transform).toMatch(/^translateY\(/))
    expect(dockNav).not.toHaveAttribute('data-hidden')
  })

  it('names dock icons in tooltips instead of visible labels', () => {
    renderShell()

    const nav = dock()

    for (const label of destinationLabels) {
      expect(within(nav).queryByText(label, { exact: true })).not.toBeInTheDocument()
      expect(within(nav).getByRole('link', { name: label, exact: true })).toBeInTheDocument()
    }
  })

  it('toggles the theme from the navbar control', async () => {
    renderShell()

    const toggler = screen.getByRole('button', { name: 'Toggle theme' })
    expect(toggler.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(toggler)

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBe(toggler)

    fireEvent.click(toggler)

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
  })

  it('shows an error toast when the theme change cannot be saved', async () => {
    settingsMock.savePreferences.mockRejectedValueOnce(new Error('save failed'))

    renderShell()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }))

    await waitFor(() =>
      expect(feedbackMock.notifyError).toHaveBeenCalledWith(
        'Kivo could not change the theme. Try again.',
      ),
    )
  })

  it('switches a resolved system theme to an explicit one', async () => {
    act(() => setMediaQueryMatches('(prefers-color-scheme: dark)', true))

    renderShell('/dashboard', { theme: 'system' })

    expect(document.documentElement.dataset.theme).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }))

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
  })

  it('keeps every destination focusable and preserves native Enter activation', async () => {
    renderShell()

    const notesLink = within(dock()).getByRole('link', { name: 'Notes', exact: true })
    const links = within(dock()).getAllByRole('link')

    expect(links.every((link) => link.tabIndex === 0)).toBe(true)
    notesLink.focus()
    expect(document.activeElement).toBe(notesLink)

    const enter = await activateWithEnter(notesLink)
    expect(enter.defaultPrevented).toBe(false)

    await waitFor(() => expect(screen.getByRole('heading', { name: '/notes' })).toBeInTheDocument())
    expect(notesLink).toHaveAttribute('aria-current', 'page')
  })

  it('resolves the system theme from matchMedia and follows change events', async () => {
    act(() => setMediaQueryMatches('(prefers-color-scheme: dark)', true))

    renderShell('/dashboard', { theme: 'system' })

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')

    await act(async () => {
      setMediaQueryMatches('(prefers-color-scheme: dark)', false)
    })

    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'))
  })
})
