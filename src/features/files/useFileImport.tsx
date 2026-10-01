import { useRef, useState, type ReactNode } from 'react'

import {
  cancelFileImport,
  commitFileImport,
  previewFileImport,
  type CaptureOutcome,
} from '../../data/items'
import {
  DuplicateDialog,
  type DuplicateConflict,
  type DuplicateDecision,
} from '../items/DuplicateDialog'

export type FileImportSummary = {
  imported: number
  skipped: number
  failed: number
  /** True when the user stopped the batch; later files were not touched. */
  stopped: boolean
}

type Pending = {
  conflict: DuplicateConflict
  remaining: number
  resolve: (decision: DuplicateDecision) => void
}

/**
 * Imports picked files one at a time. Each file is staged and checked first;
 * a file whose contents are already saved waits for Open existing, Skip, or
 * Keep both. Files saved earlier in the batch count as saved, so the same file
 * picked twice is caught too. A failure is counted and the batch goes on.
 */
export function useFileImport(): {
  importPaths: (paths: string[]) => Promise<FileImportSummary>
  dialog: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)

  function ask(conflict: DuplicateConflict, remaining: number) {
    return new Promise<DuplicateDecision>((resolve) => {
      const next = { conflict, remaining, resolve }
      pendingRef.current = next
      setPending(next)
    })
  }

  function decide(decision: DuplicateDecision) {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    current?.resolve(decision)
  }

  async function importPaths(paths: string[]): Promise<FileImportSummary> {
    const summary: FileImportSummary = { imported: 0, skipped: 0, failed: 0, stopped: false }

    for (const [index, path] of paths.entries()) {
      let token: string | null = null
      try {
        const preview = await previewFileImport(path)
        token = preview.token
        let outcome: CaptureOutcome =
          preview.matches.length > 0
            ? { status: 'duplicate', matches: preview.matches, accessEpoch: preview.accessEpoch }
            : await commitFileImport(preview.token, null, 'check')

        if (outcome.status === 'duplicate') {
          const decision = await ask(
            {
              name: preview.originalName,
              kind: 'file',
              matches: outcome.matches,
              accessEpoch: outcome.accessEpoch,
            },
            paths.length - index - 1,
          )
          if (decision !== 'keepBoth') {
            await cancelFileImport(preview.token).catch(() => undefined)
            summary.skipped += 1
            if (decision === 'stop') {
              summary.stopped = true
              break
            }
            continue
          }
          outcome = await commitFileImport(preview.token, null, 'keepBoth')
        }

        if (outcome.status === 'saved') summary.imported += 1
      } catch {
        if (token) await cancelFileImport(token).catch(() => undefined)
        summary.failed += 1
      }
    }

    return summary
  }

  return {
    importPaths,
    dialog: (
      <DuplicateDialog
        conflict={pending?.conflict ?? null}
        remaining={pending?.remaining ?? 0}
        onDecision={decide}
      />
    ),
  }
}

/** Short result line for a finished batch. */
export function describeImport(summary: FileImportSummary): string {
  const parts = [summary.imported === 1 ? 'Imported 1 file' : `Imported ${summary.imported} files`]
  if (summary.skipped > 0) parts.push(`skipped ${summary.skipped}`)
  return parts.join(', ') + '.'
}
