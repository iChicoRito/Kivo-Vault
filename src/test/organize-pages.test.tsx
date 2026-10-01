import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { ItemSummary, VaultItem } from '../data/items'
import type { Collection } from '../data/collections'
import type { Preferences } from '../data/settings'

const itemsMock = vi.hoisted(() => ({
  saveItem: vi.fn(),
  loadItem: vi.fn(),
  listItems: vi.fn(),
  setItemPinned: vi.fn(),
  setItemsFavorite: vi.fn(),
  moveItemsToCollection: vi.fn(),
  trashItems: vi.fn(),
  importFile: vi.fn(),
  previewFileImport: vi.fn(),
  commitFileImport: vi.fn(),
  cancelFileImport: vi.fn(),
  setItemTags: vi.fn(),
}))

const filesMock = vi.hoisted(() => ({
  pickFile: vi.fn(),
  pickFiles: vi.fn(),
  openItemFile: vi.fn(),
  revealItemFile: vi.fn(),
  openSourceUrl: vi.fn(),
}))

const collectionsMock = vi.hoisted(() => ({
  listCollections: vi.fn(),
  saveCollection: vi.fn(),
  deleteCollection: vi.fn(),
  verifyCollectionSecret: vi.fn(),
  lockCollection: vi.fn(),
}))

const settingsMock = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
}))

const dashboardMock = vi.hoisted(() => ({
  loadVaultSummary: vi.fn(),
}))

const navigateMock = vi.hoisted(() => vi.fn())
const sourceDialogMock = vi.hoisted(() =>
  vi.fn((_props: { open: boolean; itemId: string | null }) => null),
)

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn(),
}))

const portabilityMock = vi.hoisted(() => ({
  pickSaveFile: vi.fn(),
  pickFolderDestination: vi.fn(),
  exportNoteMarkdown: vi.fn(),
  exportItemsJson: vi.fn(),
  exportVaultJson: vi.fn(),
  importJson: vi.fn(),
  importMarkdown: vi.fn(),
}))

vi.mock('../features/collections/CollectionFolderPanel', () => ({ CollectionFolderPanel: () => null }))
vi.mock('../data/items', () => itemsMock)
vi.mock('../data/files', () => filesMock)
vi.mock('../data/collections', () => collectionsMock)
vi.mock('../data/settings', () => settingsMock)
vi.mock('../data/dashboard', () => dashboardMock)
vi.mock('../data/portability', () => portabilityMock)
vi.mock('../lib/feedback', () => feedbackMock)
vi.mock('../features/sources/SaveSourceDialog', () => ({ default: sourceDialogMock }))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateMock }
})

import { DEFAULT_PREFERENCES, PreferencesProvider } from '../app/preferences'
import { FilesPage } from '../features/files/FilesPage'
import { CollectionsPage } from '../features/collections/CollectionsPage'
import { QuickAddDialog } from '../features/quick-add/QuickAddDialog'
import DashboardPage from '../features/dashboard/DashboardPage'

const FILE: ItemSummary = {
  id: 'file-1',
  kind: 'file',
  title: 'Budget 2026.pdf',
  isFavorite: false,
  collectionId: 'col-1',
  updatedAt: '2026-09-15T08:00:00.000Z',
  fileMissing: false,
  isPinned: false,
  file: {
    originalName: 'Budget 2026.pdf',
    byteSize: 284_915,
    importedAt: '2026-09-15T08:00:00.000Z',
  },
  content: null,
}

const FILE_MISSING: ItemSummary = { ...FILE, fileMissing: true }

const LOADED_FILE: VaultItem = {
  id: FILE.id,
  kind: 'file',
  title: FILE.title,
  description: '',
  content: null,
  url: null,
  collectionId: FILE.collectionId,
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-09-15T08:00:00.000Z',
  updatedAt: FILE.updatedAt,
  tags: [],
  file: FILE.file,
  fileMissing: false,
}

const NOTE: ItemSummary = {
  id: 'note-1',
  kind: 'note',
  title: 'Meeting notes',
  isFavorite: false,
  collectionId: null,
  updatedAt: '2026-09-16T14:05:00.000Z',
  fileMissing: false,
  isPinned: false,
  file: null,
  content: '<p>Body text</p>',
}

