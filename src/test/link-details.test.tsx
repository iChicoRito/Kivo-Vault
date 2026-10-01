import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const itemsMock = vi.hoisted(() => ({
  loadItem: vi.fn(),
  saveItem: vi.fn(),
}))

const linkMock = vi.hoisted(() => ({
  fetchLinkDetails: vi.fn(),
}))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))

const settingsMock = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
}))

vi.mock('../data/items', () => itemsMock)
vi.mock('../data/linkDetails', () => linkMock)
vi.mock('../lib/feedback', () => feedbackMock)
vi.mock('../data/settings', () => settingsMock)

import type { LinkDetails } from '../data/linkDetails'
import type { VaultItem } from '../data/items'
import type { ReactNode } from 'react'
import { DEFAULT_PREFERENCES, PreferencesProvider } from '../app/preferences'
import { SaveSourceDialog } from '../features/sources/SaveSourceDialog'

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function details(overrides: Partial<LinkDetails> = {}): LinkDetails {
  return {
    requestedUrl: 'https://example.com/a',
    title: 'Fetched title',
    description: 'Fetched description',
    ...overrides,
  }
}

const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } })

function withPreferences(linkDetails = true) {
  return ({ children }: { children: ReactNode }) => (
    <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, linkDetails }}>
      {children}
    </PreferencesProvider>
  )
}

