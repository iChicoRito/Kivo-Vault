import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  initializeDatabase: vi.fn(),
  loadBootState: vi.fn(),
  completeSetup: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  readAppLockVerifier: vi.fn(),
  setAppLock: vi.fn(),
  removeAppLock: vi.fn(),
  hasAppLock: vi.fn(),
}))

const settings = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
}))

const itemsData = vi.hoisted(() => ({
  listItems: vi.fn(),
  loadItem: vi.fn(),
  saveItem: vi.fn(),
  setItemPinned: vi.fn(),
  setItemsFavorite: vi.fn(),
  moveItemsToCollection: vi.fn(),
  trashItems: vi.fn(),
  restoreItems: vi.fn(),
  deleteItemsPermanently: vi.fn(),
  importFile: vi.fn(),
  setItemTags: vi.fn(),
}))

const collectionsData = vi.hoisted(() => ({
  listCollections: vi.fn(),
  saveCollection: vi.fn(),
  deleteCollection: vi.fn(),
}))

const dashboardData = vi.hoisted(() => ({
  loadVaultSummary: vi.fn(),
}))

const protectionData = vi.hoisted(() => ({
  readProtectionState: vi.fn(),
  unlockVault: vi.fn(),
  lockVault: vi.fn(),
}))

vi.mock('../data/database', () => ({
  initializeDatabase: boot.initializeDatabase,
}))

vi.mock('../data/settings', () => settings)
vi.mock('../data/protection', () => protectionData)

vi.mock('../data/items', () => itemsData)
vi.mock('../data/collections', () => collectionsData)
vi.mock('../data/dashboard', () => dashboardData)

vi.mock('../data/setup', () => ({
  loadBootState: boot.loadBootState,
  completeSetup: boot.completeSetup,
}))

vi.mock('../data/security', () => ({
  hashPassword: boot.hashPassword,
  verifyPassword: boot.verifyPassword,
  readAppLockVerifier: boot.readAppLockVerifier,
  setAppLock: boot.setAppLock,
  removeAppLock: boot.removeAppLock,
  hasAppLock: boot.hasAppLock,
}))

import App from '../App'

const VERIFIER = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'

const EMPTY_SUMMARY = {
  itemCount: 0,
  noteCount: 0,
  sourceCount: 0,
  fileCount: 0,
  favoriteCount: 0,
  collectionCount: 0,
  tagCount: 0,
  trashCount: 0,
  fileBytes: 0,
  databaseBytes: 0,
}

function resetBoot() {
  for (const mock of Object.values(boot)) mock.mockReset()
  for (const mock of Object.values(protectionData)) mock.mockReset()

  for (const mock of [
    ...Object.values(itemsData),
    ...Object.values(collectionsData),
    ...Object.values(dashboardData),
  ]) {
    mock.mockReset()
  }

  protectionData.readProtectionState.mockResolvedValue({
    lockEnabled: true,
    encryptionEnabled: false,
  })
  protectionData.unlockVault.mockResolvedValue(true)
  protectionData.lockVault.mockResolvedValue(undefined)

  itemsData.listItems.mockResolvedValue([])
  itemsData.loadItem.mockResolvedValue(undefined)
  collectionsData.listCollections.mockResolvedValue([])
  dashboardData.loadVaultSummary.mockResolvedValue({ ...EMPTY_SUMMARY })

  settings.loadPreferences.mockReset()
  settings.savePreferences.mockReset()
  settings.loadPreferences.mockResolvedValue({
    theme: 'system',
    density: 'comfortable',
    startAtLogin: false,
  })
  settings.savePreferences.mockResolvedValue(undefined)
}

function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

// Onboarding opens on a 5 s logo intro. Only setTimeout is faked, so React's
// scheduler (setImmediate) and the boot promises keep running for real.
function fakeIntroTimer() {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
}

// The intro timer starts in an effect, so flush pending effects before advancing.
async function passIntro() {
  try {
    await act(async () => {})
    act(() => {
      vi.advanceTimersByTime(5000)
    })
  } finally {
    vi.useRealTimers()
  }
}

