import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FilterMenu, type FilterMenuProps } from '../components/items/FilterMenu'
import { useLibraryFilters } from '../components/items/useLibraryFilters'
import type { Collection } from '../data/collections'
import type { Tag } from '../data/tags'

const metadataMock = vi.hoisted(() => ({ listCollections: vi.fn(), listTags: vi.fn() }))
const accessMock = vi.hoisted(() => ({
  handlers: new Set<(change: { accessEpoch: number }) => void>(),
  unsubscribe: vi.fn(),
}))

vi.mock('../data/collections', () => ({ listCollections: metadataMock.listCollections }))
vi.mock('../data/tags', () => ({ listTags: metadataMock.listTags }))
vi.mock('../data/events', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/events')>(),
  onCollectionAccessChanged: (handler: (change: { accessEpoch: number }) => void) => {
    accessMock.handlers.add(handler)
    return () => {
      accessMock.handlers.delete(handler)
      accessMock.unsubscribe()
    }
  },
}))

const WORK: Collection = {
  id: 'work', name: 'Work', icon: null, protection: 'none', sortOrder: 0,
  createdAt: '', itemCount: 2,
}
const TAGS: Tag[] = [{ name: 'review', count: 2 }]

beforeEach(() => {
  vi.clearAllMocks()
  metadataMock.listCollections.mockReset().mockResolvedValue([WORK])
  metadataMock.listTags.mockReset().mockResolvedValue(TAGS)
})

function menuProps(overrides: Partial<FilterMenuProps> = {}): FilterMenuProps {
  return {
    kind: 'note', collectionId: null, tag: null, favoritesOnly: false,
    collections: [WORK], tags: TAGS, onKindChange: undefined,
    onCollectionChange: vi.fn(), onTagChange: vi.fn(), onFavoritesChange: vi.fn(),
    onClear: vi.fn(), ...overrides,
  }
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  await screen.findByRole('menuitem', { name: 'Collection' })
}

async function openSubmenu(name: string) {
  const trigger = screen.getByRole('menuitem', { name })
  act(() => trigger.focus())
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })
  await screen.findByRole('menuitemradio', { name: name === 'Collection' ? 'All collections' : 'All tags' })
}

