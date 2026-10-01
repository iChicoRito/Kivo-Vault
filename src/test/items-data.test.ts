import '@testing-library/jest-dom/vitest'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  deleteItemsPermanently,
  importFile,
  listItems,
  loadItem,
  moveItemsToCollection,
  restoreItems,
  saveItem,
  setItemPinned,
  setItemTags,
  setItemsFavorite,
  trashItems,
  type ItemFilter,
  type ItemInput,
  type ItemSummary,
  type VaultItem,
} from '../data/items'
import { getTauriInvoke } from './setup'

const NOTE: VaultItem = {
  id: '4f2a9c1b8d3e5f60718293a4b5c6d7e8',
  kind: 'note',
  title: 'Meeting notes',
  description: 'Weekly sync with the design team',
  content: 'Decide the sidebar width and the empty state copy.',
  url: null,
  collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  isFavorite: true,
  isPinned: true,
  createdAt: '2026-09-14T09:30:00.000Z',
  updatedAt: '2026-09-16T14:05:00.000Z',
  tags: ['design', 'planning'],
  file: null,
  fileMissing: false,
}

const FILE_ITEM: VaultItem = {
  id: '9e8d7c6b5a49382716f5e4d3c2b1a090',
  kind: 'file',
  title: 'Budget 2026.pdf',
  description: '',
  content: null,
  url: null,
  collectionId: null,
  isFavorite: false,
  isPinned: false,
  createdAt: '2026-09-15T08:00:00.000Z',
  updatedAt: '2026-09-15T08:00:00.000Z',
  tags: [],
  file: {
    originalName: 'Budget 2026.pdf',
    byteSize: 284_915,
    importedAt: '2026-09-15T08:00:00.000Z',
  },
  fileMissing: false,
}

const SUMMARIES: ItemSummary[] = [
  {
    id: NOTE.id,
    kind: 'note',
    title: 'Meeting notes',
    isFavorite: true,
    collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    updatedAt: '2026-09-16T14:05:00.000Z',
    fileMissing: false,
    isPinned: true,
    file: null,
    content: 'Body text',
  },
  {
    id: FILE_ITEM.id,
    kind: 'file',
    title: 'Budget 2026.pdf',
    isFavorite: false,
    collectionId: null,
    updatedAt: '2026-09-15T08:00:00.000Z',
    fileMissing: true,
    isPinned: false,
    file: {
      originalName: 'Budget 2026.pdf',
      byteSize: 284_915,
      importedAt: '2026-09-15T08:00:00.000Z',
    },
    content: null,
  },
]

beforeEach(() => {
  getTauriInvoke().mockReset()
})

