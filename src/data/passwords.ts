import { notifyVaultChanged } from './events'
import { invoke } from './runtime'

export type VaultStatus = { configured: boolean; unlocked: boolean }

export type CredentialSummary = {
  id: string
  service: string
  username: string
  url: string
  category: string
  tags: string[]
  isFavorite: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Credential = CredentialSummary & { notes: string; password: string }

export type CredentialVersion = {
  id: string
  createdAt: string
  service: string
  username: string
  url: string
  password: string
}

export type CredentialInput = {
  id?: string
  service: string
  username: string
  password: string
  url: string
  category: string
  tags: string[]
  notes: string
  isFavorite: boolean
}

export type CredentialFilter = {
  query?: string
  category?: string
  tag?: string
  favorite?: boolean
  trashed?: boolean
}

export const PASSWORD_CATEGORIES: string[] = [
  'Uncategorized',
  'Personal',
  'Work',
  'Banking',
  'Development',
  'Social',
]

export async function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_status')
}

export async function setupVault(masterPassword: string): Promise<VaultStatus> {
  const status = await invoke<VaultStatus>('setup_vault', { masterPassword })
  notifyVaultChanged()
  return status
}

export async function unlockVault(masterPassword: string): Promise<VaultStatus> {
  const status = await invoke<VaultStatus>('unlock_vault', { masterPassword })
  notifyVaultChanged()
  return status
}

export async function lockVault(): Promise<VaultStatus> {
  const status = await invoke<VaultStatus>('lock_vault')
  notifyVaultChanged()
  return status
}

export async function listCredentials(filter?: CredentialFilter): Promise<CredentialSummary[]> {
  return invoke<CredentialSummary[]>('list_credentials', { filter: filter ?? null })
}

export async function loadCredential(id: string): Promise<Credential> {
  return invoke<Credential>('load_credential', { id })
}

export async function saveCredential(input: CredentialInput): Promise<Credential> {
  const credential = await invoke<Credential>('save_credential', { input })
  notifyVaultChanged()
  return credential
}

export async function listCredentialVersions(id: string): Promise<CredentialVersion[]> {
  return invoke<CredentialVersion[]>('list_credential_versions', { id })
}

export async function restoreCredentialVersion(versionId: string): Promise<Credential> {
  const credential = await invoke<Credential>('restore_credential_version', { versionId })
  notifyVaultChanged()
  return credential
}

/** One login read from a Chrome or Edge password export. */
export type ImportRow = {
  service: string
  url: string
  username: string
  password: string
  notes: string
  /** The saved credential this login matches, if any. */
  duplicateOf: string | null
}

export type ImportPreview = { rows: ImportRow[]; skipped: number }

export type ImportChoice = Omit<ImportRow, 'duplicateOf'> & { replaceId: string | null }

export type ImportResult = { imported: number; replaced: number; failed: string[] }

export async function pickPasswordCsv(): Promise<string | null> {
  return invoke<string | null>('pick_password_csv')
}

export async function previewPasswordImport(path: string): Promise<ImportPreview> {
  return invoke<ImportPreview>('preview_password_import', { path })
}

export async function importCredentials(choices: ImportChoice[]): Promise<ImportResult> {
  const result = await invoke<ImportResult>('import_credentials', { choices })
  notifyVaultChanged()
  return result
}

export async function setCredentialsFavorite(ids: string[], favorite: boolean): Promise<void> {
  await invoke<void>('set_credentials_favorite', { ids, favorite })
  notifyVaultChanged()
}

export async function trashCredentials(ids: string[]): Promise<void> {
  await invoke<void>('trash_credentials', { ids })
  notifyVaultChanged()
}

export async function restoreCredentials(ids: string[]): Promise<void> {
  await invoke<void>('restore_credentials', { ids })
  notifyVaultChanged()
}

export async function deleteCredentialsPermanently(ids: string[]): Promise<void> {
  await invoke<void>('delete_credentials_permanently', { ids })
  notifyVaultChanged()
}

export async function credentialIcon(host: string): Promise<string | null> {
  return invoke<string | null>('credential_icon', { host })
}