function renderNew(linkDetails = true) {
  return render(<SaveSourceDialog itemId={null} open onClose={vi.fn()} onSaved={vi.fn()} />, {
    wrapper: withPreferences(linkDetails),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  itemsMock.saveItem.mockResolvedValue({})
  settingsMock.savePreferences.mockImplementation(async (value) => value)
})

describe('SaveSourceDialog link details', () => {
  it('fills title and description after an address is pasted, and both stay editable', async () => {
    linkMock.fetchLinkDetails.mockResolvedValue(details())
    renderNew()

    type('Address', 'https://example.com/a')

    await waitFor(() => expect(field('Title')).toHaveValue('Fetched title'))
    expect(field('Description')).toHaveValue('Fetched description')
    expect(linkMock.fetchLinkDetails).toHaveBeenCalledWith('https://example.com/a')

    type('Title', 'My edit')
    expect(field('Title')).toHaveValue('My edit')
  })

  it('shows a loading line and keeps a title typed while the request runs', async () => {
    const pending = deferred<LinkDetails>()
    linkMock.fetchLinkDetails.mockReturnValue(pending.promise)
    renderNew()

    type('Address', 'https://example.com/a')
    expect(await screen.findByText('Fetching link details...')).toBeInTheDocument()
    type('Title', 'Typed by me')
    pending.resolve(details())

    await waitFor(() => expect(field('Description')).toHaveValue('Fetched description'))
    expect(field('Title')).toHaveValue('Typed by me')
    expect(screen.queryByText('Fetching link details...')).not.toBeInTheDocument()
  })

  it('ignores a late answer for an address that was replaced', async () => {
    const first = deferred<LinkDetails>()
    const second = deferred<LinkDetails>()
    linkMock.fetchLinkDetails.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    renderNew()

    type('Address', 'https://a.example.com')
    await waitFor(() => expect(linkMock.fetchLinkDetails).toHaveBeenCalledTimes(1))
    type('Address', 'https://b.example.com')
    await waitFor(() => expect(linkMock.fetchLinkDetails).toHaveBeenCalledTimes(2))

    second.resolve(details({ requestedUrl: 'https://b.example.com', title: 'B' }))
    await waitFor(() => expect(field('Title')).toHaveValue('B'))
    first.resolve(details({ requestedUrl: 'https://a.example.com', title: 'A' }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(field('Title')).toHaveValue('B')
  })

  it('ignores an answer that arrives after the dialog closed and reopened', async () => {
    const pending = deferred<LinkDetails>()
    linkMock.fetchLinkDetails.mockReturnValue(pending.promise)
    const view = renderNew()

    type('Address', 'https://example.com/a')
    await waitFor(() => expect(linkMock.fetchLinkDetails).toHaveBeenCalledTimes(1))
    view.rerender(<SaveSourceDialog itemId={null} open={false} onClose={vi.fn()} onSaved={vi.fn()} />)
    view.rerender(<SaveSourceDialog itemId={null} open onClose={vi.fn()} onSaved={vi.fn()} />)
    pending.resolve(details())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(field('Title')).toHaveValue('')
    expect(field('Description')).toHaveValue('')
  })

  it('leaves existing values when the page has no metadata', async () => {
    linkMock.fetchLinkDetails.mockResolvedValue(details({ title: null, description: null }))
    renderNew()

    type('Description', 'Kept description')
    type('Address', 'https://example.com/a')

    await waitFor(() => expect(linkMock.fetchLinkDetails).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(field('Description')).toHaveValue('Kept description')
    expect(field('Title')).toHaveValue('')
  })

  it('replaces values it filled itself when the address changes', async () => {
    linkMock.fetchLinkDetails
      .mockResolvedValueOnce(details({ title: 'First' }))
      .mockResolvedValueOnce(details({ title: 'Second' }))
    renderNew()

    type('Address', 'https://a.example.com')
    await waitFor(() => expect(field('Title')).toHaveValue('First'))
    type('Address', 'https://b.example.com')

    await waitFor(() => expect(field('Title')).toHaveValue('Second'))
  })

  it('shows a failure with Retry and still lets the source be saved', async () => {
    linkMock.fetchLinkDetails
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(details())
    renderNew()

    type('Address', 'https://example.com/a')
    expect(
      await screen.findByText('Kivo could not fetch details for this link. You can type them yourself.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(field('Title')).toHaveValue('Fetched title'))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Fetched title', url: 'https://example.com/a' }),
      ),
    )
  })

  it('saves manual values while a request is still running and ignores its answer', async () => {
    const pending = deferred<LinkDetails>()
    linkMock.fetchLinkDetails.mockReturnValue(pending.promise)
    renderNew()

    type('Address', 'https://example.com/a')
    await waitFor(() => expect(linkMock.fetchLinkDetails).toHaveBeenCalledTimes(1))
    type('Title', 'Manual')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Manual' })),
    )
    pending.resolve(details())
  })

  it('does not fetch when an existing source loads, only after its address changes', async () => {
    const item: VaultItem = {
      id: 's1',
      kind: 'source',
      title: 'Saved title',
      description: 'Saved description',
      content: '',
      url: 'https://example.com/old',
      collectionId: null,
      isFavorite: false,
      isPinned: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      tags: [],
      file: null,
      fileMissing: false,
    }
    itemsMock.loadItem.mockResolvedValue(item)
    linkMock.fetchLinkDetails.mockResolvedValue(details({ title: 'New page title' }))
    render(<SaveSourceDialog itemId="s1" open onClose={vi.fn()} onSaved={vi.fn()} />, {
      wrapper: withPreferences(),
    })

    await waitFor(() => expect(field('Title')).toHaveValue('Saved title'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(linkMock.fetchLinkDetails).not.toHaveBeenCalled()

    type('Address', 'https://example.com/new')
    await waitFor(() => expect(linkMock.fetchLinkDetails).toHaveBeenCalledWith('https://example.com/new'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(field('Title')).toHaveValue('Saved title')
  })

  it('explains the network request and saves the switch as a preference', async () => {
    renderNew()

    expect(
      screen.getByText(/Pasting a link contacts that website to read its title and description/),
    ).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Fetch link details automatically' })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(settingsMock.savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ linkDetails: false }),
    )
  })

  it('sends nothing when the saved preference is off', async () => {
    renderNew(false)

    expect(screen.getByRole('switch', { name: 'Fetch link details automatically' })).not.toBeChecked()
    type('Address', 'https://example.com/a')
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(linkMock.fetchLinkDetails).not.toHaveBeenCalled()
  })
})
