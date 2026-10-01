import { invoke } from './runtime'

export type Theme = 'light' | 'dark' | 'system'
export type Density = 'comfortable' | 'compact'
export type NoteView = 'grid' | 'list'
export type SourceView = 'grid' | 'list'
export type CollectionsView = 'grid' | 'list'
export type NavigationStyle = 'dock' | 'sidebar'

export type Profile = {
  ownerName: string
  vaultName: string
  setupCompletedAt: string | null
}

export type ProfileInput = {
  ownerName: string
  vaultName: string
}

export type Preferences = {
  theme: Theme
  density: Density
  startAtLogin: boolean
  notesView: NoteView
  sourcesView: SourceView
  collectionsView: CollectionsView
  navigationStyle: NavigationStyle
  autoLockMinutes: number
  semanticSearch: boolean
  autoTag: boolean
  summaries: boolean
  clipboardClearSeconds: number
  clipboardExcludeHistory: boolean
  linkDetails: boolean
}

export async function loadProfile(): Promise<Profile> {
  return invoke<Profile>('load_profile')
}

export async function saveProfile(profile: ProfileInput): Promise<void> {
  if (!profile.ownerName.trim()) {
    throw new Error('Owner name is required')
  }

  await invoke<void>('save_profile', { profile })
}

export async function loadPreferences(): Promise<Preferences> {
  return invoke<Preferences>('load_preferences')
}

export async function savePreferences(preferences: Preferences): Promise<void> {
  await invoke<void>('save_preferences', { preferences })
}

export async function saveStartAtLogin(enabled: boolean): Promise<void> {
  const preferences = await loadPreferences()

  await savePreferences({ ...preferences, startAtLogin: enabled })
}