const NOTE_ITEM: VaultItem = {
  id: NOTE.id,
  kind: 'note',
  title: 'Untitled note',
  description: '',
  content: '',
  url: null,
  collectionId: null,
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-09-16T14:05:00.000Z',
  updatedAt: '2026-09-16T14:05:00.000Z',
  tags: [],
  file: null,
  fileMissing: false,
}

const COLLECTION: Collection = {
  id: 'col-1',
  name: 'Work',
  icon: null,
  protection: 'none',
  sortOrder: 0,
  createdAt: '2026-09-10T11:20:00.000Z',
  itemCount: 1,
}

function renderInRouter(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

// Rows open their action menu on a right click. A title can repeat on the page,
// so pick the first match that sits inside an item card.
function openItemMenu(title: string) {
  const titleElement = screen
    .getAllByText(title)
    .find((element) => element.closest('.kivo-item-card') !== null)

  if (!titleElement) throw new Error(`The row for "${title}" is missing.`)

  fireEvent.contextMenu(titleElement)
}

beforeEach(() => {
  vi.clearAllMocks()
  itemsMock.listItems.mockResolvedValue([])
  itemsMock.saveItem.mockResolvedValue({ ...NOTE_ITEM })
  itemsMock.loadItem.mockResolvedValue({ ...LOADED_FILE })
  itemsMock.moveItemsToCollection.mockResolvedValue(undefined)
  itemsMock.trashItems.mockResolvedValue(undefined)
  feedbackMock.trashWithUndo.mockResolvedValue(true)
  itemsMock.importFile.mockResolvedValue({ ...LOADED_FILE })
  itemsMock.previewFileImport.mockImplementation(async (path: string) => ({
    token: path,
    originalName: path,
    byteSize: 1,
    matches: [],
    accessEpoch: 0,
  }))
  itemsMock.commitFileImport.mockResolvedValue({ status: 'saved', item: { ...LOADED_FILE } })
  itemsMock.cancelFileImport.mockResolvedValue(undefined)
  filesMock.pickFile.mockResolvedValue(null)
  filesMock.pickFiles.mockResolvedValue(null)
  filesMock.openItemFile.mockResolvedValue(undefined)
  filesMock.revealItemFile.mockResolvedValue(undefined)
  collectionsMock.listCollections.mockResolvedValue([])
  collectionsMock.saveCollection.mockResolvedValue({ ...COLLECTION })
  collectionsMock.deleteCollection.mockResolvedValue(undefined)
  collectionsMock.verifyCollectionSecret.mockResolvedValue(true)
  settingsMock.loadPreferences.mockResolvedValue({ ...DEFAULT_PREFERENCES })
  settingsMock.savePreferences.mockResolvedValue(undefined)
  portabilityMock.pickSaveFile.mockResolvedValue(null)
  portabilityMock.pickFolderDestination.mockResolvedValue(null)
  portabilityMock.exportItemsJson.mockResolvedValue(undefined)
  portabilityMock.exportNoteMarkdown.mockResolvedValue(undefined)
  portabilityMock.exportVaultJson.mockResolvedValue(undefined)
  portabilityMock.importJson.mockResolvedValue({ imported: 0, skipped: [] })
  portabilityMock.importMarkdown.mockResolvedValue({ imported: 0, skipped: [] })
  dashboardMock.loadVaultSummary.mockResolvedValue({
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
  })
})

describe('FilesPage', () => {
  it('imports every picked file and reloads the list once', async () => {
    itemsMock.listItems.mockResolvedValue([FILE])
    filesMock.pickFiles.mockResolvedValue(['C:\\Docs\\Report.pdf', 'C:\\Docs\\Notes.txt'])

    renderInRouter(<FilesPage />)
    await screen.findByRole('heading', { level: 1, name: 'Files', exact: true })
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    fireEvent.click(screen.getByRole('button', { name: 'Import files' }))

    await waitFor(() =>
      expect(itemsMock.commitFileImport).toHaveBeenCalledWith('C:\\Docs\\Notes.txt', null, 'check'),
    )
    expect(itemsMock.commitFileImport).toHaveBeenCalledWith('C:\\Docs\\Report.pdf', null, 'check')
    await waitFor(() => expect(itemsMock.listItems).toHaveBeenCalledTimes(2))
    expect(itemsMock.listItems).toHaveBeenCalledWith({ kind: 'file' })
  })

  it('does nothing when the picker is cancelled', async () => {
    filesMock.pickFiles.mockResolvedValue(null)

    renderInRouter(<FilesPage />)
    await screen.findByRole('heading', { level: 1, name: 'Files', exact: true })

    fireEvent.click(screen.getByRole('button', { name: 'Import files' }))

    await waitFor(() => expect(filesMock.pickFiles).toHaveBeenCalledTimes(1))
    expect(itemsMock.previewFileImport).not.toHaveBeenCalled()
  })

  it('keeps importing the rest when one file fails', async () => {
    filesMock.pickFiles.mockResolvedValue(['C:\\Docs\\Broken.pdf', 'C:\\Docs\\Report.pdf'])
    itemsMock.previewFileImport.mockRejectedValueOnce(new Error('missing'))

    renderInRouter(<FilesPage />)
    await screen.findByRole('heading', { level: 1, name: 'Files', exact: true })

    fireEvent.click(screen.getByRole('button', { name: 'Import files' }))

    await waitFor(() =>
      expect(itemsMock.commitFileImport).toHaveBeenCalledWith('C:\\Docs\\Report.pdf', null, 'check'),
    )
    await waitFor(() =>
      expect(feedbackMock.notifyError).toHaveBeenCalledWith(
        'Kivo could not import one or more files. Try again.',
      ),
    )
    await waitFor(() => expect(itemsMock.listItems).toHaveBeenCalledTimes(2))
  })

  it('opens and reveals a file through the row menu', async () => {
    itemsMock.listItems.mockResolvedValue([FILE])

    renderInRouter(<FilesPage />)
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    openItemMenu('Budget 2026.pdf')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }))
    await waitFor(() => expect(filesMock.openItemFile).toHaveBeenCalledWith(FILE.id))

    openItemMenu('Budget 2026.pdf')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal' }))
    await waitFor(() => expect(filesMock.revealItemFile).toHaveBeenCalledWith(FILE.id))
  })

  it('renames a file with the loaded kind', async () => {
    itemsMock.listItems.mockResolvedValue([FILE])

    renderInRouter(<FilesPage />)
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    openItemMenu('Budget 2026.pdf')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'File title' }), {
      target: { value: 'Budget 2027.pdf' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith({
        id: FILE.id,
        kind: 'file',
        title: 'Budget 2027.pdf',
        description: '',
        collectionId: 'col-1',
        isFavorite: false,
        isPinned: false,
      }),
    )
  })

  it('moves a file to its collection', async () => {
    itemsMock.listItems.mockResolvedValue([FILE])
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])

    renderInRouter(<FilesPage />)
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    openItemMenu('Budget 2026.pdf')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to collection' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))

    await waitFor(() =>
      expect(itemsMock.moveItemsToCollection).toHaveBeenCalledWith([FILE.id], 'col-1'),
    )
  })

  it('trashes a file after confirmation', async () => {
    itemsMock.listItems.mockResolvedValue([FILE])

    renderInRouter(<FilesPage />)
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    openItemMenu('Budget 2026.pdf')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }))

    await waitFor(() =>
      expect(feedbackMock.trashWithUndo).toHaveBeenCalledWith({ ids: [FILE.id], label: 'File' }),
    )
  })

  it('marks a missing file and disables its open action', async () => {
    itemsMock.listItems.mockResolvedValue([FILE_MISSING])

    renderInRouter(<FilesPage />)

    expect(await screen.findByText('File is missing')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Budget 2026.pdf' })).toBeDisabled()
  })

  it('shows the file type icon for the detected format', async () => {
    itemsMock.listItems.mockResolvedValue([FILE])

    const view = renderInRouter(<FilesPage />)
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    expect(screen.getByRole('list').closest('[data-slot="scroll-shadow"]')).not.toBeNull()
    expect(view.container.querySelector('[data-file-icon="pdf"]')).not.toBeNull()
  })
})

