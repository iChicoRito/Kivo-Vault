import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Collection } from '../data/collections'
import type { ItemSummary } from '../data/items'

const collectionsMock = vi.hoisted(() => ({
  listCollections: vi.fn(),
  deleteCollection: vi.fn(),
}))

const itemsMock = vi.hoisted(() => ({
  listItems: vi.fn(),
  moveItemsToCollection: vi.fn(),
}))

const filesMock = vi.hoisted(() => ({
  openItemFile: vi.fn(),
  openSourceUrl: vi.fn(),
}))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn().mockResolvedValue(true),
}))

vi.mock('../data/collections', () => collectionsMock)
vi.mock('../data/items', () => itemsMock)
vi.mock('../data/files', () => filesMock)
vi.mock('../lib/feedback', () => feedbackMock)

import { CollectionFolderPanel } from '../features/collections/CollectionFolderPanel'
import { VAULT_CHANGED_EVENT } from '../data/events'
import {
  ITEM_DROPPED_EVENT,
  ITEM_DRAG_END_EVENT,
  ITEM_DRAG_OVER_EVENT,
  ITEM_DRAG_START_EVENT,
} from '../features/collections/itemDrag'

function collection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 'col-1',
    name: 'Work',
    icon: null,
    protection: 'none',
    sortOrder: 0,
    createdAt: '2026-09-10T11:20:00.000Z',
    itemCount: 1,
    ...overrides,
  }
}

function item(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 'n1',
    kind: 'note',
    title: 'Alpha',
    isFavorite: false,
    collectionId: 'col-1',
    updatedAt: '2026-09-10T11:20:00.000Z',
    fileMissing: false,
    isPinned: false,
    content: '',
    file: null,
    ...overrides,
  }
}

function dragOver(collectionId: string | null) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ITEM_DRAG_OVER_EVENT, { detail: { collectionId } }),
    )
  })
}

async function dropItem(itemId: string, collectionId: string) {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(ITEM_DROPPED_EVENT, { detail: { itemIds: [itemId], collectionId } }),
    )
  })
}

// The panel's wrapper carries the width and takes the height of the list area,
// so the panel inside it never stretches the page.
function panelBox(panel: HTMLElement) {
  const box = panel.parentElement

  if (!box) throw new Error('The panel wrapper is missing.')

  return box
}

function findSection(panel: HTMLElement, collectionId: string) {
  const section = panel.querySelector(`[data-collection-drop="${collectionId}"]`)

  if (!section) throw new Error('The collection section is missing.')

  return section
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/notes']}>
      <Routes>
        <Route path="/notes" element={<CollectionFolderPanel />} />
        <Route path="/notes/:id" element={<LocationProbe />} />
        <Route path="/collections" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  collectionsMock.listCollections.mockResolvedValue([])
  collectionsMock.deleteCollection.mockResolvedValue(undefined)
  itemsMock.listItems.mockResolvedValue([])
  itemsMock.moveItemsToCollection.mockResolvedValue(undefined)
  filesMock.openItemFile.mockResolvedValue(undefined)
  filesMock.openSourceUrl.mockResolvedValue(undefined)
  feedbackMock.trashWithUndo.mockResolvedValue(true)
})

