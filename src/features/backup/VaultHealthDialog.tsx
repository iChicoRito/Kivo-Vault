import { useEffect, useState } from 'react'
import { Button, Modal, Typography } from '@heroui/react'
import { Alert02Icon, CheckmarkCircle02Icon, SquareLock01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

import {
  checkVaultHealth,
  repairVaultHealth,
  type HealthProblem,
  type HealthProblemKind,
  type HealthReport,
  type HealthSkip,
} from '../../data/backup'
import { HealthHeart, type HeartState } from './HealthHeart'
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

  const heart: HeartState = !report
    ? 'checking'
    : report.databaseProblem
      ? 'damaged'
      : report.problems.length
        ? 'problems'
        : 'healthy'
  const problemCount = report?.problems.length ?? 0

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
            <Modal.Header className="items-center text-center">
              <Modal.Heading className="text-xs font-semibold tracking-wider text-muted uppercase">
                Vault health
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="grid gap-5">
              {error ? (
                <div className="grid justify-items-center gap-3 text-center" role="alert">
                  <Typography type="body">Kivo could not finish the check.</Typography>
                  <Button variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
                    Try again
                  </Button>
                </div>
              ) : (
                <div className="grid justify-items-center gap-1 text-center">
                  <HealthHeart state={heart} />
                  <Typography className="mt-2" role="status" type="h3">
                    {STATUS[heart]}
                  </Typography>
                  <Typography color="muted" type="body-sm">
                    {heart === 'problems'
                      ? `${problemCount === 1 ? '1 problem' : `${problemCount} problems`} found`
                      : SUMMARY[heart]}
                  </Typography>
                </div>
              )}

              {report ? <Checklist report={report} /> : null}

              {report?.databaseProblem ? (
                <Typography className="text-danger" role="alert" type="body-sm">
                  {report.databaseProblem}. Restore from a recent backup with Restore in Settings › Data.
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
                        className="grid gap-2 rounded-2xl border border-default p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Typography type="body" weight="medium">
                            {group.title(problems.length)}
                          </Typography>
                          <Button
                            isDisabled={repairing !== null}
                            size="sm"
                            variant="secondary"
                            onPress={() => void repair(group, problems)}
                          >
                            {repairing === group.kind ? 'Working...' : group.action}
                          </Button>
                        </div>
                        <Typography color="muted" type="body-sm">
                          {group.explain}
                        </Typography>
                        <ul className="grid max-h-28 gap-0.5 overflow-y-auto text-sm">
                          {problems.map((problem) => (
                            <li key={problem.id} className="truncate">
                              {problem.label}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  })
                : null}
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

const STATUS: Record<HeartState, string> = {
  checking: 'Checking...',
  healthy: 'Healthy',
  problems: 'Needs attention',
  damaged: 'Database damaged',
}

const SUMMARY: Record<HeartState, string> = {
  checking: 'Looking at your database, files and records',
  healthy: 'No problems found',
  problems: '',
  damaged: 'Restore from a backup to fix this',
}

type RowState = { icon: IconSvgElement; tone: string; text: string }

const OK: RowState = { icon: CheckmarkCircle02Icon, tone: 'text-success', text: 'OK' }
const LOCKED: RowState = { icon: SquareLock01Icon, tone: 'text-muted', text: 'Locked, not checked' }

function issues(count: number): RowState {
  return { icon: Alert02Icon, tone: 'text-warning', text: count === 1 ? '1 issue' : `${count} issues` }
}

/** What was checked, one row each, so the result reads at a glance. */
function Checklist({ report }: { report: HealthReport }) {
  const count = (...kinds: HealthProblemKind[]) =>
    report.problems.filter((problem) => kinds.includes(problem.kind)).length
  const skipped = (code: HealthSkip) => report.skipped.includes(code)
  const pick = (locked: boolean, found: number) => (locked ? LOCKED : found ? issues(found) : OK)

  const rows: Array<[string, RowState]> = [
    ['Database', report.databaseProblem ? { icon: Alert02Icon, tone: 'text-danger', text: 'Damaged' } : OK],
    ['Files', pick(false, count('missing_file', 'stray_file'))],
    ['Notes and records', pick(skipped('content_locked'), count('damaged_item'))],
    ['Saved logins', pick(skipped('passwords_locked'), count('damaged_credential'))],
  ]
  if (skipped('collections_locked')) rows.push(['Locked collections', LOCKED])

  return (
    <ul aria-label="What was checked" className="grid divide-y divide-default rounded-2xl border border-default">
      {rows.map(([label, row]) => (
        <li key={label} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="text-sm font-medium">{label}</span>
          <span className={`flex items-center gap-1.5 text-sm ${row.tone}`}>
            <HugeiconsIcon aria-hidden="true" icon={row.icon} size={16} />
            {row.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default VaultHealthDialog