describe('Library FilterMenu', () => {
  it('hides fixed Kind and does not count it as a selected filter', async () => {
    render(<FilterMenu {...menuProps()} />)
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent(/^Filters$/)
    await openMenu()
    expect(screen.queryByRole('menuitem', { name: 'Kind' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Clear filters' })).toHaveAttribute('aria-disabled', 'true')
  })

  it.each([
    [{}, 'Filters'],
    [{ collectionId: 'work' }, 'Filters1'],
    [{ collectionId: 'work', tag: 'review' }, 'Filters2'],
    [{ collectionId: 'work', tag: 'review', favoritesOnly: true }, 'Filters3'],
  ] as const)('counts only user-selected filters: %j', (overrides, text) => {
    render(<FilterMenu {...menuProps(overrides)} />)
    expect(screen.getByRole('button', { name: 'Filters' }).textContent).toBe(text)
  })

  it.each([
    ['Collection', 'Loading collections...'],
    ['Tag', 'Loading tags...'],
  ])('announces %s option loading while keeping All usable', async (submenu, message) => {
    render(<FilterMenu {...menuProps({ optionsState: 'loading' })} />)
    await openMenu()
    await openSubmenu(submenu)
    expect(screen.getByText(message).closest('[role="menuitemradio"]')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitemradio', { name: submenu === 'Collection' ? 'All collections' : 'All tags' }))
      .not.toHaveAttribute('aria-disabled', 'true')
  })

  it.each([
    ['Collection', 'No collections yet.'],
    ['Tag', 'No tags yet.'],
  ])('announces empty %s options without invented choices', async (submenu, message) => {
    render(<FilterMenu {...menuProps({ collections: [], tags: [] })} />)
    await openMenu()
    await openSubmenu(submenu)
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it('offers option retry without blocking Favorites or clearing selected filters', async () => {
    const props = menuProps({ optionsState: 'error', onRetryOptions: vi.fn(), favoritesOnly: true })
    render(<FilterMenu {...props} />)
    await openMenu()
    expect(screen.getByText('Filter options could not load.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry filter options' }))
    expect(props.onRetryOptions).toHaveBeenCalledOnce()
    expect(props.onClear).not.toHaveBeenCalled()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear filters' }))
    expect(props.onClear).toHaveBeenCalledOnce()
  })

  it('marks selected saved names and calls the matching selection callback', async () => {
    const props = menuProps({ collectionId: 'work' })
    render(<FilterMenu {...props} />)
    await openMenu()
    await openSubmenu('Collection')
    expect(screen.getByRole('menuitemradio', { name: 'Work' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'All collections' }), { key: 'Enter' })
    expect(props.onCollectionChange).toHaveBeenCalledWith(null)
  })

  it('supports keyboard open, submenu selection, Escape, and focus return', async () => {
    const props = menuProps()
    render(<FilterMenu {...props} />)
    const button = screen.getByRole('button', { name: 'Filters' })
    act(() => button.focus())
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    await screen.findByRole('menuitem', { name: 'Collection' })
    await openSubmenu('Collection')
    const work = screen.getByRole('menuitemradio', { name: 'Work' })
    fireEvent.keyDown(work, { key: 'Enter' })
    expect(props.onCollectionChange).toHaveBeenCalledWith('work')
    await waitFor(() => expect(button).toHaveFocus())
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(button).toHaveFocus())
  })

  it.each(['Collection', 'Tag'])('disables cached %s names on metadata failure but keeps All usable', async (submenu) => {
    render(<FilterMenu {...menuProps({ optionsState: 'error' })} />)
    await openMenu()
    await openSubmenu(submenu)
    expect(screen.getByRole('menuitemradio', { name: submenu === 'Collection' ? 'Work' : 'review' }))
      .toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitemradio', { name: submenu === 'Collection' ? 'All collections' : 'All tags' }))
      .not.toHaveAttribute('aria-disabled', 'true')
  })
})

describe('useLibraryFilters', () => {
  it('combines fixed kind, selected criteria, and trimmed search; clear preserves search', async () => {
    const { result } = renderHook(() => useLibraryFilters('note', '  Alpha  '))
    await waitFor(() => expect(result.current.menuProps.collections).toEqual([WORK]))
    expect(result.current.filter).toEqual({ kind: 'note', query: 'Alpha' })
    act(() => {
      result.current.menuProps.onCollectionChange('work')
      result.current.menuProps.onTagChange('review')
      result.current.menuProps.onFavoritesChange(true)
    })
    expect(result.current.filter).toEqual({ kind: 'note', query: 'Alpha', collectionId: 'work', tag: 'review', favorite: true })
    expect(result.current.hasActiveFilters).toBe(true)
    act(() => result.current.menuProps.onClear())
    expect(result.current.filter).toEqual({ kind: 'note', query: 'Alpha' })
    expect(result.current.hasActiveFilters).toBe(false)
  })

  it('does not reload metadata on search changes and keeps filter identity stable for equivalent queries', async () => {
    const { result, rerender } = renderHook(({ query }) => useLibraryFilters('source', query), { initialProps: { query: 'Alpha' } })
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('ready'))
    const initial = result.current.filter
    rerender({ query: '  Alpha  ' })
    expect(result.current.filter).toBe(initial)
    rerender({ query: 'Beta' })
    expect(result.current.filter).toEqual({ kind: 'source', query: 'Beta' })
    expect(metadataMock.listTags).toHaveBeenCalledOnce()
  })

  it('refreshes after writes and access changes, then cleans up its subscriptions', async () => {
    const { result, unmount } = renderHook(() => useLibraryFilters('file'))
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('ready'))
    act(() => window.dispatchEvent(new Event('kivo:vault-changed')))
    await waitFor(() => expect(result.current.refreshVersion).toBe(1))
    act(() => accessMock.handlers.forEach((handler) => handler({ accessEpoch: 2 })))
    await waitFor(() => expect(result.current.refreshVersion).toBe(2))
    await waitFor(() => expect(metadataMock.listCollections).toHaveBeenCalledTimes(3))
    unmount()
    expect(accessMock.handlers.size).toBe(0)
    expect(accessMock.unsubscribe).toHaveBeenCalledOnce()
  })

  it('preserves criteria on failed metadata refresh and retries only options', async () => {
    const { result } = renderHook(() => useLibraryFilters('file'))
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('ready'))
    act(() => result.current.menuProps.onCollectionChange('work'))
    metadataMock.listTags.mockRejectedValueOnce(new Error('offline'))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('error'))
    expect(result.current.filter).toEqual({ kind: 'file', collectionId: 'work' })
    const version = result.current.refreshVersion
    act(() => result.current.menuProps.onRetryOptions?.())
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('ready'))
    expect(result.current.refreshVersion).toBe(version)
    expect(result.current.filter.collectionId).toBe('work')
  })

  it('clears deleted selected names after a successful refresh but preserves Favorites', async () => {
    const { result } = renderHook(() => useLibraryFilters('note'))
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('ready'))
    act(() => {
      result.current.menuProps.onCollectionChange('work')
      result.current.menuProps.onTagChange('review')
      result.current.menuProps.onFavoritesChange(true)
    })
    metadataMock.listCollections.mockResolvedValueOnce([])
    metadataMock.listTags.mockResolvedValueOnce([])
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.filter).toEqual({ kind: 'note', favorite: true }))
  })

  it('ignores older option responses that resolve after newer ones', async () => {
    let resolveOld!: (value: Collection[]) => void
    metadataMock.listCollections.mockReturnValueOnce(new Promise<Collection[]>((resolve) => { resolveOld = resolve }))
    const { result } = renderHook(() => useLibraryFilters('note'))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.menuProps.collections).toEqual([WORK]))
    await act(async () => resolveOld([{ ...WORK, name: 'Old name' }]))
    expect(result.current.menuProps.collections[0].name).toBe('Work')
  })

  it('refreshes saved collection and tag names while preserving a renamed collection ID', async () => {
    const { result } = renderHook(() => useLibraryFilters('note'))
    await waitFor(() => expect(result.current.menuProps.optionsState).toBe('ready'))
    act(() => result.current.menuProps.onCollectionChange('work'))
    const renamed = { ...WORK, name: 'Projects' }
    const added = { ...WORK, id: 'personal', name: 'Personal' }
    metadataMock.listCollections.mockResolvedValueOnce([renamed, added])
    metadataMock.listTags.mockResolvedValueOnce([{ name: 'saved-new-tag', count: 1 }])
    act(() => window.dispatchEvent(new Event('kivo:vault-changed')))
    await waitFor(() => expect(result.current.menuProps.collections).toEqual([renamed, added]))
    expect(result.current.menuProps.tags).toEqual([{ name: 'saved-new-tag', count: 1 }])
    expect(result.current.filter.collectionId).toBe('work')
  })

  it('starts with no old selections or options after page teardown for a vault switch', async () => {
    const first = renderHook(() => useLibraryFilters('note', 'Alpha'))
    await waitFor(() => expect(first.result.current.menuProps.optionsState).toBe('ready'))
    act(() => {
      first.result.current.menuProps.onCollectionChange('work')
      first.result.current.menuProps.onFavoritesChange(true)
    })
    first.unmount()
    metadataMock.listCollections.mockResolvedValueOnce([])
    metadataMock.listTags.mockResolvedValueOnce([])
    const next = renderHook(() => useLibraryFilters('note'))
    expect(next.result.current.filter).toEqual({ kind: 'note' })
    expect(next.result.current.menuProps.collections).toEqual([])
    await waitFor(() => expect(next.result.current.menuProps.optionsState).toBe('ready'))
    expect(next.result.current.hasActiveFilters).toBe(false)
  })
})
