import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  listItems: vi.fn(), loadItem: vi.fn(), setItemsFavorite: vi.fn(), setItemPinned: vi.fn(),
  moveItemsToCollection: vi.fn(), saveItem: vi.fn(), listCollections: vi.fn(), listTags: vi.fn(),
  previewFileImport: vi.fn(), commitFileImport: vi.fn(), cancelFileImport: vi.fn(),
  openItemFile: vi.fn(), revealItemFile: vi.fn(), openSourceUrl: vi.fn(), pickFiles: vi.fn(),
  trashWithUndo: vi.fn(), trashManyWithUndo: vi.fn(),
  startItemDrag: vi.fn(),
}))
const access = vi.hoisted(() => ({ handlers: new Set<(change: { accessEpoch: number }) => void>() }))

vi.mock('../data/items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/items')>(),
  listItems: backend.listItems, loadItem: backend.loadItem,
  setItemsFavorite: backend.setItemsFavorite, setItemPinned: backend.setItemPinned,
  moveItemsToCollection: backend.moveItemsToCollection, saveItem: backend.saveItem,
  previewFileImport: backend.previewFileImport, commitFileImport: backend.commitFileImport,
  cancelFileImport: backend.cancelFileImport,
}))
vi.mock('../data/collections', () => ({ listCollections: backend.listCollections }))
vi.mock('../data/tags', () => ({ listTags: backend.listTags }))
vi.mock('../data/files', () => ({
  openItemFile: backend.openItemFile, revealItemFile: backend.revealItemFile,
  openSourceUrl: backend.openSourceUrl, pickFiles: backend.pickFiles,
}))
vi.mock('../lib/feedback', () => ({
  notifyError: vi.fn(), notifySuccess: vi.fn(),
  trashWithUndo: backend.trashWithUndo, trashManyWithUndo: backend.trashManyWithUndo,
}))
vi.mock('../features/collections/CollectionFolderPanel', () => ({ CollectionFolderPanel: () => null }))
vi.mock('../features/collections/itemDrag', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/collections/itemDrag')>(),
  startItemDrag: backend.startItemDrag,
}))
vi.mock('../data/events', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/events')>(),
  onCollectionAccessChanged: (handler: (change: { accessEpoch: number }) => void) => {
    access.handlers.add(handler)
    return () => access.handlers.delete(handler)
  },
}))

import { DEFAULT_PREFERENCES, PreferencesProvider } from '../app/preferences'
import { NotesPage } from '../features/notes/NotesPage'
import { FilesPage } from '../features/files/FilesPage'
import { SourcesPage } from '../features/sources/SourcesPage'
import type { Collection } from '../data/collections'
import type { ItemFilter, ItemKind, ItemSummary, VaultItem } from '../data/items'

const COLLECTIONS: Collection[] = [
  { id: 'work', name: 'Work', icon: null, protection: 'none', sortOrder: 0, createdAt: '', itemCount: 6 },
  { id: 'personal', name: 'Personal', icon: null, protection: 'none', sortOrder: 1, createdAt: '', itemCount: 3 },
]
let records: VaultItem[]

function item(kind: ItemKind, suffix: string, overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: `${kind}-${suffix}`, kind, title: `Alpha ${kind} ${suffix}`, description: '',
    content: kind === 'note' ? '<p>Saved note body</p>' : null,
    url: kind === 'source' ? `https://example.com/${suffix}` : null,
    collectionId: 'work', isFavorite: true, isPinned: false,
    createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z',
    tags: ['review'], fileMissing: false,
    file: kind === 'file' ? { originalName: `${suffix}.pdf`, byteSize: 2048, importedAt: '2026-10-03T00:00:00Z' } : null,
    ...overrides,
  }
}

function summary(record: VaultItem): ItemSummary {
  const { id, kind, title, isFavorite, collectionId, updatedAt, fileMissing, isPinned, content, file } = record
  return { id, kind, title, isFavorite, collectionId, updatedAt, fileMissing, isPinned, content, file }
}