describe('CollectionFolderPanel', () => {
  it('shows a collection-folder skeleton while the collections load', () => {
    collectionsMock.listCollections.mockReturnValue(new Promise(() => undefined))

    renderPanel()

    const status = screen.getByRole('status')
    const skeletons = status.querySelectorAll('.skeleton')

    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveClass('w-80')
    expect(status).toHaveTextContent('Loading collection folders')
    expect(skeletons.length).toBeGreaterThan(0)
    expect([...skeletons].every((skeleton) => skeleton.closest('[aria-hidden="true"]'))).toBe(true)
  })

  it('shows every collection even when none holds items', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 0 }),
      collection({ id: 'col-2', name: 'Reading', itemCount: 0 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    expect(within(panel).getByRole('button', { name: 'Work 0 Items' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Reading 0 Items' })).toBeInTheDocument()
  })

  it('unfolds the first collection that holds items, not an empty one', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Empty', itemCount: 0 }),
      collection({ id: 'col-2', name: 'Work', itemCount: 1 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: 'col-2' }),
    )
    expect(itemsMock.listItems).not.toHaveBeenCalledWith({ collectionId: 'col-1' })
    expect(within(panel).getByRole('button', { name: 'Work 1 Item' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('renders every collection with the count read aloud', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
      collection({ id: 'col-2', name: 'Reading', itemCount: 2 }),
      collection({ id: 'col-3', name: 'Empty', itemCount: 0 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    expect(within(panel).getByRole('button', { name: 'Work 1 Item' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Reading 2 Items' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Empty 0 Items' })).toBeInTheDocument()

    // The count is spoken, not drawn, matching the design.
    expect(within(panel).queryByText('1 Item')).not.toBeInTheDocument()
    expect(within(panel).queryByText('2 Items')).not.toBeInTheDocument()
  })

  it('unfolds the first collection and lists the items it holds', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.listItems.mockResolvedValue([item()])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: 'col-1' })
    expect(await within(panel).findByRole('button', { name: 'Alpha' })).toBeInTheDocument()
  })

  it('shows loading bars under a head while its items load', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.listItems.mockReturnValue(new Promise(() => undefined))

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const section = await waitFor(() => findSection(panel, 'col-1'))

    await waitFor(() => expect(section.querySelectorAll('.skeleton').length).toBe(3))
    expect(section.querySelectorAll('.branched-menu__item:disabled').length).toBe(3)
  })

  it('shows a quiet line when the items of a collection fail to load', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.listItems.mockRejectedValue(new Error('boom'))

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    expect(await within(panel).findByText('Could not load these items.')).toBeInTheDocument()
  })

  it('unfolds another collection on a head click and folds it back', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
      collection({ id: 'col-2', name: 'Reading', itemCount: 1, sortOrder: 1 }),
    ])
    itemsMock.listItems.mockResolvedValue([item()])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const reading = within(panel).getByRole('button', { name: 'Reading 1 Item' })

    expect(reading).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(reading)

    expect(reading).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() =>
      expect(itemsMock.listItems).toHaveBeenCalledWith({ collectionId: 'col-2' }),
    )

    fireEvent.click(reading)

    expect(reading).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a note in the editor when its row is clicked', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.listItems.mockResolvedValue([item({ id: 'n7', title: 'Alpha' })])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    fireEvent.click(await within(panel).findByRole('button', { name: 'Alpha' }))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/notes/n7'))
  })

  it('opens a source link and a file with the system app', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 2 }),
    ])
    itemsMock.listItems.mockResolvedValue([
      item({ id: 's1', kind: 'source', title: 'ACME docs' }),
      item({ id: 'f1', kind: 'file', title: 'Guide.pdf' }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    fireEvent.click(await within(panel).findByRole('button', { name: 'ACME docs' }))
    await waitFor(() => expect(filesMock.openSourceUrl).toHaveBeenCalledWith('s1'))

    fireEvent.click(within(panel).getByRole('button', { name: 'Guide.pdf' }))
    await waitFor(() => expect(filesMock.openItemFile).toHaveBeenCalledWith('f1'))
  })

  it('collapses to the rail that still opens collections, then expands again', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const toggle = within(panel).getByRole('button', { name: 'Collapse collection folder' })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(panelBox(panel)).toHaveClass('w-80')

    fireEvent.click(toggle)

    const collapsedToggle = within(panel).getByRole('button', {
      name: 'Expand collection folder',
    })

    expect(collapsedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(panelBox(panel)).toHaveClass('w-16')
    expect(within(panel).getByRole('button', { name: 'Open collection Work' })).toBeInTheDocument()

    fireEvent.click(collapsedToggle)

    expect(
      within(panel).getByRole('button', { name: 'Collapse collection folder' }),
    ).toHaveAttribute('aria-expanded', 'true')
    expect(within(panel).getByRole('button', { name: 'Work 1 Item' })).toBeInTheDocument()
  })

  it('shows the collection name in a tooltip on the collapsed rail', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    fireEvent.click(within(panel).getByRole('button', { name: 'Collapse collection folder' }))

    const tile = within(panel).getByRole('button', { name: 'Open collection Work' })

    fireEvent.pointerDown(tile)
    fireEvent.pointerEnter(tile)

    expect(await screen.findByRole('tooltip', {}, { timeout: 3000 })).toHaveTextContent('Work')
  })

  it('opens the collections page from the collapsed rail', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-9', name: 'Work', itemCount: 1 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    fireEvent.click(within(panel).getByRole('button', { name: 'Collapse collection folder' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Open collection Work' }))

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/collections?collection=col-9'),
    )
  })

  it('renders nothing when the collections fail to load', async () => {
    collectionsMock.listCollections.mockRejectedValue(new Error('boom'))

    renderPanel()

    await waitFor(() => expect(collectionsMock.listCollections).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('expands the rail while a drag is active and folds it back after', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
      collection({ id: 'col-2', name: 'Reading', itemCount: 0 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    // The empty collection is already in the list, so a drag adds nothing new.
    expect(within(panel).getByRole('button', { name: 'Reading 0 Items' })).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: 'Collapse collection folder' }))
    expect(panelBox(panel)).toHaveClass('w-16')

    act(() => {
      window.dispatchEvent(new Event(ITEM_DRAG_START_EVENT))
    })

    expect(within(panel).getByRole('button', { name: 'Reading 0 Items' })).toBeInTheDocument()
    expect(panelBox(panel)).toHaveClass('w-80')

    act(() => {
      window.dispatchEvent(new Event(ITEM_DRAG_END_EVENT))
    })

    // Back on the rail, every collection still has its button, empty ones too.
    expect(
      within(panel).getByRole('button', { name: 'Open collection Reading' }),
    ).toBeInTheDocument()
    expect(panelBox(panel)).toHaveClass('w-16')
  })

  it('marks the collection under the pointer while an item is dragged over it', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const section = findSection(panel, 'col-1')

    dragOver('col-1')
    expect(section).toHaveClass('outline-focus')

    dragOver(null)
    expect(section).not.toHaveClass('outline-focus')
  })

  it('moves the dropped item into that collection, reports it, and refreshes the tree', async () => {
    collectionsMock.listCollections
      .mockResolvedValueOnce([collection({ id: 'col-1', name: 'Work', itemCount: 1 })])
      .mockResolvedValueOnce([collection({ id: 'col-1', name: 'Work', itemCount: 2 })])
    itemsMock.listItems.mockResolvedValue([item()])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const section = findSection(panel, 'col-1')

    dragOver('col-1')
    expect(section).toHaveClass('outline-focus')

    await dropItem('n1', 'col-1')

    expect(itemsMock.moveItemsToCollection).toHaveBeenCalledWith(['n1'], 'col-1')
    expect(await within(panel).findByText('Moved to Work')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Work 2 Items' })).toBeInTheDocument(),
    )
    expect(collectionsMock.listCollections).toHaveBeenCalledTimes(2)
    // The open tree refetches, so the moved item shows up under its new head.
    expect(itemsMock.listItems).toHaveBeenCalledTimes(2)
    expect(section).not.toHaveClass('outline-focus')
  })

  it('keeps the panel and reports a move that fails', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.moveItemsToCollection.mockRejectedValue(new Error('boom'))

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const section = findSection(panel, 'col-1')

    await dropItem('n1', 'col-1')

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Could not move this item. Try again.',
    )
    expect(within(panel).getByRole('button', { name: 'Work 1 Item' })).toBeInTheDocument()
    expect(section).not.toHaveClass('outline-focus')
  })

  it('reloads an open branch on a vault change without folding it', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.listItems.mockResolvedValue([item({ title: 'Alpha' })])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const work = within(panel).getByRole('button', { name: 'Work 1 Item' })

    expect(work).toHaveAttribute('aria-expanded', 'true')
    expect(await within(panel).findByRole('button', { name: 'Alpha' })).toBeInTheDocument()
    expect(itemsMock.listItems).toHaveBeenCalledTimes(1)

    itemsMock.listItems.mockResolvedValue([item({ title: 'Beta' })])

    await act(async () => {
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT))
    })

    expect(itemsMock.listItems).toHaveBeenCalledTimes(2)
    expect(itemsMock.listItems).toHaveBeenLastCalledWith({ collectionId: 'col-1' })
    // The branch stays unfolded and swaps its rows in place.
    expect(work).toHaveAttribute('aria-expanded', 'true')
    expect(await within(panel).findByRole('button', { name: 'Beta' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument()
  })

  it('opens the folder menu on a right click on a collection row', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 0 }),
    ])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })

    fireEvent.contextMenu(within(panel).getByRole('button', { name: 'Work 0 Items' }))

    expect(await screen.findByRole('menuitem', { name: 'Open collection' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete collection' })).toBeInTheDocument()
  })

  it('opens the item menu on a right click on an item row', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      collection({ id: 'col-1', name: 'Work', itemCount: 1 }),
    ])
    itemsMock.listItems.mockResolvedValue([item()])

    renderPanel()

    const panel = await screen.findByRole('complementary', { name: 'Collection folders' })
    const row = await within(panel).findByRole('button', { name: 'Alpha' })

    fireEvent.contextMenu(row)

    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Move to Collection…' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    expect(feedbackMock.trashWithUndo).toHaveBeenCalledWith({ ids: ['n1'], label: 'Item' })
  })
})
