import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ItemSummary } from '../data/items'
import { VAULT_CHANGED_EVENT } from '../data/events'

const itemsMock = vi.hoisted(() => ({
  listItems: vi.fn(),
  setItemsFavorite: vi.fn(),
  moveItemsToCollection: vi.fn(),
}))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))

vi.mock('../features/collections/CollectionFolderPanel', () => ({ CollectionFolderPanel: () => null }))
vi.mock('../data/items', () => itemsMock)
vi.mock('../lib/feedback', () => feedbackMock)
vi.mock('../features/items/ItemDetailsDialog', () => ({ ItemDetailsDialog: () => null }))

// The picker opens a HeroUI Select popover that is awkward to drive in jsdom.
// A native select keeps the page wiring under test.
vi.mock('../components/items/dialogs', () => ({
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
    </select>
  ),
}))

import { FavoritesPage } from '../features/favorites/FavoritesPage'

const FAVORITE_ITEM: ItemSummary = {
  id: 'favorite-1',
  kind: 'note',
  title: 'Favorite note',
  isFavorite: true,
  collectionId: null,
  updatedAt: '2026-09-16T10:00:00.000Z',
  fileMissing: false,
  isPinned: false,
  file: null,
  content: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  itemsMock.listItems.mockResolvedValue([FAVORITE_ITEM])
  itemsMock.setItemsFavorite.mockResolvedValue(undefined)
  itemsMock.moveItemsToCollection.mockResolvedValue(undefined)
})

describe('FavoritesPage', () => {
  it('shows item-shaped placeholders while loading and keeps the filter available', async () => {
    let resolveItems!: (items: ItemSummary[]) => void
    itemsMock.listItems.mockReturnValue(
      new Promise<ItemSummary[]>((resolve) => {
        resolveItems = resolve
      }),
    )

    render(<FavoritesPage />)

    const loadingStatus = screen.getByRole('status', { name: 'Loading favorites' })
    expect(loadingStatus.querySelectorAll('li')).toHaveLength(5)
    expect(screen.getByRole('heading', { name: 'Favorites' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /All types/ })).toBeInTheDocument()

    await act(async () => resolveItems([FAVORITE_ITEM]))

    expect(await screen.findByText('Favorite note')).toBeInTheDocument()
  })

  it('shows an error and retries loading favorites', async () => {
    itemsMock.listItems
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValueOnce([FAVORITE_ITEM])

    render(<FavoritesPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your favorites could not load')

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Favorite note')).toBeInTheDocument()
    expect(itemsMock.listItems).toHaveBeenCalledTimes(2)
  })

  it('shows the empty message when there are no favorites', async () => {
    itemsMock.listItems.mockResolvedValue([])

    render(<FavoritesPage />)

    expect(
      await screen.findByText('Items you mark as favorites will appear here.'),
    ).toBeInTheDocument()
  })

  it('moves a favorite to a collection from its row menu', async () => {
    render(<FavoritesPage />)
    await screen.findByText('Favorite note')

    fireEvent.contextMenu(screen.getByText('Favorite note'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to collection' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Collection'), {
      target: { value: 'collection-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))

    await waitFor(() =>
      expect(itemsMock.moveItemsToCollection).toHaveBeenCalledWith(['favorite-1'], 'collection-1'),
    )
    await waitFor(() =>
      expect(feedbackMock.notifySuccess).toHaveBeenCalledWith('Item moved to collection'),
    )
  })

  it('shows a danger toast when a favorite toggle fails', async () => {
    itemsMock.setItemsFavorite.mockRejectedValueOnce(new Error('favorite failed'))

    render(<FavoritesPage />)
    await screen.findByText('Favorite note')

    fireEvent.contextMenu(screen.getByText('Favorite note'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove favorite' }))

    await waitFor(() =>
      expect(feedbackMock.notifyError).toHaveBeenCalledWith(
        'Kivo could not update this favorite. Your items are unchanged. Try again.',
      ),
    )
  })

  it('refetches favorites when the vault changes', async () => {
    const restored: ItemSummary = {
      ...FAVORITE_ITEM,
      id: 'favorite-2',
      title: 'Restored note',
    }
    itemsMock.listItems
      .mockResolvedValueOnce([FAVORITE_ITEM])
      .mockResolvedValueOnce([restored])

    render(<FavoritesPage />)
    await screen.findByText('Favorite note')

    act(() => {
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT))
    })

    expect(await screen.findByText('Restored note')).toBeInTheDocument()
    expect(itemsMock.listItems).toHaveBeenCalledTimes(2)
  })
})
