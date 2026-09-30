import { useState } from 'react'
import { Alert, Button, Checkbox, Chip, Modal, Typography } from '@heroui/react'

import {
  importCredentials,
  pickPasswordCsv,
  previewPasswordImport,
  type ImportPreview,
  type ImportResult,
} from '../../data/passwords'

export type PasswordImportDialogProps = {
  open: boolean
  onClose: () => void
  onImported: () => void
}

type Step = 'pick' | 'preview' | 'done'

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Imports logins from a Chrome or Edge password export. Nothing is saved until
 * the person reviews the list. Logins that are already saved start unticked;
 * ticking one replaces the saved password and keeps the old one in History.
 */
export function PasswordImportDialog({ open, onClose, onImported }: PasswordImportDialogProps) {
  const [step, setStep] = useState<Step>('pick')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function close() {
    setStep('pick')
    setPreview(null)
    setChosen(new Set())
    setResult(null)
    setError(null)
    onClose()
  }

  async function chooseFile() {
    setError(null)
    setBusy(true)
    try {
      const path = await pickPasswordCsv()
      if (!path) return
      const next = await previewPasswordImport(path)
      if (next.rows.length === 0) {
        setError('No logins with a password were found in this file.')
        return
      }
      setPreview(next)
      setChosen(new Set(next.rows.flatMap((row, index) => (row.duplicateOf ? [] : [index]))))
      setStep('preview')
    } catch (reason) {
      setError(errorText(reason, 'Kivo could not read this file. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  function toggle(index: number, checked: boolean) {
    setChosen((current) => {
      const next = new Set(current)
      if (checked) next.add(index)
      else next.delete(index)
      return next
    })
  }

  async function runImport() {
    if (!preview) return
    setError(null)
    setBusy(true)
    try {
      const choices = preview.rows
        .filter((_, index) => chosen.has(index))
        .map(({ duplicateOf, ...row }) => ({ ...row, replaceId: duplicateOf }))
      setResult(await importCredentials(choices))
      setStep('done')
      onImported()
    } catch (reason) {
      setError(errorText(reason, 'Kivo could not import these logins. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  const rows = preview?.rows ?? []
  const duplicates = rows.filter((row) => row.duplicateOf).length
  const allChosen = rows.length > 0 && chosen.size === rows.length

  return (
    <Modal
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) close()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Import passwords</Modal.Heading>
            </Modal.Header>

            <Modal.Body className="grid gap-4">
              {step === 'pick' ? (
                <div className="grid gap-2">
                  <Typography type="body">
                    Choose a password file exported from Chrome or Edge (.csv). You can check every
                    login before anything is saved.
                  </Typography>
                  <Typography color="muted" type="body-sm">
                    In Chrome or Edge, open Password Manager, then Settings, then Export passwords.
                  </Typography>
                </div>
              ) : null}

              {step === 'preview' && preview ? (
                <>
                  <Typography type="body">
                    {plural(rows.length, 'login')} found
                    {duplicates ? `, ${duplicates} already saved` : ''}
                    {preview.skipped ? `. ${plural(preview.skipped, 'line')} had no password and will be left out` : ''}.
                  </Typography>
                  {duplicates ? (
                    <Typography color="muted" type="body-sm">
                      Logins you already have are not ticked. Tick one to replace its saved password; the
                      old password stays in that login's History.
                    </Typography>
                  ) : null}

                  <Checkbox
                    isIndeterminate={chosen.size > 0 && !allChosen}
                    isSelected={allChosen}
                    onChange={(checked) =>
                      setChosen(checked ? new Set(rows.map((_, index) => index)) : new Set())
                    }
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span className="text-sm font-medium">Select all</span>
                    </Checkbox.Content>
                  </Checkbox>

                  <ul aria-label="Logins in this file" className="grid max-h-80 gap-1 overflow-y-auto pr-1">
                    {rows.map((row, index) => (
                      <li key={index} className="rounded-xl border border-default px-3 py-2">
                        <Checkbox isSelected={chosen.has(index)} onChange={(checked) => toggle(index, checked)}>
                          <Checkbox.Content className="w-full min-w-0">
                            <Checkbox.Control>
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="truncate font-semibold">{row.service}</span>
                                {row.duplicateOf ? (
                                  <Chip size="sm" variant="soft">
                                    {chosen.has(index) ? 'Replaces saved password' : 'Already saved'}
                                  </Chip>
                                ) : null}
                              </span>
                              <span className="truncate text-sm text-muted">
                                {[row.username || 'No username', row.url].filter(Boolean).join(' · ')}
                              </span>
                            </span>
                          </Checkbox.Content>
                        </Checkbox>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {step === 'done' && result ? (
                <div className="grid gap-3">
                  <Typography role="status" type="body">
                    {plural(result.imported, 'login')} added
                    {result.replaced ? `, ${plural(result.replaced, 'password')} replaced` : ''}.
                    {result.failed.length ? ` ${plural(result.failed.length, 'login')} could not be saved: ${result.failed.join(', ')}.` : ''}
                  </Typography>
                  <Alert status="warning">
                    <Alert.Content>
                      <Alert.Title>Delete the exported file now</Alert.Title>
                      <Alert.Description>
                        It holds your passwords as plain text. Anyone who opens it can read them.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                </div>
              ) : null}

              {error ? (
                <Typography className="text-danger" role="alert" type="body-sm">
                  {error}
                </Typography>
              ) : null}
            </Modal.Body>

            <Modal.Footer>
              {step === 'done' ? (
                <Button onPress={close}>Done</Button>
              ) : (
                <>
                  <Button isDisabled={busy} variant="secondary" onPress={close}>
                    Cancel
                  </Button>
                  {step === 'pick' ? (
                    <Button isDisabled={busy} onPress={() => void chooseFile()}>
                      {busy ? 'Reading...' : 'Choose file...'}
                    </Button>
                  ) : (
                    <Button isDisabled={busy || chosen.size === 0} onPress={() => void runImport()}>
                      {busy ? 'Importing...' : `Import ${plural(chosen.size, 'login')}`}
                    </Button>
                  )}
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default PasswordImportDialog
