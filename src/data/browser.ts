import type {
  Credential,
  CredentialFilter,
  CredentialInput,
  CredentialSummary,
  VaultStatus,
} from './passwords'
import type { BootState, SetupInput } from './setup'
import type { Preferences, Profile } from './settings'

export const BROWSER_PREVIEW_STORAGE_KEY = 'kivo.browser-preview.v1'

type BrowserPreviewState = {
  profile: Profile
  preferences: Preferences
  passwordVerifier: string | null
}

type InvokeArgs = Record<string, unknown>

/*
 * Password vault preview state. This is dev-preview only: everything stays in
 * memory, passwords are plaintext, and nothing is written to localStorage or
 * any other storage.
 */
let previewVaultConfigured = false
let previewVaultUnlocked = false
let previewMasterPassword: string | null = null
let previewCredentials: Credential[] = []
let previewCredentialCounter = 0

function previewVaultStatus(): VaultStatus {
  return { configured: previewVaultConfigured, unlocked: previewVaultUnlocked }
}

function requireUnlockedVault() {
  if (!previewVaultUnlocked) throw new Error('The password vault is locked')
}

function previewCredentialId(): string {
  previewCredentialCounter += 1
  return `preview-credential-${previewCredentialCounter}`
}

function toCredentialSummary(credential: Credential): CredentialSummary {
  return {
    id: credential.id,
    service: credential.service,
    username: credential.username,
    url: credential.url,
    category: credential.category,
    tags: credential.tags,
    isFavorite: credential.isFavorite,
    deletedAt: credential.deletedAt,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  }
}