describe('CollectionsPage', () => {
  const READING: Collection = {
    id: 'col-2',
    name: 'Reading',
    icon: null,
    protection: 'none',
    sortOrder: 1,
    createdAt: '2026-09-11T09:00:00.000Z',
    itemCount: 0,
  }

  const LOCKED: Collection = {
    ...COLLECTION,
    id: 'col-locked',
    name: 'Vault',
    protection: 'password',
  }

  function renderCollections(overrides: Partial<Preferences> = {}) {
    return render(
      <MemoryRouter>
        <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES, ...overrides }}>
          <CollectionsPage />
        </PreferencesProvider>
      </MemoryRouter>,
    )
  }

  async function openNewCollectionDialog() {
    await screen.findByRole('heading', { level: 1, name: 'Collections', exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
    return screen.findByRole('dialog')
  }

  async function openRowMenu(name: string, action: string) {
    const titleElement = screen
      .getAllByText(name)
      .find((element) => element.closest('.kivo-item-card') !== null)

    if (!titleElement) throw new Error(`The row for "${name}" is missing.`)

    fireEvent.contextMenu(titleElement)
    fireEvent.click(await screen.findByRole('menuitem', { name: action }))
  }

  it('shows the loading state, then the collection list', async () => {
    let resolveCollections: (value: Collection[]) => void = () => undefined
    collectionsMock.listCollections.mockReturnValue(
      new Promise<Collection[]>((resolve) => {
        resolveCollections = resolve
      }),
    )

    renderCollections({ collectionsView: 'list' })

    expect(screen.getByRole('status')).toBeInTheDocument()

    await act(async () => {
      resolveCollections([{ ...COLLECTION }])
    })

    expect(await screen.findByRole('button', { name: 'Work' })).toBeInTheDocument()
  })

  it('creates a collection with no protection and the folder icon', async () => {
    renderCollections()
    const dialog = await openNewCollectionDialog()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Collection Name' }), {
      target: { value: 'Work' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Collection' }))

    await waitFor(() =>
      expect(collectionsMock.saveCollection).toHaveBeenCalledWith({
        id: undefined,
        name: 'Work',
        icon: 'folder',
        protection: 'none',
      }),
    )
    expect(collectionsMock.saveCollection.mock.calls.at(-1)?.[0]).not.toHaveProperty('secret')
  })

  it('creates a collection with a password', async () => {
    renderCollections()
    const dialog = await openNewCollectionDialog()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Collection Name' }), {
      target: { value: 'Private' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Password Type/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'Password' }))
    fireEvent.change(
      within(dialog).getByLabelText('Password', { selector: 'input[type="password"]' }),
      { target: { value: 'hunter2' } },
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Collection' }))

    await waitFor(() =>
      expect(collectionsMock.saveCollection).toHaveBeenCalledWith({
        id: undefined,
        name: 'Private',
        icon: 'folder',
        protection: 'password',
        secret: 'hunter2',
      }),
    )
  })

  it('reports a short password and does not save', async () => {
    renderCollections()
    const dialog = await openNewCollectionDialog()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Collection Name' }), {
      target: { value: 'Private' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Password Type/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'Password' }))

    const secret = within(dialog).getByLabelText('Password', {
      selector: 'input[type="password"]',
    })

    fireEvent.change(secret, { target: { value: 'abc' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Collection' }))

    expect(await screen.findByText('Password must be at least 4 characters.')).toBeInTheDocument()
    expect(collectionsMock.saveCollection).not.toHaveBeenCalled()
  })

  it('creates a collection with a 6-digit PIN and rejects a short one', async () => {
    renderCollections()
    const dialog = await openNewCollectionDialog()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Collection Name' }), {
      target: { value: 'Secret' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Password Type/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'PIN' }))

    const pin = within(dialog).getByLabelText('PIN', { selector: 'input[data-input-otp]' })

    fireEvent.change(pin, { target: { value: '1234' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Collection' }))

    expect(await screen.findByText('Enter a 6-digit PIN.')).toBeInTheDocument()
    expect(collectionsMock.saveCollection).not.toHaveBeenCalled()

    fireEvent.change(pin, { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Collection' }))

    await waitFor(() =>
      expect(collectionsMock.saveCollection).toHaveBeenCalledWith({
        id: undefined,
        name: 'Secret',
        icon: 'folder',
        protection: 'pin',
        secret: '123456',
      }),
    )
  })

  it('renames a collection without sending its protection', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    await openRowMenu('Work', 'Rename Work')

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Collection Name' }), {
      target: { value: 'Archive' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }))

    await waitFor(() =>
      expect(collectionsMock.saveCollection).toHaveBeenCalledWith({
        id: COLLECTION.id,
        name: 'Archive',
        icon: null,
      }),
    )
    const payload = collectionsMock.saveCollection.mock.calls.at(-1)?.[0] ?? {}
    expect(payload).not.toHaveProperty('protection')
    expect(payload).not.toHaveProperty('secret')
  })

  it('deletes a collection after confirmation', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    await openRowMenu('Work', 'Delete Work')

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete collection' }))

    await waitFor(() => expect(collectionsMock.deleteCollection).toHaveBeenCalledWith(COLLECTION.id))
  })

  it('exports a collection as JSON with its live item ids', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])
    portabilityMock.pickSaveFile.mockResolvedValue('C:/exports/Work.json')

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    await openRowMenu('Work', 'Export Work')

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: COLLECTION.id }),
    )
    await waitFor(() =>
      expect(portabilityMock.exportItemsJson).toHaveBeenCalledWith([NOTE.id], 'C:/exports/Work.json'),
    )
    expect(portabilityMock.pickSaveFile).toHaveBeenCalledWith('Work.json')
    expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Collection exported as JSON')
  })

  it('does not export when the save picker is cancelled', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])
    portabilityMock.pickSaveFile.mockResolvedValue(null)

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    await openRowMenu('Work', 'Export Work')

    await waitFor(() => expect(portabilityMock.pickSaveFile).toHaveBeenCalledWith('Work.json'))
    expect(portabilityMock.exportItemsJson).not.toHaveBeenCalled()
  })

  it('does not export a collection that has no items', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION, itemCount: 0 }])
    itemsMock.listItems.mockResolvedValue([])
    portabilityMock.pickSaveFile.mockResolvedValue('C:/exports/Work.json')

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    await openRowMenu('Work', 'Export Work')

    await waitFor(() => expect(portabilityMock.pickSaveFile).toHaveBeenCalled())
    expect(portabilityMock.exportItemsJson).not.toHaveBeenCalled()
  })

  it('opens a collection from its list row and loads its items', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: COLLECTION.id }),
    )
    expect(await screen.findByRole('heading', { level: 2, name: 'Work' })).toBeInTheDocument()
    expect(await screen.findByText('Meeting notes')).toBeInTheDocument()
  })

  it('hides the page chrome and switches item layouts inside a collection', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Work' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New collection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Search collection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename Work' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Work' })).not.toBeInTheDocument()
    expect(screen.queryByText('Collection')).not.toBeInTheDocument()

    expect((await screen.findByText('Body text')).className).toContain('truncate')
    expect(screen.getByText('Note')).toBeInTheDocument()

    const gridTab = screen.getByRole('tab', { name: 'Grid' })
    fireEvent.click(gridTab)

    await waitFor(() => expect(gridTab).toHaveAttribute('aria-selected', 'true'))
    expect((await screen.findByText('Body text')).className).toContain('line-clamp-2')
  })

  it('reads the address of each source item in a collection', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([
      { ...NOTE },
      { ...NOTE, id: 'source-1', kind: 'source', title: 'Spec sheet', content: null },
    ])
    itemsMock.loadItem.mockResolvedValue({
      ...LOADED_FILE,
      id: 'source-1',
      kind: 'source',
      title: 'Spec sheet',
      url: 'https://example.com/spec',
    })

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))

    expect(await screen.findByText('Source')).toBeInTheDocument()
    await waitFor(() => expect(itemsMock.loadItem).toHaveBeenCalledWith('source-1'))
    expect(await screen.findByText('https://example.com/spec')).toBeInTheDocument()
  })

  it('shows the empty message for a collection with no items', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION, itemCount: 0 }])
    itemsMock.listItems.mockResolvedValue([])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))

    expect(await screen.findByText('No items in this collection.')).toBeInTheDocument()
  })

  it('offers the item actions on a right click inside a collection', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([{ ...NOTE }, { ...FILE }])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Meeting notes' }))

    expect(await screen.findByRole('menuitem', { name: 'Open note' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Remove from collection' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Move to trash' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Reveal' })).not.toBeInTheDocument()
  })

  it('takes an item out of the collection through its menu', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    await screen.findByRole('button', { name: 'Meeting notes' })

    const loads = itemsMock.listItems.mock.calls.length

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Meeting notes' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from collection' }))

    await waitFor(() =>
      expect(itemsMock.moveItemsToCollection).toHaveBeenCalledWith([NOTE.id], null),
    )
    await waitFor(() => expect(itemsMock.listItems.mock.calls.length).toBeGreaterThan(loads))
  })

  it('moves an item to Trash through its menu after confirmation', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    await screen.findByRole('button', { name: 'Meeting notes' })

    const loads = itemsMock.listItems.mock.calls.length

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Meeting notes' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }))

    await waitFor(() =>
      expect(feedbackMock.trashWithUndo).toHaveBeenCalledWith({ ids: [NOTE.id], label: 'Item' }),
    )
    await waitFor(() => expect(itemsMock.listItems.mock.calls.length).toBeGreaterThan(loads))
  })

  it('reveals a file through its menu', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([FILE])

    renderCollections({ collectionsView: 'list' })
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    await screen.findByRole('button', { name: 'Budget 2026.pdf' })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Budget 2026.pdf' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal' }))

    await waitFor(() => expect(filesMock.revealItemFile).toHaveBeenCalledWith(FILE.id))
  })

  it('switches to the grid layout and remembers it', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    expect(screen.queryByRole('button', { name: 'Open collection Work' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Grid' }))

    await waitFor(() =>
      expect(settingsMock.savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ collectionsView: 'grid' }),
      ),
    )
    expect(await screen.findByRole('button', { name: 'Open collection Work' })).toBeInTheDocument()
  })

  it('filters collections by name and shows the no-result state', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }, { ...READING }])

    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Work' })
    expect(screen.getByRole('button', { name: 'Reading' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search collection' }), {
      target: { value: 'read' },
    })

    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reading' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search collection' }), {
      target: { value: 'zzz' },
    })

    expect(await screen.findByText('No collections match your search.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reading' })).not.toBeInTheDocument()
  })

  it('opens the collection named in the query parameter', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...COLLECTION }])
    itemsMock.listItems.mockResolvedValue([NOTE])

    render(
      <MemoryRouter initialEntries={[`/collections?collection=${COLLECTION.id}`]}>
        <PreferencesProvider initialPreferences={{ ...DEFAULT_PREFERENCES }}>
          <Routes>
            <Route path="/collections" element={<CollectionsPage />} />
          </Routes>
        </PreferencesProvider>
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: COLLECTION.id }),
    )
    expect(await screen.findByText('Meeting notes')).toBeInTheDocument()
  })

  it('gates a protected collection behind the unlock dialog', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...LOCKED }])
    collectionsMock.verifyCollectionSecret.mockResolvedValue(false)
    itemsMock.listItems.mockResolvedValue([NOTE])

    renderCollections({ collectionsView: 'list' })

    await screen.findByRole('button', { name: 'Vault' })
    expect(screen.getByText('Protected')).toBeInTheDocument()
    expect(itemsMock.listItems).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Vault' }))

    const dialog = await screen.findByRole('dialog')
    const passwordField = () =>
      within(dialog).getByLabelText('Password', { selector: 'input[type="password"]' })

    fireEvent.change(passwordField(), { target: { value: 'nope' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByText('That password did not match. Try again.')).toBeInTheDocument()
    expect(itemsMock.listItems).not.toHaveBeenCalled()

    collectionsMock.verifyCollectionSecret.mockResolvedValue(true)
    fireEvent.change(passwordField(), { target: { value: 'open-sesame' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: LOCKED.id }),
    )
    expect(await screen.findByText('Meeting notes')).toBeInTheDocument()
  })

  async function unlockVaultRow() {
    collectionsMock.listCollections.mockResolvedValue([{ ...LOCKED }])
    collectionsMock.verifyCollectionSecret.mockResolvedValue(true)
    itemsMock.listItems.mockResolvedValue([NOTE])
    renderCollections({ collectionsView: 'list' })

    fireEvent.click(await screen.findByRole('button', { name: 'Vault' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(
      within(dialog).getByLabelText('Password', { selector: 'input[type="password"]' }),
      { target: { value: 'open-sesame' } },
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await screen.findByRole('button', { name: 'Vault' })
  }

  it('locks an unlocked collection again from its right-click menu', async () => {
    collectionsMock.lockCollection.mockResolvedValue(undefined)
    await unlockVaultRow()

    await openRowMenu('Vault', 'Lock Vault')

    await waitFor(() => expect(collectionsMock.lockCollection).toHaveBeenCalledWith(LOCKED.id))
    // Opening it now asks for the password again.
    itemsMock.listItems.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Vault' }))
    expect(await screen.findByRole('button', { name: 'Unlock' })).toBeInTheDocument()
    expect(itemsMock.listItems).not.toHaveBeenCalled()
  })

  it('locks the open collection from the Lock button inside it', async () => {
    collectionsMock.lockCollection.mockResolvedValue(undefined)
    collectionsMock.listCollections.mockResolvedValue([{ ...LOCKED }])
    itemsMock.listItems.mockResolvedValue([NOTE])
    renderCollections({ collectionsView: 'list' })

    fireEvent.click(await screen.findByRole('button', { name: 'Vault' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(
      within(dialog).getByLabelText('Password', { selector: 'input[type="password"]' }),
      { target: { value: 'open-sesame' } },
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }))
    await waitFor(() => expect(collectionsMock.lockCollection).toHaveBeenCalledWith(LOCKED.id))
    // Back on the list, and the collection is closed again.
    expect(await screen.findByRole('button', { name: 'Vault' })).toBeInTheDocument()
    expect(screen.queryByText('Meeting notes')).not.toBeInTheDocument()
  })

  it('asks for the current PIN with PIN boxes when the lock is a PIN', async () => {
    collectionsMock.listCollections.mockResolvedValue([{ ...LOCKED, protection: 'pin' }])
    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Vault' })

    await openRowMenu('Vault', 'Remove PIN from Vault')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Remove PIN?' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Current PIN')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('removes a collection lock from the right-click menu only with the current password', async () => {
    collectionsMock.saveCollection.mockRejectedValueOnce(
      new Error('The current password or PIN is not correct'),
    )
    collectionsMock.listCollections.mockResolvedValue([{ ...LOCKED }])
    renderCollections({ collectionsView: 'list' })
    await screen.findByRole('button', { name: 'Vault' })

    await openRowMenu('Vault', 'Remove password from Vault')
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove lock' }))
    expect(
      await within(dialog).findByText('Enter the current password or PIN to change the lock.'),
    ).toBeInTheDocument()
    expect(collectionsMock.saveCollection).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'wrong' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove lock' }))
    expect(
      await within(dialog).findByText('The current password or PIN is not correct.'),
    ).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Current password'), {
      target: { value: 'open-sesame' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove lock' }))
    await waitFor(() =>
      expect(collectionsMock.saveCollection).toHaveBeenCalledWith({
        id: LOCKED.id,
        name: 'Vault',
        icon: LOCKED.icon,
        protection: 'none',
        currentSecret: 'open-sesame',
      }),
    )
  })
})

describe('QuickAddDialog', () => {
  it('starts the draft note flow without saving', async () => {
    const onClose = vi.fn()

    renderInRouter(<QuickAddDialog open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/notes/new'))
    expect(itemsMock.saveItem).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens the save source dialog for a new source', async () => {
    const onClose = vi.fn()

    renderInRouter(<QuickAddDialog open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'New source' }))

    await waitFor(() => {
      const lastProps = sourceDialogMock.mock.calls.at(-1)?.[0]
      expect(lastProps).toEqual(expect.objectContaining({ open: true, itemId: null }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('imports a picked file and navigates to Files', async () => {
    const onClose = vi.fn()
    filesMock.pickFile.mockResolvedValue('C:\\Docs\\Report.pdf')

    renderInRouter(<QuickAddDialog open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import file' }))

    await waitFor(() =>
      expect(itemsMock.commitFileImport).toHaveBeenCalledWith('C:\\Docs\\Report.pdf', null, 'check'),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/files'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('creates a collection and navigates to Collections', async () => {
    const onClose = vi.fn()
    collectionsMock.saveCollection.mockResolvedValue({ ...COLLECTION })

    renderInRouter(<QuickAddDialog open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Collection name' }), {
      target: { value: 'Work' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create collection' }))

    await waitFor(() =>
      expect(collectionsMock.saveCollection).toHaveBeenCalledWith({ name: 'Work' }),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/collections'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens only the collection form for a direct collection action, with Cancel', async () => {
    const onClose = vi.fn()

    renderInRouter(<QuickAddDialog initialAction="collection" open onClose={onClose} />)

    expect(await screen.findByRole('textbox', { name: 'Collection name' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never shows the menu for a direct file action', async () => {
    filesMock.pickFile.mockResolvedValue(null)

    renderInRouter(<QuickAddDialog initialAction="file" open onClose={vi.fn()} />)

    await waitFor(() => expect(filesMock.pickFile).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Quick add' })).not.toBeInTheDocument()
  })
})

describe('Dashboard quick add entry', () => {
  it('opens the quick add menu from the header button', async () => {
    renderInRouter(<DashboardPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Quick Add' }))

    expect(await screen.findByRole('menuitem', { name: 'New note' })).toBeInTheDocument()
  })
})
