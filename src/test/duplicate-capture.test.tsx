import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const itemsMock = vi.hoisted(() => ({
  listItems: vi.fn(),
  loadItem: vi.fn(),
  saveItem: vi.fn(),
  setItemTags: vi.fn(),
  moveItemsToCollection: vi.fn(),
  trashItems: vi.fn(),
  previewFileImport: vi.fn(),
  commitFileImport: vi.fn(),
  cancelFileImport: vi.fn(),
}))

const filesMock = vi.hoisted(() => ({
  pickFiles: vi.fn(),
  openItemFile: vi.fn(),
  revealItemFile: vi.fn(),
}))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn(),
  trashManyWithUndo: vi.fn(),
}))

const eventsMock = vi.hoisted(() => ({
  handlers: [] as Array<(change: { accessEpoch: number }) => void>,
}))

vi.mock('../data/items', async () => {
  const actual = await vi.importActual<typeof import('../data/items')>('../data/items')
  return { ...itemsMock, DuplicateConflictError: actual.DuplicateConflictError }
})
vi.mock('../data/files', () => filesMock)
vi.mock('../data/collections', () => ({ listCollections: vi.fn().mockResolvedValue([]) }))
vi.mock('../data/linkDetails', () => ({ fetchLinkDetails: vi.fn() }))
vi.mock('../data/settings', () => ({ loadPreferences: vi.fn(), savePreferences: vi.fn() }))
vi.mock('../lib/feedback', () => feedbackMock)
vi.mock('../data/events', async () => {
  const actual = await vi.importActual<typeof import('../data/events')>('../data/events')
  return {
    ...actual,
    onCollectionAccessChanged: (handler: (change: { accessEpoch: number }) => void) => {
      eventsMock.handlers.push(handler)
      return () => undefined
    },
  }
})

import { DEFAULT_PREFERENCES, PreferencesProvider } from '../app/preferences'
import { DuplicateConflictError, type DuplicateMatch, type VaultItem } from '../data/items'
import { FilesPage } from '../features/files/FilesPage'
import { SaveSourceDialog } from '../features/sources/SaveSourceDialog'

function vaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 'saved-1',
    kind: 'source',
    title: 'Saved page',
    description: '',
    content: '',
    url: 'https://example.com/a',
    collectionId: null,
    isFavorite: false,
    isPinned: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tags: [],
    file: null,
    fileMissing: false,
    ...overrides,
  }
}

function match(overrides: Partial<VaultItem> = {}, reason: DuplicateMatch['reason'] = 'url'): DuplicateMatch {
  const item = vaultItem(overrides)
  return { item: { ...item, deletedAt: null }, reason }
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, linkDetails: false }}>
        {children}
      </PreferencesProvider>
    </MemoryRouter>
  )
}

function fillSource() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), {
    target: { value: 'https://example.com/a' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  eventsMock.handlers.length = 0
  itemsMock.listItems.mockResolvedValue([])
  itemsMock.loadItem.mockResolvedValue(vaultItem())
  itemsMock.cancelFileImport.mockResolvedValue(undefined)
})