describe('items data contract', () => {
  it('passes the full item input through save_item with { input }', async () => {
    const input: ItemInput = {
      id: NOTE.id,
      kind: 'note',
      title: 'Meeting notes',
      description: 'Weekly sync with the design team',
      content: 'Decide the sidebar width and the empty state copy.',
      url: 'https://example.com/notes',
      collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      isFavorite: true,
      isPinned: true,
    }

    getTauriInvoke().mockResolvedValue({ status: 'saved', item: { ...NOTE } })

    await expect(saveItem(input)).resolves.toEqual(NOTE)
    expect(getTauriInvoke()).toHaveBeenCalledWith('save_item', { input })
    expect(getTauriInvoke()).toHaveBeenCalledWith('save_item', {
      input: {
        id: NOTE.id,
        kind: 'note',
        title: 'Meeting notes',
        description: 'Weekly sync with the design team',
        content: 'Decide the sidebar width and the empty state copy.',
        url: 'https://example.com/notes',
        collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        isFavorite: true,
        isPinned: true,
      },
    })
  })

  it('updates file metadata through save_item with kind file', async () => {
    const input: ItemInput = {
      id: FILE_ITEM.id,
      kind: 'file',
      title: 'Budget 2026 renamed.pdf',
      description: 'Annual budget',
      collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      isFavorite: true,
      isPinned: true,
    }

    getTauriInvoke().mockResolvedValue({ status: 'saved', item: { ...FILE_ITEM, ...input } })

    await expect(saveItem(input)).resolves.toEqual({ ...FILE_ITEM, ...input })
    expect(getTauriInvoke()).toHaveBeenCalledWith('save_item', { input })
  })

  it('reads one item with load_item and { id }', async () => {
    getTauriInvoke().mockResolvedValue({ ...NOTE })

    await expect(loadItem(NOTE.id)).resolves.toEqual(NOTE)
    expect(getTauriInvoke()).toHaveBeenCalledWith('load_item', { id: NOTE.id })
  })

  it('reads all items with list_items and a null filter by default', async () => {
    getTauriInvoke().mockResolvedValue([...SUMMARIES])

    await expect(listItems()).resolves.toEqual(SUMMARIES)
    expect(getTauriInvoke()).toHaveBeenCalledWith('list_items', { filter: null })
  })

  it('passes a full filter through list_items', async () => {
    const filter: ItemFilter = {
      kind: 'note',
      collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      tag: 'design',
      favorite: true,
      query: 'meeting',
      sort: 'updated',
    }

    getTauriInvoke().mockResolvedValue([])

    await expect(listItems(filter)).resolves.toEqual([])
    expect(getTauriInvoke()).toHaveBeenCalledWith('list_items', { filter })
  })

  it('pins one item with set_item_pinned and { id, pinned }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await expect(setItemPinned(NOTE.id, true)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('set_item_pinned', {
      id: NOTE.id,
      pinned: true,
    })
  })

  it('marks items favorite with set_items_favorite and { ids, favorite }', async () => {
    getTauriInvoke().mockResolvedValue(undefined)

    await expect(setItemsFavorite([NOTE.id, FILE_ITEM.id], true)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('set_items_favorite', {
      ids: [NOTE.id, FILE_ITEM.id],
      favorite: true,
    })
  })

  it('moves items with move_items_to_collection and { ids, collectionId }', async () => {
    const ids = [NOTE.id, FILE_ITEM.id]

    getTauriInvoke().mockResolvedValue(undefined)

    await expect(moveItemsToCollection(ids, 'a1b2c3d4e5f60718293a4b5c6d7e8f90')).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('move_items_to_collection', {
      ids,
      collectionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    })

    await expect(moveItemsToCollection(ids, null)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenLastCalledWith('move_items_to_collection', {
      ids,
      collectionId: null,
    })
  })

  it('trashes items with trash_items and { ids }', async () => {
    const ids = [NOTE.id, FILE_ITEM.id]

    getTauriInvoke().mockResolvedValue(undefined)

    await expect(trashItems(ids)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('trash_items', { ids })
  })

  it('restores items with restore_items and { ids }', async () => {
    const ids = [NOTE.id, FILE_ITEM.id]

    getTauriInvoke().mockResolvedValue(undefined)

    await expect(restoreItems(ids)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('restore_items', { ids })
  })

  it('deletes items permanently with delete_items_permanently and { ids }', async () => {
    const ids = [NOTE.id, FILE_ITEM.id]

    getTauriInvoke().mockResolvedValue(undefined)

    await expect(deleteItemsPermanently(ids)).resolves.toBeUndefined()
    expect(getTauriInvoke()).toHaveBeenCalledWith('delete_items_permanently', { ids })
  })

  it('passes a trashed filter through list_items', async () => {
    getTauriInvoke().mockResolvedValue([])

    await expect(listItems({ trashed: true })).resolves.toEqual([])
    expect(getTauriInvoke()).toHaveBeenCalledWith('list_items', { filter: { trashed: true } })
  })

  it('imports a file through import_file with { sourcePath }', async () => {
    getTauriInvoke().mockResolvedValue({ status: 'saved', item: { ...FILE_ITEM } })

    await expect(importFile('C:\\Users\\marka\\Documents\\Budget 2026.pdf')).resolves.toEqual(
      FILE_ITEM,
    )
    expect(getTauriInvoke()).toHaveBeenCalledWith('import_file', {
      sourcePath: 'C:\\Users\\marka\\Documents\\Budget 2026.pdf',
    })
  })

  it('replaces the tags through set_item_tags with { id, tags }', async () => {
    getTauriInvoke().mockResolvedValue(['design', 'planning'])

    await expect(setItemTags(NOTE.id, ['design', 'planning'])).resolves.toEqual([
      'design',
      'planning',
    ])
    expect(getTauriInvoke()).toHaveBeenCalledWith('set_item_tags', {
      id: NOTE.id,
      tags: ['design', 'planning'],
    })
  })
})
