import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const itemsMock = vi.hoisted(() => ({
  listItems: vi.fn(),
  loadItem: vi.fn(),
  saveItem: vi.fn(),
  setItemPinned: vi.fn(),
  setItemsFavorite: vi.fn(),
  moveItemsToCollection: vi.fn(),
  trashItems: vi.fn(),
  importFile: vi.fn(),
  setItemTags: vi.fn(),
}))

const collectionsMock = vi.hoisted(() => ({
  listCollections: vi.fn(),
  saveCollection: vi.fn(),
  deleteCollection: vi.fn(),
}))

const tagsMock = vi.hoisted(() => ({
  listTags: vi.fn(),
}))

const filesMock = vi.hoisted(() => ({
  pickFile: vi.fn(),
  pickFiles: vi.fn(),
  openItemFile: vi.fn(),
  revealItemFile: vi.fn(),
  openSourceUrl: vi.fn(),
}))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn().mockResolvedValue(true),
  trashManyWithUndo: vi.fn().mockResolvedValue(true),
}))

vi.mock('../features/collections/CollectionFolderPanel', () => ({ CollectionFolderPanel: () => null }))
vi.mock('../data/items', () => itemsMock)
vi.mock('../data/collections', () => collectionsMock)
vi.mock('../data/tags', () => tagsMock)
vi.mock('../data/files', () => filesMock)
vi.mock('../lib/feedback', () => feedbackMock)

// The pickers open HeroUI Select popovers that are awkward to drive in jsdom.
// Replace them with native selects so the page and dialog wiring stays under test.
vi.mock('../components/items/dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/items/dialogs')>()

  return {
    ...actual,
    CollectionSelect: ({
      value,
      onChange,
      label,
    }: {
      value: string | null
      onChange: (next: string | null) => void
      label?: string
    }) => (
      <select
        aria-label={label ?? 'Collection'}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">No collection</option>
        <option value="collection-1">Collection One</option>
        <option value="collection-2">Collection Two</option>
      </select>
    ),
    TagPicker: ({
      value,
      onChange,
      label,
    }: {
      value: string[]
      onChange: (next: string[]) => void
      label?: string
    }) => (
      <select
        aria-label={label ?? 'Tags'}
        value={value[0] ?? ''}
        onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}
      >
        <option value="">No tags</option>
        <option value="alpha">alpha</option>
      </select>
    ),
  }
})

import { ItemsPage } from '../features/items/ItemsPage'
import { ItemDetailsDialog } from '../features/items/ItemDetailsDialog'
import type { Collection } from '../data/collections'
import type { Tag } from '../data/tags'
import type { ItemSummary, VaultItem } from '../data/items'

const NOTE_ITEM: VaultItem = {
  id: 'note-1',
  kind: 'note',
  title: 'Alpha note',
  description: 'First note',
  content: '# Alpha',
  url: null,
  collectionId: null,
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-01-01T10:00:00Z',
  updatedAt: '2026-01-02T10:00:00Z',
  tags: ['alpha'],
  file: null,
  fileMissing: false,
}

const SOURCE_ITEM: VaultItem = {
  id: 'source-1',
  kind: 'source',
  title: 'Beta source',
  description: 'A saved link',
  content: null,
  url: 'https://example.com',
  collectionId: null,
  isFavorite: true,
  isPinned: false,
  createdAt: '2026-01-03T10:00:00Z',
  updatedAt: '2026-01-04T10:00:00Z',
  tags: [],
  file: null,
  fileMissing: false,
}

const FILE_ITEM: VaultItem = {
  id: 'file-1',
  kind: 'file',
  title: 'Gamma file',
  description: 'A saved file',
  content: null,
  url: null,
  collectionId: null,
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-01-05T10:00:00Z',
  updatedAt: '2026-01-06T10:00:00Z',
  tags: [],
  file: {
    originalName: 'gamma.pdf',
    byteSize: 2048,
    importedAt: '2026-01-07T10:00:00Z',
  },
  fileMissing: false,
}

const MISSING_FILE_ITEM: VaultItem = {
  ...FILE_ITEM,
  id: 'file-2',
  title: 'Delta file',
  fileMissing: true,
}

