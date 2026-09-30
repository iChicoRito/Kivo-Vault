import { browserInvoke } from '@/data/browser'
import type { Collection } from '@/data/collections'
import type { VaultSummary } from '@/data/dashboard'
import type { ItemFilter, ItemInput, ItemSummary, VaultItem } from '@/data/items'
import type { CredentialInput } from '@/data/passwords'
import type { Preferences, Profile } from '@/data/settings'
import type { Tag } from '@/data/tags'

/*
 * An in-memory stand-in for the Rust backend, so the real Kivo interface can
 * run on the landing page. Nothing is written anywhere: a reload starts over.
 * It follows the Rust commands closely enough for the core pages (dashboard,
 * items, notes, collections, passwords); anything that needs the file system
 * fails with a message pointing at the desktop app.
 */

type StoredItem = VaultItem & { deletedAt: string | null }
type Args = Record<string, unknown>

export const DEMO_VAULT_PASSWORD = 'kivo'

const DESKTOP_ONLY = 'This needs the Kivo desktop app. Download it to try this.'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

let items: StoredItem[] = []
let collections: Collection[] = []
let profile: Profile
let preferences: Preferences
let counter = 0

function nextId(prefix: string) {
  counter += 1
  return `demo-${prefix}-${counter}`
}

function iso(msAgo: number) {
  return new Date(Date.now() - msAgo).toISOString()
}

function item(partial: Partial<StoredItem> & Pick<StoredItem, 'kind' | 'title'>, ago: number): StoredItem {
  return {
    id: nextId(partial.kind),
    description: '',
    content: null,
    url: null,
    collectionId: null,
    isFavorite: false,
    isPinned: false,
    createdAt: iso(ago + DAY),
    updatedAt: iso(ago),
    tags: [],
    file: null,
    fileMissing: false,
    deletedAt: null,
    ...partial,
  }
}

function file(originalName: string, byteSize: number, ago: number) {
  return { originalName, byteSize, importedAt: iso(ago) }
}

function collection(name: string, icon: string, sortOrder: number): Collection {
  return { id: nextId('collection'), name, icon, protection: 'none', sortOrder, createdAt: iso(30 * DAY), itemCount: 0 }
}

/** Resets the demo to its seed data. The page calls it once; tests call it before each case. */
export async function resetDemoBackend(theme: 'light' | 'dark' = 'dark') {
  counter = 0
  profile = { ownerName: 'Alex', vaultName: "Alex's Vault", setupCompletedAt: iso(30 * DAY) }
  preferences = {
    theme,
    density: 'comfortable',
    startAtLogin: false,
    notesView: 'grid',
    sourcesView: 'grid',
    collectionsView: 'grid',
    navigationStyle: 'dock',
    autoLockMinutes: 0,
    semanticSearch: false,
    autoTag: false,
    summaries: false,
    clipboardClearSeconds: 0,
    clipboardExcludeHistory: false,
  }

  const move = collection('Moving house', 'home', 0)
  const trip = collection('Lisbon, October', 'plane', 1)
  const docs = collection('Important documents', 'file', 2)
  collections = [move, trip, docs]

  items = [
    item({
      kind: 'note',
      title: 'Apartment move checklist',
      content: '<p>Book the elevator for Saturday, 9am.</p><ul><li><p>Forward mail at the post office</p></li><li><p>Photograph the meters before handing back the keys</p></li><li><p>Cancel the old internet plan</p></li></ul>',
      collectionId: move.id,
      isPinned: true,
      tags: ['home', 'todo'],
    }, 2 * HOUR),
    item({
      kind: 'note',
      title: 'Lisbon trip',
      content: '<p>Tram 28 early, before 8am.</p><p>Pastéis de Belém, the original one.</p><p>Fado in Alfama on Thursday night.</p>',
      collectionId: trip.id,
      isFavorite: true,
      tags: ['travel'],
    }, DAY),
    item({
      kind: 'note',
      title: "Mom's adobo",
      content: '<p>Vinegar first, and do not stir until it boils.</p><p>One whole head of garlic, bay leaves, peppercorns. Low heat for 40 minutes.</p>',
      isFavorite: true,
      tags: ['recipes', 'family'],
    }, 4 * DAY),
    item({
      kind: 'note',
      title: 'Book notes: Deep Work',
      content: '<p>Schedule every minute of the workday. Treat shallow work as a cost.</p>',
      tags: ['reading'],
    }, 9 * DAY),
    item({ kind: 'source', title: 'Carris tram timetable', url: 'https://www.carris.pt', collectionId: trip.id, tags: ['travel'] }, DAY + 2 * HOUR),
    item({ kind: 'source', title: 'The Rust Programming Language', url: 'https://doc.rust-lang.org/book/', tags: ['reading'] }, 6 * DAY),
    item({ kind: 'source', title: 'Moving company quotes', url: 'https://www.example.com/quotes', collectionId: move.id }, 3 * DAY),
    item({ kind: 'file', title: 'Lease agreement 2026.pdf', file: file('Lease agreement 2026.pdf', 1_240_000, 5 * HOUR), collectionId: docs.id, tags: ['home'] }, 5 * HOUR),
    item({ kind: 'file', title: 'Passport scan.jpg', file: file('Passport scan.jpg', 840_000, 12 * DAY), collectionId: docs.id }, 12 * DAY),
    item({ kind: 'file', title: 'Laptop warranty.pdf', file: file('Laptop warranty.pdf', 310_000, 20 * DAY), collectionId: docs.id }, 20 * DAY),
  ]

  await seedPasswordVault()
}