const DEFAULT_PREFERENCES: Preferences = {
  theme: 'dark',
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

function createDefaultState(): BrowserPreviewState {
  return {
    profile: {
      ownerName: '',
      vaultName: '',
      setupCompletedAt: null,
    },
    preferences: { ...DEFAULT_PREFERENCES },
    passwordVerifier: null,
  }
}

function readState(): BrowserPreviewState {
  try {
    const stored = localStorage.getItem(BROWSER_PREVIEW_STORAGE_KEY)
    if (stored) return { ...createDefaultState(), ...JSON.parse(stored) }
  } catch {
    // Browser preview can continue with in-memory defaults when storage is unavailable.
  }

  return createDefaultState()
}

function writeState(state: BrowserPreviewState) {
  try {
    localStorage.setItem(BROWSER_PREVIEW_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Browser preview remains usable without persistent storage.
  }
}

function hashPreviewPassword(password: string): string {
  let hash = 2166136261

  for (let index = 0; index < password.length; index += 1) {
    hash ^= password.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `browser-preview:${(hash >>> 0).toString(16)}`
}

function getBootState(state: BrowserPreviewState): BootState {
  if (!state.profile.setupCompletedAt) return 'onboarding'
  return state.passwordVerifier ? 'locked' : 'ready'
}

export async function browserInvoke<T>(command: string, args: InvokeArgs = {}): Promise<T> {
  const state = readState()

  switch (command) {
    case 'list_items':
    case 'list_item_versions':
    case 'list_credential_versions':
    case 'list_index_state':
      return [] as T
    case 'load_storage_report':
      return { totalBytes: 0, databaseBytes: 0, fileBytes: 0, fileCount: 0, groups: [], largest: [] } as T
    case 'read_item_file':
    case 'restore_item_version':
    case 'restore_credential_version':
    case 'pick_password_csv':
    case 'preview_password_import':
    case 'import_credentials':
    case 'check_vault_health':
    case 'repair_vault_health':
    case 'list_backup_contents':
    case 'restore_from_backup':
    case 'index_file':
    // Link details go through the Rust safety checks only; the preview never fetches sites itself.
    case 'fetch_link_details':
      throw new Error('This action needs the Kivo desktop app.')
    case 'initialize_database':
      return undefined as T
    case 'load_boot_state':
      return getBootState(state) as T
    case 'complete_setup': {
      const input = args.input as SetupInput

      if (!input.ownerName.trim()) throw new Error('Owner name is required')

      writeState({
        ...state,
        profile: {
          ownerName: input.ownerName.trim(),
          vaultName: input.vaultName,
          setupCompletedAt: new Date().toISOString(),
        },
        passwordVerifier: input.passwordVerifier,
      })
      return undefined as T
    }
    case 'load_profile':
      return state.profile as T
    case 'save_profile': {
      const profile = args.profile as Pick<Profile, 'ownerName' | 'vaultName'>

      if (!profile.ownerName.trim()) throw new Error('Owner name is required')

      writeState({
        ...state,
        profile: { ...state.profile, ...profile, ownerName: profile.ownerName.trim() },
      })
      return undefined as T
    }
    case 'load_preferences':
      return state.preferences as T
    case 'save_preferences':
      writeState({ ...state, preferences: args.preferences as Preferences })
      return undefined as T
    case 'hash_password':
      return hashPreviewPassword(String(args.password ?? '')) as unknown as T
    case 'verify_password':
      return (hashPreviewPassword(String(args.password ?? '')) === String(args.verifier ?? '')) as unknown as T
    case 'unlock_content_vault':
      return (!state.passwordVerifier ||
        hashPreviewPassword(String(args.password ?? '')) === state.passwordVerifier) as unknown as T
    case 'load_password_verifier':
      return state.passwordVerifier as T
    case 'has_password_verifier':
      return Boolean(state.passwordVerifier) as T
    case 'set_password_verifier':
      writeState({ ...state, passwordVerifier: String(args.verifier ?? '') })
      return undefined as T
    case 'remove_password_verifier':
      writeState({ ...state, passwordVerifier: null })
      return undefined as T
    case 'vault_status':
      return previewVaultStatus() as T
    case 'setup_vault': {
      previewMasterPassword = String(args.masterPassword ?? '')
      previewVaultConfigured = true
      previewVaultUnlocked = true
      return previewVaultStatus() as T
    }
    case 'unlock_vault': {
      if (!previewVaultConfigured) throw new Error('The password vault is not configured')
      if (String(args.masterPassword ?? '') !== previewMasterPassword) {
        throw new Error('Could not unlock the vault')
      }

      previewVaultUnlocked = true
      return previewVaultStatus() as T
    }
    case 'lock_vault':
      previewVaultUnlocked = false
      return previewVaultStatus() as T
    case 'list_credentials': {
      requireUnlockedVault()

      const filter = (args.filter ?? null) as CredentialFilter | null
      const query = filter?.query?.trim().toLowerCase() ?? ''
      const trashed = filter?.trashed ?? false
      const category = filter?.category
      const tag = filter?.tag
      const favorite = filter?.favorite
      const list = previewCredentials
        .filter((credential) =>
          trashed ? credential.deletedAt !== null : credential.deletedAt === null,
        )
        .filter((credential) => !category || credential.category === category)
        .filter((credential) => !tag || credential.tags.includes(tag))
        .filter((credential) => favorite === undefined || credential.isFavorite === favorite)
        .filter((credential) => {
          if (!query) return true

          return (
            credential.service.toLowerCase().includes(query) ||
            credential.username.toLowerCase().includes(query) ||
            credential.category.toLowerCase().includes(query) ||
            credential.tags.some((credentialTag) =>
              credentialTag.toLowerCase().includes(query),
            )
          )
        })
        .map(toCredentialSummary)

      return list as T
    }
    case 'load_credential': {
      requireUnlockedVault()

      const credential = previewCredentials.find((entry) => entry.id === String(args.id ?? ''))
      if (!credential) throw new Error('Credential not found')

      return { ...credential } as T
    }
    case 'save_credential': {
      requireUnlockedVault()

      const input = args.input as CredentialInput
      const now = new Date().toISOString()
      const existingIndex = input.id
        ? previewCredentials.findIndex((entry) => entry.id === input.id)
        : -1

      if (existingIndex >= 0) {
        const updated: Credential = {
          ...previewCredentials[existingIndex],
          ...input,
          id: previewCredentials[existingIndex].id,
          updatedAt: now,
        }

        previewCredentials[existingIndex] = updated
        return { ...updated } as T
      }

      const created: Credential = {
        id: input.id ?? previewCredentialId(),
        service: input.service,
        username: input.username,
        password: input.password,
        url: input.url,
        category: input.category,
        tags: input.tags,
        notes: input.notes,
        isFavorite: input.isFavorite,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      }

      previewCredentials = [created, ...previewCredentials]
      return { ...created } as T
    }
    case 'set_credentials_favorite': {
      requireUnlockedVault()

      const ids = args.ids as string[]
      const favorite = Boolean(args.favorite)

      previewCredentials = previewCredentials.map((credential) =>
        ids.includes(credential.id) ? { ...credential, isFavorite: favorite } : credential,
      )
      return undefined as T
    }
    case 'trash_credentials': {
      requireUnlockedVault()

      const ids = args.ids as string[]
      const now = new Date().toISOString()

      previewCredentials = previewCredentials.map((credential) =>
        ids.includes(credential.id) ? { ...credential, deletedAt: now } : credential,
      )
      return undefined as T
    }
    case 'restore_credentials': {
      requireUnlockedVault()

      const ids = args.ids as string[]

      previewCredentials = previewCredentials.map((credential) =>
        ids.includes(credential.id) ? { ...credential, deletedAt: null } : credential,
      )
      return undefined as T
    }
    case 'delete_credentials_permanently': {
      requireUnlockedVault()

      const ids = args.ids as string[]

      previewCredentials = previewCredentials.filter(
        (credential) => !ids.includes(credential.id),
      )
      return undefined as T
    }
    case 'credential_icon': {
      const host = typeof args.host === 'string' ? args.host : ''

      // The dev preview has no Rust side, so the webview loads the icon itself.
      return (host ? `https://${host}/favicon.ico` : null) as T
    }
    default:
      throw new Error(`Unsupported browser preview command: ${command}`)
  }
}
