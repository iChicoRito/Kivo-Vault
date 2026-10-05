import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T24 phase 1 baseline: capture behavior before link details, duplicate checks,
// and collection suggestions change these flows.

const itemsMock = vi.hoisted(() => ({
  importFile: vi.fn(),
  previewFileImport: vi.fn(),
  commitFileImport: vi.fn(),
  cancelFileImport: vi.fn(),
  listItems: vi.fn(),
  loadItem: vi.fn(),
  moveItemsToCollection: vi.fn(),
  saveItem: vi.fn(),
  trashItems: vi.fn(),
}))

const filesMock = vi.hoisted(() => ({
  openItemFile: vi.fn(),
  pickFiles: vi.fn(),
  revealItemFile: vi.fn(),
}))

const collectionsMock = vi.hoisted(() => ({
  listCollections: vi.fn(),
}))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn(),
  trashManyWithUndo: vi.fn(),
}))

vi.mock('../data/items', () => itemsMock)
vi.mock('../data/files', () => filesMock)
vi.mock('../data/collections', () => collectionsMock)
vi.mock('../data/tags', () => ({ listTags: vi.fn().mockResolvedValue([]) }))
vi.mock('../lib/feedback', () => feedbackMock)

import type { VaultItem } from '../data/items'
import { FilesPage } from '../features/files/FilesPage'
import { SaveSourceDialog } from '../features/sources/SaveSourceDialog'

function source(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: 's1',
    kind: 'source',
    title: 'Example',
    description: 'A summary',
    content: 'My personal note',
    url: 'https://example.com/a',
    collectionId: 'col-1',
    isFavorite: true,
    isPinned: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    tags: [],
    file: null,
    fileMissing: false,
    ...overrides,
  }
}

function renderFiles() {
  return render(
    <MemoryRouter initialEntries={['/files']}>
      <Routes>
        <Route path="/files" element={<FilesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  itemsMock.listItems.mockResolvedValue([])
  itemsMock.saveItem.mockResolvedValue(source())
  collectionsMock.listCollections.mockResolvedValue([])
})

describe('T24 capture baseline: sources', () => {
  it('saves a manual title and description exactly as typed', async () => {
    render(<SaveSourceDialog itemId={null} open onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), {
      target: { value: 'https://example.com/page' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'My title' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'My description' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'source',
          title: 'My title',
          description: 'My description',
          url: 'https://example.com/page',
        }),
      ),
    )
  })

  it('keeps the personal note, collection, and flags when a source is edited', async () => {
    itemsMock.loadItem.mockResolvedValue(source())
    render(<SaveSourceDialog itemId="s1" open onClose={vi.fn()} onSaved={vi.fn()} />)

    const title = await screen.findByRole('textbox', { name: 'Title' })
    fireEvent.change(title, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith({
        id: 's1',
        kind: 'source',
        title: 'Renamed',
        description: 'A summary',
        url: 'https://example.com/a',
        content: 'My personal note',
        collectionId: 'col-1',
        isFavorite: true,
        isPinned: true,
        duplicatePolicy: 'check',
      }),
    )
  })
})

describe('T24 capture baseline: files', () => {
  it('saves nothing when the file picker is cancelled', async () => {
    filesMock.pickFiles.mockResolvedValue(null)
    renderFiles()

    await screen.findByText('No files yet.')
    fireEvent.click(screen.getAllByRole('button', { name: /import files/i })[0])

    await waitFor(() => expect(filesMock.pickFiles).toHaveBeenCalledTimes(1))
    expect(itemsMock.previewFileImport).not.toHaveBeenCalled()
    expect(feedbackMock.notifySuccess).not.toHaveBeenCalled()
    expect(feedbackMock.notifyError).not.toHaveBeenCalled()
  })

  it('keeps successful imports when a later file in the batch fails', async () => {
    filesMock.pickFiles.mockResolvedValue(['C:/a.pdf', 'C:/b.pdf', 'C:/c.pdf'])
    itemsMock.previewFileImport.mockImplementation(async (path: string) => {
      if (path === 'C:/b.pdf') throw new Error('unreadable')
      return { token: path, originalName: path, byteSize: 1, matches: [], accessEpoch: 0 }
    })
    itemsMock.commitFileImport.mockResolvedValue({ status: 'saved', item: source({ kind: 'file' }) })
    renderFiles()

    await screen.findByText('No files yet.')
    fireEvent.click(screen.getAllByRole('button', { name: /import files/i })[0])

    await waitFor(() => expect(feedbackMock.notifyError).toHaveBeenCalledTimes(1))
    expect(itemsMock.previewFileImport.mock.calls.map(([path]) => path)).toEqual([
      'C:/a.pdf',
      'C:/b.pdf',
      'C:/c.pdf',
    ])
    expect(itemsMock.commitFileImport.mock.calls.map(([token]) => token)).toEqual([
      'C:/a.pdf',
      'C:/c.pdf',
    ])
    expect(itemsMock.trashItems).not.toHaveBeenCalled()
    expect(feedbackMock.notifySuccess).not.toHaveBeenCalled()
  })
})