beforeEach(() => {
  vi.resetAllMocks()
  records = (['note', 'file', 'source'] as const).flatMap((kind) => [
    item(kind, 'work'),
    item(kind, 'plain', { title: `Plain ${kind}`, isFavorite: false, fileMissing: kind === 'file' }),
    item(kind, 'personal', { title: `Beta ${kind}`, collectionId: 'personal', tags: [], isFavorite: false }),
    item(kind, 'loose', { collectionId: null, tags: [], isFavorite: false }),
  ])
  backend.listCollections.mockResolvedValue(COLLECTIONS)
  backend.listTags.mockResolvedValue([{ name: 'review', count: 6 }])
  backend.listItems.mockImplementation(async (filter: ItemFilter) => records
    .filter((record) => (!filter.kind || record.kind === filter.kind)
      && (!filter.collectionId || record.collectionId === filter.collectionId)
      && (!filter.tag || record.tags.includes(filter.tag))
      && (!filter.favorite || record.isFavorite)
      && (!filter.query || record.title.toLowerCase().includes(filter.query.toLowerCase())))
    .map(summary))
  backend.loadItem.mockImplementation(async (id: string) => records.find((record) => record.id === id))
  backend.setItemsFavorite.mockImplementation(async (ids: string[], favorite: boolean) => {
    records = records.map((record) => ids.includes(record.id) ? { ...record, isFavorite: favorite } : record)
  })
  backend.moveItemsToCollection.mockImplementation(async (ids: string[], collectionId: string | null) => {
    records = records.map((record) => ids.includes(record.id) ? { ...record, collectionId } : record)
  })
  backend.trashWithUndo.mockResolvedValue(true)
  backend.trashManyWithUndo.mockResolvedValue(true)
  backend.pickFiles.mockResolvedValue(null)
  backend.previewFileImport.mockImplementation(async (path: string) => ({
    token: path, originalName: path, byteSize: 2048, matches: [], accessEpoch: 0,
  }))
})

function renderPage(kind: ItemKind) {
  const Page = kind === 'note' ? NotesPage : kind === 'file' ? FilesPage : SourcesPage
  return render(
    <MemoryRouter initialEntries={[`/${kind === 'source' ? 'sources' : `${kind}s`}`]}>
      <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, notesView: 'list' }}>
        <Page />
      </PreferencesProvider>
    </MemoryRouter>,
  )
}

async function choose(submenu: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  const trigger = await screen.findByRole('menuitem', { name: submenu })
  act(() => trigger.focus())
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })
  const entry = await screen.findByRole('menuitemradio', { name: option })
  fireEvent.keyDown(entry, { key: 'Enter' })
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
}

function openRow(title: string) {
  fireEvent.contextMenu(screen.getByText(title))
}

