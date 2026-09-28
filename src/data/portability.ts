import { invoke } from './runtime'

export type ImportReport = {
  imported: number
  skipped: Array<{ title: string; reason: string }>
  losses: string[]
}

export const pickSaveFile = (defaultName: string) => invoke<string | null>('pick_save_file', { defaultName })
export const pickFolderDestination = () => invoke<string | null>('pick_folder_destination')
export const exportNoteMarkdown = (id: string, path: string) =>
  invoke<void>('export_note_markdown', { id, path })
export const exportItemsJson = (ids: string[], path: string) =>
  invoke<void>('export_items_json', { ids, path })
/** Resolves to the number of items left out because their collection is locked. */
export const exportVaultJson = (path: string) => invoke<number>('export_vault_json', { path })
export const importJson = (path: string) => invoke<ImportReport>('import_json', { path })
export const importMarkdown = (paths: string[]) => invoke<ImportReport>('import_markdown', { paths })