const COLLECTIONS: Collection[] = [
  { id: 'collection-1', name: 'Collection One', icon: null, protection: 'none', sortOrder: 1, createdAt: '', itemCount: 0 },
  { id: 'collection-2', name: 'Collection Two', icon: null, protection: 'none', sortOrder: 2, createdAt: '', itemCount: 0 },
]

const TAGS: Tag[] = [{ name: 'alpha', count: 1 }]

const PAGED_ITEMS: ItemSummary[] = Array.from({ length: 12 }, (_, index) => ({
  id: `page-${index + 1}`,
  kind: 'note',
  title: `Paged item ${String(index + 1).padStart(2, '0')}`,
  isFavorite: false,
  collectionId: null,
  updatedAt: `2026-02-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
  fileMissing: false,
  isPinned: false,
  file: null,
  content: null,
}))

function toSummary(item: VaultItem): ItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    isFavorite: item.isFavorite,
    collectionId: item.collectionId,
    updatedAt: item.updatedAt,
    fileMissing: item.fileMissing,
    isPinned: item.isPinned,
    file: item.file,
    content: item.content,
  }
}

// The Quick Add menu uses useNavigate, so the page needs a router around it.
// A probe route stands in for the draft note flow that "New note" navigates to.
function renderItemsPage() {
  return render(
    <MemoryRouter initialEntries={['/items']}>
      <Routes>
        <Route path="/notes/new" element={<div>New note draft</div>} />
        <Route path="*" element={<ItemsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// Rows open their action menu on a right click. A title can repeat on the page,
// so pick the first match that sits inside an item card.
function openRowMenu(title: string) {
  const titleElement = screen
    .getAllByText(title)
    .find((element) => element.closest('.kivo-item-card') !== null)

  if (!titleElement) throw new Error(`The row for "${title}" is missing.`)

  fireEvent.contextMenu(titleElement)
}

async function openFiltersMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  await screen.findByRole('menuitem', { name: 'Kind' })
}

// Open a Filters submenu with the keyboard instead of a mouse click: ArrowRight moves
// focus into the submenu synchronously, while a jsdom click opens it with a deferred
// focus step that races with React Aria's popover focus handling and closes it again.
async function chooseFilterItem(submenuName: string, itemName: string) {
  const trigger = screen.getByRole('menuitem', { name: submenuName })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })

  const item = await screen.findByRole('menuitemradio', { name: itemName })
  fireEvent.keyDown(item, { key: 'Enter' })
}

function renderDetails(itemId: string | null = 'note-1') {
  const onClose = vi.fn()
  const onChanged = vi.fn()

  render(<ItemDetailsDialog itemId={itemId} onClose={onClose} onChanged={onChanged} />)

  return { onClose, onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()

  itemsMock.listItems.mockResolvedValue([NOTE_ITEM, SOURCE_ITEM].map(toSummary))
  itemsMock.loadItem.mockResolvedValue(NOTE_ITEM)
  itemsMock.saveItem.mockResolvedValue(NOTE_ITEM)
  itemsMock.setItemPinned.mockResolvedValue(undefined)
  itemsMock.setItemsFavorite.mockResolvedValue(undefined)
  itemsMock.moveItemsToCollection.mockResolvedValue(undefined)
  itemsMock.trashItems.mockResolvedValue(undefined)
  itemsMock.importFile.mockResolvedValue(NOTE_ITEM)
  itemsMock.setItemTags.mockResolvedValue([])

  collectionsMock.listCollections.mockResolvedValue([...COLLECTIONS])
  tagsMock.listTags.mockResolvedValue([...TAGS])

  filesMock.pickFile.mockResolvedValue(null)
  filesMock.openItemFile.mockResolvedValue(undefined)
  filesMock.revealItemFile.mockResolvedValue(undefined)
  filesMock.openSourceUrl.mockResolvedValue(undefined)
})

describe('ItemsPage', () => {
  it('shows the item cards with the mocked rows and no view toggle', async () => {
    renderItemsPage()

    const loadingStatus = screen.getByRole('status', { name: 'Loading items' })
    expect(within(loadingStatus).getByText('Loading items')).toHaveClass('sr-only')
    expect(loadingStatus.querySelector('ul')).toHaveAttribute('aria-hidden', 'true')
    expect(loadingStatus.querySelectorAll('li')).toHaveLength(5)
    expect(screen.getByRole('heading', { name: 'All Items' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()

    expect(await screen.findByText('Alpha note')).toBeInTheDocument()
    expect(screen.getByText('Beta source')).toBeInTheDocument()

    const list = screen.getByRole('list', { name: 'All items' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list.closest('[data-slot="scroll-shadow"]')).not.toBeNull()
    expect(within(list).getByText('Alpha note')).toBeInTheDocument()
    expect(within(list).getByText('Note')).toBeInTheDocument()
    expect(within(list).getByText('Source')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()

    expect(screen.queryByRole('button', { name: 'List view' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Grid view' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('warns on a card when the managed file is missing', async () => {
    itemsMock.listItems.mockResolvedValue([toSummary(MISSING_FILE_ITEM)])
    renderItemsPage()

    expect(await screen.findByText('Delta file')).toBeInTheDocument()
    expect(screen.getByText('File is missing')).toBeInTheDocument()
  })

  it('shows the empty state when there are no items', async () => {
    itemsMock.listItems.mockResolvedValue([])
    renderItemsPage()

    expect(await screen.findByRole('heading', { level: 2, name: 'No items yet.' })).toBeInTheDocument()
    expect(screen.getByText('Save a note, source, or file to see it here.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'All items' })).not.toBeInTheDocument()
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()
  })

  it('shows a filter message when nothing matches', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    itemsMock.listItems.mockResolvedValue([])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search items' }), {
      target: { value: 'zzz' },
    })

    expect(
      await screen.findByText('No items match your search or filters.'),
    ).toBeInTheDocument()
  })

  it('shows an error alert and reloads from Try again', async () => {
    itemsMock.listItems
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValueOnce([toSummary(NOTE_ITEM)])
    renderItemsPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your items could not load')

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Alpha note')).toBeInTheDocument()
    expect(itemsMock.listItems).toHaveBeenCalledTimes(2)
  })

  it('reloads with the query filter when the search term changes', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')
    itemsMock.listItems.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search items' }), {
      target: { value: 'alpha' },
    })

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenLastCalledWith({ query: 'alpha' }),
    )
  })

  it('shows ten cards per page and moves to the next page', async () => {
    itemsMock.listItems.mockResolvedValue(PAGED_ITEMS)
    renderItemsPage()
    await screen.findByText('Paged item 01')

    const list = screen.getByRole('list', { name: 'All items' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(10)
    expect(screen.getByText('Showing 1 to 10 of 12 items')).toBeInTheDocument()
    expect(screen.queryByText('Paged item 11')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Paged item 11')).toBeInTheDocument()
    expect(screen.getByText('Showing 11 to 12 of 12 items')).toBeInTheDocument()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(itemsMock.listItems).toHaveBeenCalledTimes(1)
  })

  it('filters by kind from the Filters menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    await openFiltersMenu()
    await chooseFilterItem('Kind', 'Notes')

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenLastCalledWith({ kind: 'note' }),
    )
  })

  it('filters by collection from the Filters menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    await openFiltersMenu()
    await chooseFilterItem('Collection', 'Collection One')

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenLastCalledWith({ collectionId: 'collection-1' }),
    )
  })

  it('filters by tag from the Filters menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    await openFiltersMenu()
    await chooseFilterItem('Tag', 'alpha')

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenLastCalledWith({ tag: 'alpha' }),
    )
  })

  it('filters to favorites only from the Filters menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    await openFiltersMenu()
    await chooseFilterItem('Favorites', 'Favorites only')

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenLastCalledWith({ favorite: true }),
    )
  })

  it('clears every filter from the Filters menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    await openFiltersMenu()
    await chooseFilterItem('Kind', 'Notes')
    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenLastCalledWith({ kind: 'note' }),
    )

    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: 'Kind' })).not.toBeInTheDocument(),
    )
    await openFiltersMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear filters' }))

    await waitFor(() => expect(itemsMock.listItems).toHaveBeenLastCalledWith({}))
  })

  it('moves a row to Trash from its action menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }))

    await waitFor(() =>
      expect(feedbackMock.trashWithUndo).toHaveBeenCalledWith({ ids: ['note-1'], label: 'Item' }),
    )
  })

  it('selects rows from the row menu and trashes every selected item after confirmation', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    expect(screen.queryByRole('toolbar', { name: 'Selection' })).not.toBeInTheDocument()

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))

    const bar = await screen.findByRole('toolbar', { name: 'Selection' })
    expect(within(bar).getByText('1 selected')).toBeInTheDocument()

    fireEvent.click(within(bar).getByRole('checkbox', { name: 'Select all' }))
    expect(within(bar).getByText('2 selected')).toBeInTheDocument()

    fireEvent.click(within(bar).getByRole('button', { name: 'Move to Trash' }))

    const heading = await screen.findByRole('heading', { name: 'Move 2 items to Trash?' })
    expect(feedbackMock.trashManyWithUndo).not.toHaveBeenCalled()
    const dialog = heading.closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }))

    await waitFor(() =>
      expect(feedbackMock.trashManyWithUndo).toHaveBeenCalledWith([NOTE_ITEM.id, SOURCE_ITEM.id]),
    )
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Selection' })).not.toBeInTheDocument(),
    )
  })

  it('toggles a row by clicking it while selecting instead of opening it', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }))

    const row = screen.getByRole('button', { name: 'Alpha note' })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(within(screen.getByRole('toolbar', { name: 'Selection' })).getByText('0 selected')).toBeInTheDocument()
  })

  it('moves a row to a collection from its action menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to collection' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Collection'), {
      target: { value: 'collection-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))

    await waitFor(() =>
      expect(itemsMock.moveItemsToCollection).toHaveBeenCalledWith(['note-1'], 'collection-1'),
    )
    await waitFor(() =>
      expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Item moved to collection'),
    )
  })

  it('shows a danger toast and keeps the move dialog open when the move fails', async () => {
    itemsMock.moveItemsToCollection.mockRejectedValueOnce(new Error('move failed'))
    renderItemsPage()
    await screen.findByText('Alpha note')

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to collection' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))

    await waitFor(() =>
      expect(feedbackMock.notifyError).toHaveBeenCalledWith('Kivo could not move this item. Try again.'),
    )
    expect(screen.getByRole('heading', { name: 'Move to collection' })).toBeInTheDocument()
  })

  it('shows a danger toast when a favorite toggle fails', async () => {
    itemsMock.setItemsFavorite.mockRejectedValueOnce(new Error('favorite failed'))
    renderItemsPage()
    await screen.findByText('Alpha note')

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to favorites' }))

    await waitFor(() =>
      expect(feedbackMock.notifyError).toHaveBeenCalledWith(
        'Kivo could not finish that action. Your items are unchanged. Try again.',
      ),
    )
  })

  it('creates a note from the Quick Add menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    fireEvent.click(screen.getByRole('button', { name: 'Quick Add' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New note' }))

    expect(await screen.findByText('New note draft')).toBeInTheDocument()
    expect(itemsMock.saveItem).not.toHaveBeenCalled()
  })

  it('toggles a row favorite from its action menu', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    openRowMenu('Alpha note')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to favorites' }))

    await waitFor(() =>
      expect(itemsMock.setItemsFavorite).toHaveBeenCalledWith(['note-1'], true),
    )

    await screen.findByText('Beta source')
    openRowMenu('Beta source')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove favorite' }))

    await waitFor(() =>
      expect(itemsMock.setItemsFavorite).toHaveBeenCalledWith(['source-1'], false),
    )
  })

  it('opens the details dialog when a card is clicked', async () => {
    renderItemsPage()
    await screen.findByText('Alpha note')

    fireEvent.click(screen.getByRole('button', { name: 'Alpha note' }))

    expect(await screen.findByRole('heading', { name: 'Item details' })).toBeInTheDocument()
    expect(itemsMock.loadItem).toHaveBeenCalledWith('note-1')
  })
})

describe('ItemDetailsDialog', () => {
  it('loads and shows the common fields', async () => {
    renderDetails()

    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Alpha note')
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('First note')
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Updated')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Favorite' })).not.toBeChecked()
    expect(itemsMock.loadItem).toHaveBeenCalledWith('note-1')
  })

  it('saves the title and description through one action', async () => {
    const { onChanged } = renderDetails()
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Updated title' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Updated description' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'note-1',
          kind: 'note',
          title: 'Updated title',
          description: 'Updated description',
        }),
      ),
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('saves the favorite switch immediately', async () => {
    renderDetails()
    await screen.findByRole('switch', { name: 'Favorite' })

    fireEvent.click(screen.getByRole('switch', { name: 'Favorite' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'note-1', isFavorite: true }),
      ),
    )
  })

  it('shows file fields only for file items', async () => {
    renderDetails('note-1')
    await screen.findByRole('textbox', { name: 'Title' })

    expect(screen.queryByText('Original name')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal' })).not.toBeInTheDocument()
  })

  it('shows the file fields and opens or reveals the managed file', async () => {
    itemsMock.loadItem.mockResolvedValue(FILE_ITEM)
    renderDetails('file-1')

    expect(await screen.findByText('gamma.pdf')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(filesMock.openItemFile).toHaveBeenCalledWith('file-1'))

    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    await waitFor(() => expect(filesMock.revealItemFile).toHaveBeenCalledWith('file-1'))
  })

  it('shows a missing file state and disables the file actions', async () => {
    itemsMock.loadItem.mockResolvedValue(MISSING_FILE_ITEM)
    renderDetails('file-2')

    expect(
      await screen.findByText('This file is missing from the vault folder.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeDisabled()
  })

  it('trashes the item, closes the dialog, and notifies the parent', async () => {
    const { onClose, onChanged } = renderDetails('note-1')
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))

    const heading = await screen.findByRole('heading', { name: 'Move this item to Trash?' })
    const confirmDialog = heading.closest('[role="dialog"]') as HTMLElement
    expect(confirmDialog).not.toBeNull()

    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Move to trash' }))

    await waitFor(() =>
      expect(feedbackMock.trashWithUndo).toHaveBeenCalledWith({ ids: ['note-1'], label: 'Item' }),
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a danger toast and keeps the inline error when saving details fails', async () => {
    itemsMock.saveItem.mockRejectedValueOnce(new Error('save failed'))
    renderDetails()
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Renamed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(feedbackMock.notifyError).toHaveBeenCalledWith(
        'Kivo could not save this change. Your saved details are unchanged.',
      ),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Kivo could not save this change. Your saved details are unchanged.',
    )
  })

  it('shows a success toast when the details save', async () => {
    renderDetails()
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Item saved'))
  })

  it('saves a collection change through saveItem', async () => {
    renderDetails()
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.change(screen.getByLabelText('Collection'), {
      target: { value: 'collection-1' },
    })

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'note-1', collectionId: 'collection-1' }),
      ),
    )
  })

  it('saves a tag change through setItemTags', async () => {
    renderDetails()
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'alpha' } })

    await waitFor(() => expect(itemsMock.setItemTags).toHaveBeenCalledWith('note-1', ['alpha']))
  })

  it('shows the common fields for a source item', async () => {
    itemsMock.loadItem.mockResolvedValue(SOURCE_ITEM)
    renderDetails('source-1')

    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('Beta source')
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('A saved link')
    expect(screen.getByRole('switch', { name: 'Favorite' })).toBeChecked()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByText('Updated')).toBeInTheDocument()
    expect(screen.queryByText('Original name')).not.toBeInTheDocument()
  })

  it('favorites and tags a file item', async () => {
    itemsMock.loadItem.mockResolvedValue(FILE_ITEM)
    itemsMock.saveItem.mockResolvedValue(FILE_ITEM)
    renderDetails('file-1')
    await screen.findByText('gamma.pdf')

    fireEvent.click(screen.getByRole('switch', { name: 'Favorite' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'file-1', isFavorite: true }),
      ),
    )

    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'alpha' } })

    await waitFor(() => expect(itemsMock.setItemTags).toHaveBeenCalledWith('file-1', ['alpha']))
  })

  it('shows a saved metadata change without leaving the dialog', async () => {
    itemsMock.saveItem.mockImplementation(async (input) => ({ ...NOTE_ITEM, ...input }))
    renderDetails()
    await screen.findByRole('textbox', { name: 'Title' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Renamed in place' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Fresh description' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(itemsMock.saveItem).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Renamed in place', description: 'Fresh description' }),
      ),
    )

    expect(screen.getByRole('heading', { name: 'Item details' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Renamed in place')
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Fresh description')
  })
})
