import { useEffect, useState } from 'react'
import { Button, Modal, Typography } from '@heroui/react'
import { Stethoscope02Icon } from '@hugeicons/core-free-icons'

import {
  checkVaultHealth,
  repairVaultHealth,
  type HealthProblem,
  type HealthProblemKind,
  type HealthReport,
} from '../../data/backup'
import { DialogHeader } from '../../components/DialogHeader'
import { notifyError, notifySuccess } from '../../lib/feedback'

type Group = {
  kind: HealthProblemKind
  title: (count: number) => string
  explain: string
  action: string
  done: string
}

const GROUPS: Group[] = [
  {
    kind: 'missing_file',
    title: (n) => (n === 1 ? '1 file is missing or changed' : `${n} files are missing or changed`),
    explain: 'The file on disk is gone or no longer matches what Kivo saved.',
    action: 'Move items to Trash',
    done: 'Moved to Trash',
  },
  {
    kind: 'damaged_item',
    title: (n) => (n === 1 ? '1 item cannot be read' : `${n} items cannot be read`),
    explain: 'Its encrypted data is damaged. A backup may still have a good copy.',
    action: 'Move items to Trash',
    done: 'Moved to Trash',
  },
  {
    kind: 'damaged_credential',
    title: (n) => (n === 1 ? '1 saved login cannot be read' : `${n} saved logins cannot be read`),
    explain: 'Its encrypted data is damaged. A backup may still have a good copy.',
    action: 'Move logins to Trash',
    done: 'Moved to Trash',
  },
  {
    kind: 'stray_file',
    title: (n) => (n === 1 ? '1 file is not linked to any item' : `${n} files are not linked to any item`),
    explain: 'Kivo moves them to Documents › Kivo Recovered Files, so you can look at them or delete them.',
    action: 'Move to folder',
    done: 'Moved to Documents › Kivo Recovered Files',
  },
]

export type VaultHealthDialogProps = { open: boolean; onClose: () => void }

/** Runs the vault health check when opened and offers one repair per kind of problem. */
export function VaultHealthDialog({ open, onClose }: VaultHealthDialogProps) {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [repairing, setRepairing] = useState<HealthProblemKind | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setReport(null)
    setError(false)
    checkVaultHealth()
      .then((next) => {
        if (active) setReport(next)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [open, attempt])

  async function repair(group: Group, problems: HealthProblem[]) {
    setRepairing(group.kind)
    try {
      await repairVaultHealth(group.kind, problems.map((problem) => problem.id))
      notifySuccess(group.done)
      setAttempt((value) => value + 1)
    } catch {
      notifyError('Kivo could not fix this. Nothing was changed.')
    } finally {
      setRepairing(null)
    }
  }

  const healthy = report && !report.databaseProblem && report.problems.length === 0

  return (
    <Modal
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !repairing) onClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <DialogHeader
              description="Kivo checks the database, your files and your encrypted records."
              icon={Stethoscope02Icon}
              title="Vault health"
            />
            <Modal.Body className="grid gap-3">
              {!report && !error ? <p role="status">Checking your vault...</p> : null}
              {error ? (
                <div className="grid justify-items-start gap-2" role="alert">
                  Kivo could not finish the check.
                  <Button variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
                    Try again
                  </Button>
                </div>
              ) : null}

              {report?.databaseProblem ? (
                <div className="grid gap-1 rounded-xl border border-danger p-3" role="alert">
                  <Typography type="body" weight="medium">
                    The vault database is damaged
                  </Typography>
                  <Typography color="muted" type="body-sm">
                    {report.databaseProblem}. Kivo cannot repair this itself. Restore from a recent backup
                    with Restore from backup.
                  </Typography>
                </div>
              ) : null}

              {healthy ? (
                <Typography role="status" type="body" weight="medium">
                  No problems found. Your notes, files and saved logins are all readable.
                </Typography>
              ) : null}

              {report
                ? GROUPS.map((group) => {
                    const problems = report.problems.filter((problem) => problem.kind === group.kind)
                    if (problems.length === 0) return null
                    return (
                      <section
                        key={group.kind}
                        aria-label={group.title(problems.length)}
                        className="grid gap-2 rounded-xl border border-default p-3"
                      >
                        <Typography type="body" weight="medium">
                          {group.title(problems.length)}
                        </Typography>
                        <Typography color="muted" type="body-sm">
                          {group.explain}
                        </Typography>
                        <ul className="grid max-h-32 gap-0.5 overflow-y-auto text-sm">
                          {problems.map((problem) => (
                            <li key={problem.id} className="truncate">
                              {problem.label}
                            </li>
                          ))}
                        </ul>
                        <Button
                          className="justify-self-start"
                          isDisabled={repairing !== null}
                          variant="secondary"
                          onPress={() => void repair(group, problems)}
                        >
                          {repairing === group.kind ? 'Working...' : group.action}
                        </Button>
                      </section>
                    )
                  })
                : null}

              {report?.skipped.map((note) => (
                <Typography key={note} color="muted" type="body-sm">
                  {note}
                </Typography>
              ))}
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={repairing !== null} variant="secondary" onPress={onClose}>
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default VaultHealthDialog
