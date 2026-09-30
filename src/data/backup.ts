import { notifyVaultChanged } from './events'
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

export type HealthProblemKind = 'missing_file' | 'stray_file' | 'damaged_item' | 'damaged_credential'
export type HealthProblem = { kind: HealthProblemKind; id: string; label: string }
export type HealthReport = { databaseProblem: string | null; problems: HealthProblem[]; skipped: string[] }

export const checkVaultHealth = () => invoke<HealthReport>('check_vault_health')
/** Returns how many problems the repair fixed. */
export const repairVaultHealth = async (kind: HealthProblemKind, ids: string[]) => {
  const fixed = await invoke<number>('repair_vault_health', { kind, ids })
  notifyVaultChanged()
  return fixed
}
