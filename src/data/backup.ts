import { invoke } from './runtime'

export type BackupInfo = {
  path: string
  createdAt: string
  appVersion: string
  schemaVersion: number
  itemCount: number
  fileCount: number
  valid: boolean
  problems: string[]
  /** Sealed with the Master Password; counts are hidden until restore. */
  encrypted?: boolean
}

export type RestoreSummary = { itemCount: number; fileCount: number; safetyCopyPath: string }

export const pickBackupDestination = () => invoke<string | null>('pick_backup_destination')
export const createBackup = (destination: string, replace: boolean) =>
  invoke<BackupInfo>('create_backup', { destination, replace })
/** One-click backup into a new dated folder, in `folder` or Documents › Kivo Backups. */
export const createBackupNow = (folder: string | null, password?: string) =>
  invoke<BackupInfo>('create_backup_now', password ? { folder, password } : { folder })
export const pickBackupSource = () => invoke<string | null>('pick_backup_source')
export const inspectBackup = (path: string) => invoke<BackupInfo>('inspect_backup', { path })
export const restoreBackup = (path: string, password?: string) =>
  invoke<RestoreSummary>('restore_backup', password ? { path, password } : { path })