describe('Saving a source that is already saved', () => {
  function renderSource() {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    render(<SaveSourceDialog itemId={null} open onClose={onClose} onSaved={onSaved} />, {
      wrapper: Providers,
    })
    return { onClose, onSaved }
  }

  beforeEach(() => {
    itemsMock.saveItem.mockImplementation(async (input: { duplicatePolicy?: string }) => {
      if (input.duplicatePolicy !== 'keepBoth') throw new DuplicateConflictError([match()], 4)
      return vaultItem({ id: 'new' })
    })
  })

  it('asks before saving and Keep both saves the same draft once more', async () => {
    const { onSaved } = renderSource()
    fillSource()

    expect(await screen.findByText('This link is already in Kivo')).toBeInTheDocument()
    expect(screen.getByText('Saved page')).toBeInTheDocument()
    expect(screen.getByText('Same address')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Keep both' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(itemsMock.saveItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Draft', url: 'https://example.com/a', duplicatePolicy: 'keepBoth' }),
    )
  })

  it('Skip closes without saving', async () => {
    const { onClose, onSaved } = renderSource()
    fillSource()

    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
    expect(itemsMock.saveItem).toHaveBeenCalledTimes(1)
  })

  it('Open existing shows the saved item in Kivo and saves nothing', async () => {
    const { onSaved } = renderSource()
    fillSource()

    fireEvent.click(await screen.findByRole('button', { name: 'Open existing' }))

    await waitFor(() => expect(itemsMock.loadItem).toHaveBeenCalledWith('saved-1'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(itemsMock.saveItem).toHaveBeenCalledTimes(1)
    expect(filesMock.openItemFile).not.toHaveBeenCalled()
  })

  it('hides matches when a collection locks or unlocks while deciding', async () => {
    renderSource()
    fillSource()
    await screen.findByText('Saved page')

    act(() => eventsMock.handlers.forEach((handler) => handler({ accessEpoch: 5 })))

    expect(screen.queryByText('Saved page')).not.toBeInTheDocument()
    expect(screen.getByText(/Kivo hid these matches/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open existing' })).toBeDisabled()
  })
})

describe('Importing files that are already saved', () => {
  const fileMatch = match({ id: 'old-file', kind: 'file', title: 'report.pdf' }, 'file-content')

  function preview(path: string, matches: DuplicateMatch[] = []) {
    return { token: `t-${path}`, originalName: path, byteSize: 3, matches, accessEpoch: 1 }
  }

  async function startImport(paths: string[]) {
    filesMock.pickFiles.mockResolvedValue(paths)
    render(<FilesPage />, { wrapper: Providers })
    await screen.findByText('No files yet.')
    fireEvent.click(screen.getAllByRole('button', { name: /import files/i })[0])
  }

  beforeEach(() => {
    itemsMock.commitFileImport.mockResolvedValue({ status: 'saved', item: vaultItem({ kind: 'file' }) })
  })

  it('Skip leaves the duplicate out and reports it, without counting a failure', async () => {
    itemsMock.previewFileImport.mockImplementation(async (path: string) =>
      preview(path, path === 'b.pdf' ? [fileMatch] : []),
    )
    await startImport(['a.pdf', 'b.pdf'])

    expect(await screen.findByText('This file is already in Kivo')).toBeInTheDocument()
    expect(screen.getByText('Same file contents')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    await waitFor(() => expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Imported 1 file, skipped 1.'))
    expect(itemsMock.commitFileImport).toHaveBeenCalledTimes(1)
    expect(itemsMock.cancelFileImport).toHaveBeenCalledWith('t-b.pdf')
    expect(feedbackMock.notifyError).not.toHaveBeenCalled()
  })

  it('Keep both saves the staged file with the keep-both choice', async () => {
    itemsMock.previewFileImport.mockImplementation(async (path: string) => preview(path, [fileMatch]))
    await startImport(['b.pdf'])

    fireEvent.click(await screen.findByRole('button', { name: 'Keep both' }))

    await waitFor(() => expect(itemsMock.commitFileImport).toHaveBeenCalledWith('t-b.pdf', null, 'keepBoth'))
    await waitFor(() => expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('File imported'))
  })

  it('a duplicate found at save time (same file earlier in the batch) also asks', async () => {
    itemsMock.previewFileImport.mockImplementation(async (path: string) => preview(path))
    itemsMock.commitFileImport
      .mockResolvedValueOnce({ status: 'saved', item: vaultItem({ kind: 'file' }) })
      .mockResolvedValueOnce({ status: 'duplicate', matches: [fileMatch], accessEpoch: 1 })
    await startImport(['a.pdf', 'a-copy.pdf'])

    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Imported 1 file, skipped 1.'))
  })

  it('Stop import leaves the remaining files untouched', async () => {
    itemsMock.previewFileImport.mockImplementation(async (path: string) =>
      preview(path, path === 'a.pdf' ? [fileMatch] : []),
    )
    await startImport(['a.pdf', 'b.pdf', 'c.pdf'])

    fireEvent.click(await screen.findByRole('button', { name: 'Stop import' }))

    await waitFor(() => expect(itemsMock.cancelFileImport).toHaveBeenCalledWith('t-a.pdf'))
    expect(itemsMock.previewFileImport).toHaveBeenCalledTimes(1)
    expect(itemsMock.commitFileImport).not.toHaveBeenCalled()
  })
})