/** The password vault already lives in memory in `browser.ts`; the demo only fills it. */
async function seedPasswordVault() {
  const status = await browserInvoke<{ configured: boolean }>('vault_status')
  if (!status.configured) await browserInvoke('setup_vault', { masterPassword: DEMO_VAULT_PASSWORD })
  else await browserInvoke('unlock_vault', { masterPassword: DEMO_VAULT_PASSWORD })

  const existing = await browserInvoke<unknown[]>('list_credentials', { filter: null })
  if (existing.length > 0) return

  const seeds: Array<Omit<CredentialInput, 'tags' | 'notes' | 'isFavorite'> & { isFavorite?: boolean }> = [
    { service: 'GitHub', username: 'alex-reyes', password: 'quiet-harbor-19!', url: 'https://github.com', category: 'Work', isFavorite: true },
    { service: 'Proton Mail', username: 'alex@proton.me', password: 'mangoTree!42', url: 'https://proton.me', category: 'Personal' },
    { service: 'Netflix', username: 'alex@proton.me', password: 'K7v#pl2Wq9x', url: 'https://www.netflix.com', category: 'Entertainment' },
    { service: 'Home router', username: 'admin', password: 'blue-lantern-88', url: '', category: 'Home' },
  ]

  for (const seed of seeds) {
    await browserInvoke('save_credential', {
      input: { tags: [], notes: '', isFavorite: false, ...seed },
    })
  }
}

function withCounts(): Collection[] {
  return collections.map((entry) => ({
    ...entry,
    itemCount: items.filter((stored) => stored.collectionId === entry.id && !stored.deletedAt).length,
  }))
}

function summary(stored: StoredItem): ItemSummary {
  return {
    id: stored.id,
    kind: stored.kind,
    title: stored.title,
    isFavorite: stored.isFavorite,
    collectionId: stored.collectionId,
    updatedAt: stored.updatedAt,
    fileMissing: stored.fileMissing,
    isPinned: stored.isPinned,
    content: stored.content,
    file: stored.file,
    deletedAt: stored.deletedAt,
    matchSnippet: null,
  }
}

function plain(html: string | null) {
  return (html ?? '').replace(/<[^>]*>/g, ' ')
}

function matches(stored: StoredItem, query: string) {
  const collectionName = collections.find((entry) => entry.id === stored.collectionId)?.name ?? ''
  return [stored.title, stored.description, plain(stored.content), stored.url ?? '', stored.file?.originalName ?? '', collectionName, ...stored.tags]
    .some((value) => value.toLowerCase().includes(query))
}