describe.each(['note', 'file', 'source'] as const)('%s Library page filters', (kind) => {
  it('shows only its own kind and does not expose Kind selection', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind })
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent(/^Filters$/)
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    await screen.findByRole('menuitem', { name: 'Collection' })
    expect(screen.queryByRole('menuitem', { name: 'Kind' })).not.toBeInTheDocument()
  })

  it('combines collection, tag, and Favorites and restores the list on clear', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    await choose('Collection', 'Work')
    await screen.findByText(`Plain ${kind}`)
    expect(screen.queryByText(`Beta ${kind}`)).not.toBeInTheDocument()
    await choose('Tag', 'review')
    await choose('Favorites', 'Favorites only')
    await screen.findByText(`Alpha ${kind} work`)
    expect(screen.queryByText(`Plain ${kind}`)).not.toBeInTheDocument()
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind, collectionId: 'work', tag: 'review', favorite: true })
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear filters' }))
    expect(await screen.findByText(`Beta ${kind}`)).toBeInTheDocument()
    expect(await screen.findByText(`Alpha ${kind} loose`)).toBeInTheDocument()
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind })
  })

  it('keeps controls available when active filters match nothing', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    await choose('Collection', 'Personal')
    await choose('Tag', 'review')
    expect(await screen.findByRole('heading', { name: kind === 'file' ? 'No files match your filters.' : `No ${kind === 'note' ? 'notes' : 'sources'} match your search or filters.` }))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText(`Alpha ${kind} work`)).toBeInTheDocument()
  })

  it('retries a filtered item failure without clearing criteria', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    backend.listItems.mockRejectedValueOnce(new Error('offline'))
    await choose('Collection', 'Work')
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByText(`Alpha ${kind} work`)
    expect(screen.queryByText(`Beta ${kind}`)).not.toBeInTheDocument()
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind, collectionId: 'work' })
  })

  it('hides cached rows after access denial and offers collection recovery', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    backend.listItems.mockRejectedValueOnce(new Error('This collection is locked'))
    await choose('Collection', 'Work')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This collection is locked')
    expect(screen.queryByText(`Alpha ${kind} work`)).not.toBeInTheDocument()
    expect(within(alert).getByRole('link', { name: 'Open Collections' })).toHaveAttribute('href', '/collections')
    fireEvent.click(within(alert).getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText(`Alpha ${kind} work`)).toBeInTheDocument()
  })

  it('ignores an older item request after a newer filter result arrives', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    let resolveOld!: (items: ItemSummary[]) => void
    backend.listItems.mockReturnValueOnce(new Promise<ItemSummary[]>((resolve) => { resolveOld = resolve }))
    await choose('Collection', 'Work')
    expect(screen.queryByText(`Alpha ${kind} work`)).not.toBeInTheDocument()
    await choose('Collection', 'Personal')
    await screen.findByText(`Beta ${kind}`)
    await act(async () => resolveOld([summary(records.find((record) => record.id === `${kind}-work`)!)]))
    expect(screen.queryByText(`Alpha ${kind} work`)).not.toBeInTheDocument()
    expect(screen.getByText(`Beta ${kind}`)).toBeInTheDocument()
  })

  it('drops selection when criteria change so hidden IDs cannot be bulk-actioned', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    openRow(`Alpha ${kind} work`)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))
    expect(await screen.findByRole('toolbar', { name: 'Selection' })).toHaveTextContent('1 selected')
    await choose('Collection', 'Personal')
    await screen.findByText(`Beta ${kind}`)
    expect(screen.queryByRole('toolbar', { name: 'Selection' })).not.toBeInTheDocument()
    expect(backend.trashManyWithUndo).not.toHaveBeenCalled()

    openRow(`Beta ${kind}`)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))
    const row = screen.getByText(`Beta ${kind}`).closest('[data-item-drag-id]')!
    fireEvent.pointerDown(row)
    expect(backend.startItemDrag).toHaveBeenLastCalledWith(expect.anything(), [`${kind}-personal`])
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selection' })).getByRole('button', { name: 'Move to Trash' }))
    const confirm = await screen.findByRole('dialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Move to trash' }))
    await waitFor(() => expect(backend.trashManyWithUndo).toHaveBeenCalledWith([`${kind}-personal`]))
  })

  it('refreshes matching rows on vault writes and collection access changes', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    await choose('Collection', 'Work')
    records.push(item(kind, 'added'))
    act(() => window.dispatchEvent(new Event('kivo:vault-changed')))
    expect(await screen.findByText(`Alpha ${kind} added`)).toBeInTheDocument()
    records = records.filter((record) => record.id !== `${kind}-work`)
    act(() => access.handlers.forEach((handler) => handler({ accessEpoch: 1 })))
    await waitFor(() => expect(screen.queryByText(`Alpha ${kind} work`)).not.toBeInTheDocument())
    expect(await screen.findByText(`Alpha ${kind} added`)).toBeInTheDocument()
  })

  it('removes a moved row from its active collection results', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    await choose('Collection', 'Work')
    openRow(`Alpha ${kind} work`)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to collection' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Work Collection' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Personal' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(backend.moveItemsToCollection).toHaveBeenCalledWith([`${kind}-work`], 'personal'))
    await waitFor(() => expect(screen.queryByText(`Alpha ${kind} work`)).not.toBeInTheDocument())
    expect(await screen.findByText(`Plain ${kind}`)).toBeInTheDocument()
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind, collectionId: 'work' })
  })

  it('ignores an older request rejected after a newer access refresh succeeds', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    let rejectOld!: (error: Error) => void
    backend.listItems.mockReturnValueOnce(new Promise<ItemSummary[]>((_, reject) => { rejectOld = reject }))
    act(() => access.handlers.forEach((handler) => handler({ accessEpoch: 2 })))
    act(() => access.handlers.forEach((handler) => handler({ accessEpoch: 3 })))
    await screen.findByText(`Alpha ${kind} work`)
    await act(async () => rejectOld(new Error('This collection is locked')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(`Alpha ${kind} work`)).toBeInTheDocument()
  })
})

