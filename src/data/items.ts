import { notifyVaultChanged } from './events'
import { invoke } from './runtime'

export type ItemKind = 'note' | 'source' | 'file'

export type FileDetails = {
  originalName: string
  byteSize: number
  importedAt: string
}

export type VaultItem = {
  id: string
  kind: ItemKind
  title: string
  description: string
  content: string | null
  url: string | null
  collectionId: string | null
  isFavorite: boolean
  isPinned: boolean
  createdAt: string
  updatedAt: string
  tags: string[]
  file: FileDetails | null
  fileMissing: boolean
}

export type ItemSummary = Pick<
  VaultItem,
  | 'id'
  | 'kind'
  | 'title'
  | 'isFavorite'
  | 'collectionId'
  | 'updatedAt'
  | 'fileMissing'
  | 'isPinned'
  | 'content'
  | 'file'
> & { deletedAt?: string | null; matchSnippet?: string | null }

export type ItemSort = 'title' | 'created' | 'updated' | 'kind'

export type ItemFilter = {
  kind?: ItemKind
  collectionId?: string
  tag?: string
  favorite?: boolean
  query?: string
  sort?: ItemSort
  trashed?: boolean
}

export type ItemInput = {
  id?: string
  kind: ItemKind
  title: string
  description?: string
  content?: string
  url?: string
  collectionId?: string | null
  isFavorite?: boolean
  isPinned?: boolean
  /** `check` (default) stops on an already saved address; `keepBoth` saves anyway. */
  duplicatePolicy?: DuplicatePolicy
}

export type DuplicatePolicy = 'check' | 'keepBoth'

export type DuplicateMatch = { item: ItemSummary; reason: 'url' | 'file-content' }

export type CaptureOutcome =
  | { status: 'saved'; item: VaultItem }
  | { status: 'duplicate'; matches: DuplicateMatch[]; accessEpoch: number }

export type FileImportPreview = {
  token: string
  originalName: string
  byteSize: number
  matches: DuplicateMatch[]
  accessEpoch: number
}

/** Thrown by `saveItem` and `importFile` when the capture matches saved items. Nothing was saved. */
export class DuplicateConflictError extends Error {
  readonly matches: DuplicateMatch[]
  readonly accessEpoch: number

  constructor(matches: DuplicateMatch[], accessEpoch: number) {
    super('This is already saved in Kivo.')
    this.name = 'DuplicateConflictError'
    this.matches = matches
    this.accessEpoch = accessEpoch
  }
}

function savedItem(outcome: CaptureOutcome): VaultItem {
  if (outcome.status === 'duplicate') {
    throw new DuplicateConflictError(outcome.matches, outcome.accessEpoch)
  }
  notifyVaultChanged()
  return outcome.item
}

export async function saveItem(input: ItemInput): Promise<VaultItem> {
  return savedItem(await invoke<CaptureOutcome>('save_item', { input }))
}

export async function loadItem(id: string): Promise<VaultItem> {
  return invoke<VaultItem>('load_item', { id })
}

export async function listItems(filter?: ItemFilter): Promise<ItemSummary[]> {
  return invoke<ItemSummary[]>('list_items', { filter: filter ?? null })
}

export async function setItemPinned(id: string, pinned: boolean): Promise<void> {
  return invoke<void>('set_item_pinned', { id, pinned })
}

export async function setItemsFavorite(ids: string[], favorite: boolean): Promise<void> {
  return invoke<void>('set_items_favorite', { ids, favorite })
}

export async function moveItemsToCollection(
  ids: string[],
  collectionId: string | null,
): Promise<void> {
  await invoke<void>('move_items_to_collection', { ids, collectionId })
  notifyVaultChanged()
}

export async function trashItems(ids: string[]): Promise<void> {
  await invoke<void>('trash_items', { ids })
  notifyVaultChanged()
}

export async function restoreItems(ids: string[]): Promise<void> {
  await invoke<void>('restore_items', { ids })
  notifyVaultChanged()
}

export async function deleteItemsPermanently(ids: string[]): Promise<void> {
  await invoke<void>('delete_items_permanently', { ids })
  notifyVaultChanged()
}

export async function importFile(sourcePath: string): Promise<VaultItem> {
  return savedItem(await invoke<CaptureOutcome>('import_file', { sourcePath }))
}

/** Stages a picked file and reports saved items with the same contents. Saves nothing. */
export async function previewFileImport(sourcePath: string): Promise<FileImportPreview> {
  return invoke<FileImportPreview>('preview_file_import', { sourcePath })
}

/** Saves the staged file, unless it matches saved items and `duplicatePolicy` is `check`. */
export async function commitFileImport(
  token: string,
  collectionId: string | null,
  duplicatePolicy: DuplicatePolicy,
): Promise<CaptureOutcome> {
  const outcome = await invoke<CaptureOutcome>('commit_file_import', {
    token,
    collectionId,
    duplicatePolicy,
  })
  if (outcome.status === 'saved') notifyVaultChanged()
  return outcome
}

export async function cancelFileImport(token: string): Promise<void> {
  return invoke<void>('cancel_file_import', { token })
}

export async function setItemTags(id: string, tags: string[]): Promise<string[]> {
  return invoke<string[]>('set_item_tags', { id, tags })
}