function byText(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

// Same filters and ordering as `read_item_summaries` in src-tauri/src/vault.rs.
function listItems(filter: ItemFilter | null): ItemSummary[] {
  const trashed = filter?.trashed === true
  const query = filter?.query?.trim().toLowerCase() ?? ''
  const tag = filter?.tag?.toLowerCase()

  const list = items.filter((stored) =>
    (trashed ? stored.deletedAt !== null : stored.deletedAt === null) &&
    (!filter?.kind || stored.kind === filter.kind) &&
    (!filter?.collectionId || stored.collectionId === filter.collectionId) &&
    (!tag || stored.tags.some((entry) => entry.toLowerCase() === tag)) &&
    (filter?.favorite === undefined || filter.favorite === null || stored.isFavorite === filter.favorite) &&
    (!query || matches(stored, query)),
  )

  list.sort((a, b) => {
    if (trashed) return byText(b.deletedAt ?? '', a.deletedAt ?? '')
    switch (filter?.sort) {
      case 'title':
        return byText(a.title, b.title) || byText(b.updatedAt, a.updatedAt)
      case 'created':
        return byText(b.createdAt, a.createdAt) || byText(b.updatedAt, a.updatedAt)
      case 'kind':
        return byText(a.kind, b.kind) || byText(b.updatedAt, a.updatedAt)
      default:
        return byText(b.updatedAt, a.updatedAt) || byText(a.title, b.title)
    }
  })

  return list.map(summary)
}

function findItem(id: unknown) {
  const found = items.find((stored) => stored.id === id)
  if (!found) throw new Error('Item not found')
  return found
}

function publicItem(stored: StoredItem): VaultItem {
  const { deletedAt: _deletedAt, ...rest } = stored
  return { ...rest, tags: [...rest.tags] }
}

function updateMany(ids: unknown, patch: (stored: StoredItem) => Partial<StoredItem>) {
  const targets = new Set(ids as string[])
  items = items.map((stored) => (targets.has(stored.id) ? { ...stored, ...patch(stored) } : stored))
}

function saveItem(input: ItemInput): VaultItem {
  const now = new Date().toISOString()

  if (input.id) {
    const existing = findItem(input.id)
    const updated: StoredItem = {
      ...existing,
      kind: input.kind,
      title: input.title,
      description: input.description ?? existing.description,
      content: input.content ?? existing.content,
      url: input.url ?? existing.url,
      collectionId: input.collectionId === undefined ? existing.collectionId : input.collectionId,
      isFavorite: input.isFavorite ?? existing.isFavorite,
      isPinned: input.isPinned ?? existing.isPinned,
      updatedAt: now,
    }
    items = items.map((stored) => (stored.id === updated.id ? updated : stored))
    return publicItem(updated)
  }

  const created: StoredItem = {
    ...item({ kind: input.kind, title: input.title }, 0),
    description: input.description ?? '',
    content: input.content ?? null,
    url: input.url ?? null,
    collectionId: input.collectionId ?? null,
    isFavorite: input.isFavorite ?? false,
    isPinned: input.isPinned ?? false,
    createdAt: now,
    updatedAt: now,
  }
  items = [created, ...items]
  return publicItem(created)
}

function listTags(): Tag[] {
  const counts = new Map<string, number>()
  for (const stored of items) {
    if (stored.deletedAt) continue
    for (const tag of stored.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => byText(a.name, b.name))
}

function vaultSummary(): VaultSummary {
  const live = items.filter((stored) => !stored.deletedAt)
  return {
    itemCount: live.length,
    noteCount: live.filter((stored) => stored.kind === 'note').length,
    sourceCount: live.filter((stored) => stored.kind === 'source').length,
    fileCount: live.filter((stored) => stored.kind === 'file').length,
    favoriteCount: live.filter((stored) => stored.isFavorite).length,
    collectionCount: collections.length,
    tagCount: listTags().length,
    trashCount: items.length - live.length,
    fileBytes: live.reduce((total, stored) => total + (stored.file?.byteSize ?? 0), 0),
    databaseBytes: 184_320,
  }
}

const PASSWORD_COMMANDS = new Set([
  'vault_status',
  'setup_vault',
  'unlock_vault',
  'lock_vault',
  'list_credentials',
  'load_credential',
  'save_credential',
  'set_credentials_favorite',
  'trash_credentials',
  'restore_credentials',
  'delete_credentials_permanently',
  'credential_icon',
])

export async function demoInvoke<T>(command: string, args: Args = {}): Promise<T> {
  if (PASSWORD_COMMANDS.has(command)) return browserInvoke<T>(command, args)

  return handle(command, args) as T
}

function handle(command: string, args: Args): unknown {
  switch (command) {
    case 'initialize_database':
      return undefined
    case 'load_boot_state':
      return 'ready'
    case 'load_profile':
      return { ...profile }
    case 'save_profile':
      profile = { ...profile, ...(args.profile as Partial<Profile>) }
      return undefined
    case 'load_preferences':
      return { ...preferences }
    case 'save_preferences':
      preferences = args.preferences as Preferences
      return undefined
    case 'has_password_verifier':
      return false
    case 'load_password_verifier':
      return null
    case 'read_protection_state':
      return { lockEnabled: false, encryptionEnabled: false }

    case 'list_items':
      return listItems((args.filter as ItemFilter | null) ?? null)
    case 'load_item':
      return publicItem(findItem(args.id))
    case 'save_item':
      return saveItem(args.input as ItemInput)
    case 'set_item_pinned':
      updateMany([args.id], () => ({ isPinned: Boolean(args.pinned) }))
      return undefined
    case 'set_items_favorite':
      updateMany(args.ids, () => ({ isFavorite: Boolean(args.favorite) }))
      return undefined
    case 'move_items_to_collection':
      updateMany(args.ids, () => ({ collectionId: (args.collectionId as string | null) ?? null }))
      return undefined
    case 'trash_items':
      updateMany(args.ids, () => ({ deletedAt: new Date().toISOString() }))
      return undefined
    case 'restore_items':
      updateMany(args.ids, () => ({ deletedAt: null }))
      return undefined
    case 'delete_items_permanently': {
      const targets = new Set(args.ids as string[])
      items = items.filter((stored) => !targets.has(stored.id))
      return undefined
    }
    case 'set_item_tags': {
      const tags = [...new Set((args.tags as string[]).map((tag) => tag.trim()).filter(Boolean))]
      updateMany([args.id], () => ({ tags }))
      return tags
    }
    case 'list_tags':
      return listTags()

    case 'list_collections':
      return withCounts()
    case 'save_collection': {
      const input = args.input as { id?: string; name: string; icon?: string | null }
      if (input.id) {
        collections = collections.map((entry) =>
          entry.id === input.id ? { ...entry, name: input.name, icon: input.icon ?? entry.icon } : entry,
        )
      } else {
        collections = [...collections, { ...collection(input.name, input.icon ?? 'folder', collections.length) }]
      }
      // Protected collections need a real secret store, so the demo keeps every collection open.
      const saved = withCounts().find((entry) => entry.id === input.id) ?? withCounts().at(-1)
      return saved
    }
    case 'delete_collection':
      collections = collections.filter((entry) => entry.id !== args.id)
      items = items.map((stored) => (stored.collectionId === args.id ? { ...stored, collectionId: null } : stored))
      return undefined
    case 'verify_collection_secret':
      return true

    case 'load_vault_summary':
      return vaultSummary()
    case 'list_item_versions':
    case 'list_index_state':
    case 'suggest_tags':
    case 'search_related_items':
      return []
    case 'load_storage_report': {
      const files = items.filter((stored) => stored.file && !stored.deletedAt)
      const fileBytes = files.reduce((total, stored) => total + (stored.file?.byteSize ?? 0), 0)
      return {
        totalBytes: fileBytes + 184_320,
        databaseBytes: 184_320,
        fileBytes,
        fileCount: files.length,
        groups: [],
        largest: files.map((stored) => ({
          itemId: stored.id,
          title: stored.title,
          originalName: stored.file!.originalName,
          byteSize: stored.file!.byteSize,
          importedAt: stored.file!.importedAt,
        })),
      }
    }
    case 'open_source_url': {
      const url = findItem(args.id).url
      if (url) window.open(url, '_blank', 'noopener')
      return undefined
    }
    default:
      throw new Error(DESKTOP_ONLY)
  }
}