describe.each(['note', 'source'] as const)('%s search with filters', (kind) => {
  it('uses trimmed search with all filters and preserves search on clear', async () => {
    renderPage(kind)
    await screen.findByText(`Alpha ${kind} work`)
    fireEvent.change(screen.getByRole('textbox', { name: kind === 'note' ? 'Search notes' : 'Search link' }), { target: { value: '  Alpha  ' } })
    await choose('Collection', 'Work')
    await choose('Tag', 'review')
    await choose('Favorites', 'Favorites only')
    await screen.findByText(`Alpha ${kind} work`)
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind, query: 'Alpha', collectionId: 'work', tag: 'review', favorite: true })
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear filters' }))
    expect(await screen.findByText(`Alpha ${kind} loose`)).toBeInTheDocument()
    expect(screen.queryByText(`Beta ${kind}`)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('  Alpha  ')
    expect(backend.listItems).toHaveBeenLastCalledWith({ kind, query: 'Alpha' })
  })
})

it('removes a note from Favorites-only results after unfavoriting it', async () => {
  renderPage('note')
  await screen.findByText('Alpha note work')
  await choose('Favorites', 'Favorites only')
  openRow('Alpha note work')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove favorite' }))
  expect(await screen.findByRole('heading', { name: 'No notes match your search or filters.' })).toBeInTheDocument()
})

it('keeps missing-file actions disabled in filtered results without adding Files search', async () => {
  renderPage('file')
  await screen.findByText('Plain file')
  await choose('Collection', 'Work')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText('File is missing')).toBeInTheDocument()
  openRow('Plain file')
  expect(await screen.findByRole('menuitem', { name: 'Open' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: 'Reveal' })).toHaveAttribute('aria-disabled', 'true')
})

it('loads full source records only for returned summaries and retries full-record failures', async () => {
  renderPage('source')
  await screen.findByText('Alpha source work')
  backend.loadItem.mockClear()
  backend.loadItem.mockRejectedValueOnce(new Error('read failed'))
  await choose('Favorites', 'Favorites only')
  const alert = await screen.findByRole('alert')
  expect(backend.loadItem).toHaveBeenCalledWith('source-work')
  expect(backend.loadItem).not.toHaveBeenCalledWith('source-personal')
  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('https://example.com/work')).toBeInTheDocument()
  expect(screen.queryByText('Beta source')).not.toBeInTheDocument()
})

it('keeps imported files outside an active collection hidden until filters clear', async () => {
  backend.pickFiles.mockResolvedValue(['imported.pdf'])
  backend.commitFileImport.mockImplementation(async () => {
    const imported = item('file', 'imported', { collectionId: null })
    records.push(imported)
    return { status: 'saved', item: imported }
  })
  renderPage('file')
  await screen.findByText('Alpha file work')
  await choose('Collection', 'Work')
  fireEvent.click(screen.getByRole('button', { name: 'Import files', exact: true }))
  await waitFor(() => expect(backend.commitFileImport).toHaveBeenCalledWith('imported.pdf', null, 'check'))
  await waitFor(() => expect(backend.listItems).toHaveBeenCalledTimes(3))
  expect(await screen.findByText('Alpha file work')).toBeInTheDocument()
  expect(screen.queryByText('Alpha file imported')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear filters' }))
  expect(await screen.findByText('Alpha file imported')).toBeInTheDocument()
})