async function finishOnboarding() {
  fireEvent.click(screen.getByRole('button', { name: 'Get Started' }))
  typeInto(screen.getByLabelText('Your name'), 'Ada')
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

  await screen.findByRole('heading', { name: 'Congrats! Your vault has been created' })

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: "Let's Go!" }))
  })
}

describe('App root', () => {
  beforeEach(resetBoot)

  it('renders the app landmark and initializes local startup', () => {
    boot.initializeDatabase.mockReturnValue(new Promise(() => undefined))

    render(<App />)

    expect(screen.getByRole('main', { name: 'Kivo application' })).toBeInTheDocument()
    expect(boot.initializeDatabase).toHaveBeenCalledTimes(1)
    expect(boot.loadBootState).not.toHaveBeenCalled()
  })

  it('shows a loading status while local startup is pending', () => {
    boot.initializeDatabase.mockReturnValue(new Promise(() => undefined))

    render(<App />)

    expect(screen.getByRole('heading', { name: 'Opening Kivo', exact: true })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Opening Kivo')
  })

  it('shows retryable diagnostics when local startup fails', async () => {
    boot.initializeDatabase.mockRejectedValue(new Error('SQLite startup failed'))

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Kivo could not start', exact: true }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
    expect(screen.getByText('SQLite startup failed', { exact: true })).toBeInTheDocument()
  })

  it('retries startup and recovers to the ready shell', async () => {
    const startupError = new Error('SQLite startup failed')
    boot.initializeDatabase.mockRejectedValueOnce(startupError).mockResolvedValueOnce({})
    boot.loadBootState.mockResolvedValue('ready')

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }))

    await waitFor(() => expect(boot.initializeDatabase).toHaveBeenCalledTimes(2))
    expect(boot.loadBootState).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument()
  })

  it('routes a fresh local database to onboarding without the shell', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('onboarding')

    fakeIntroTimer()
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Kivo', exact: true })).toBeInTheDocument()
    await passIntro()
    expect(
      screen.getByRole('heading', {
        name: 'Everything important, in one place.',
        exact: true,
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Kivo application' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('opens the shell after onboarding completes', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('onboarding')
    boot.completeSetup.mockResolvedValue(undefined)

    fakeIntroTimer()
    render(<App />)

    await screen.findByRole('heading', { name: 'Kivo', exact: true })
    await passIntro()

    await finishOnboarding()

    expect(await screen.findByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard', exact: true }),
    ).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Kivo application' })).toBeInTheDocument()
  })

  it('routes completed setup without a lock straight to the application shell', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('ready')

    render(<App />)

    expect(await screen.findByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard', exact: true }),
    ).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Kivo application' })).toBeInTheDocument()
  })

  it('applies saved preferences to the document at startup instead of defaults', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('ready')
    settings.loadPreferences.mockResolvedValue({
      theme: 'dark',
      density: 'compact',
      startAtLogin: false,
    })

    render(<App />)

    await screen.findByRole('navigation', { name: 'Primary navigation' })

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  it('shows the unlock page without the shell when a verifier exists', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('locked')

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Unlock your vault', exact: true }),
    ).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Kivo application' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('reveals the shell only after the password verifies', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('locked')
    boot.readAppLockVerifier.mockResolvedValue(VERIFIER)
    protectionData.unlockVault.mockResolvedValue(true)

    render(<App />)

    const passwordField = await screen.findByLabelText('Master Password')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()

    typeInto(passwordField, 'hunter two')
    fireEvent.submit(passwordField.closest('form')!)

    expect(await screen.findByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(protectionData.unlockVault).toHaveBeenCalledWith('hunter two')
  })

  it('keeps the unlock page when the password is rejected', async () => {
    boot.initializeDatabase.mockResolvedValue({})
    boot.loadBootState.mockResolvedValue('locked')
    boot.readAppLockVerifier.mockResolvedValue(VERIFIER)
    protectionData.unlockVault.mockResolvedValue(false)

    render(<App />)

    const passwordField = await screen.findByLabelText('Master Password')
    typeInto(passwordField, 'wrong password')
    fireEvent.submit(passwordField.closest('form')!)

    expect(await screen.findByText('That password did not match. Try again.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})
