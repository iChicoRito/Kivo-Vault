import { notifyVaultChanged } from './events'
import { invoke } from './runtime'

export type CollectionProtection = 'none' | 'password' | 'pin'

export type Collection = {
  id: string
  name: string
  icon: string | null
  protection: CollectionProtection
  sortOrder: number
  createdAt: string
  itemCount: number
}

export async function listCollections(): Promise<Collection[]> {
  return invoke<Collection[]>('list_collections')
}

export async function saveCollection(input: {
  id?: string
  name: string
  icon?: string | null
  protection?: CollectionProtection
  secret?: string | null
  /** The present password or PIN, needed to remove or change an existing lock. */
  currentSecret?: string
}): Promise<Collection> {
  const collection = await invoke<Collection>('save_collection', { input })
  notifyVaultChanged()
  return collection
}

export async function verifyCollectionSecret(id: string, secret: string): Promise<boolean> {
  return invoke<boolean>('verify_collection_secret', { id, secret })
}

/** Closes an unlocked collection again, so its items hide until the next unlock. */
export async function lockCollection(id: string): Promise<void> {
  await invoke<void>('lock_collection', { id })
  notifyVaultChanged()
}

export async function deleteCollection(id: string): Promise<void> {
  await invoke<void>('delete_collection', { id })
  notifyVaultChanged()
}
