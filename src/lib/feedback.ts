import { toast } from '@heroui/react'
import { restoreItems, trashItems } from '../data/items'
import { exportItemsJson, pickSaveFile } from '../data/portability'

export type TrashWithUndoOptions = {
  ids: string[]
  /** Noun for the default messages, e.g. 'Note', 'Source', 'File', 'Item'. */
  label: string
  loadingMessage?: string
  successMessage?: string
  failureMessage?: string
  restoreSuccessMessage?: string
  restoreFailureMessage?: string
}

/** A short confirmation for an action that finished. */
export function notifySuccess(title: string, description?: string): string {
  return toast.success(title, { description, timeout: 4000 })
}

/** A short, dismissible error for an action that did not finish. */
export function notifyError(title: string, description?: string): string {
  return toast.danger(title, { description, timeout: 5000 })
}

/**
 * Moves items to Trash behind an Undo. The toast opens while the move runs,
 * then settles into either an undoable success or a plain failure. It resolves
 * true when the move landed, and never throws.
 */
export async function trashWithUndo({
  ids,
  label,
  loadingMessage,
  successMessage,
  failureMessage,
  restoreSuccessMessage,
  restoreFailureMessage,
}: TrashWithUndoOptions): Promise<boolean> {
  const key = toast(loadingMessage ?? 'Moving to Trash…', { isLoading: true, timeout: 0 })

  async function restore() {
    try {
      await restoreItems(ids)
      notifySuccess(restoreSuccessMessage ?? `${label} restored`)
    } catch {
      notifyError(restoreFailureMessage ?? `Kivo could not restore this ${label.toLowerCase()}. Try again.`)
    }
  }

  try {
    await trashItems(ids)
  } catch {
    toast.update(
      key,
      failureMessage ?? `Kivo could not move this ${label.toLowerCase()} to Trash. Try again.`,
      { variant: 'danger', isLoading: false, timeout: 5000 },
    )
    return false
  }

  toast.update(key, successMessage ?? `${label} moved to Trash`, {
    variant: 'success',
    isLoading: false,
    timeout: 8000,
    actionProps: { children: 'Undo', onPress: () => void restore() },
  })
  return true
}

/** Asks where to save, then exports one item as JSON. Never throws. */
export async function exportItemAsJson(id: string, title: string): Promise<void> {
  try {
    const path = await pickSaveFile(`${title.replace(/[\\/:*?"<>|]/g, '_')}.json`)
    if (!path) return

    await exportItemsJson([id], path)
    notifySuccess('Item exported as JSON')
  } catch {
    notifyError('Could not export item. Try again.')
  }
}

/** Bulk version of `trashWithUndo` with plural messages. */
export function trashManyWithUndo(ids: string[]): Promise<boolean> {
  const count = `${ids.length} ${ids.length === 1 ? 'item' : 'items'}`
  return trashWithUndo({
    ids,
    label: 'Items',
    successMessage: `${count} moved to Trash`,
    failureMessage: 'Kivo could not move these items to Trash. Try again.',
    restoreSuccessMessage: `${count} restored`,
    restoreFailureMessage: 'Kivo could not restore these items. Try again.',
  })
}
