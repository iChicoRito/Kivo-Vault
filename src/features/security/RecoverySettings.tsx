import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Separator, Typography } from '@heroui/react'

import { readRecoveryStatus, type RecoveryStatus, type VaultScope } from '../../data/recovery'
import { RecoveryDialog, type RecoveryMode } from './RecoveryDialog'

const ROWS: Array<{ scope: VaultScope; title: string; detail: string; unavailable: string }> = [
  {
    scope: 'content',
    title: 'Content vault',
    detail: 'Notes, sources and files. Replaces a forgotten Master Password.',
    unavailable: 'Turn on encryption first. Without encryption, the Master Password only locks the app.',
  },
  {
    scope: 'passwords',
    title: 'Password vault',
    detail: 'Saved passwords. Replaces a forgotten vault password.',
    unavailable: 'Create the password vault first.',
  },
]

/** One recovery kit per vault; each is set up, replaced and turned off on its own. */
export default function RecoverySettings() {
  const [status, setStatus] = useState<Partial<Record<VaultScope, RecoveryStatus>>>({})
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<{ scope: VaultScope; mode: RecoveryMode } | null>(null)

  const load = useCallback(() => {
    setFailed(false)
    Promise.all(ROWS.map((row) => readRecoveryStatus(row.scope)))
      .then((list) => setStatus(Object.fromEntries(list.map((item) => [item.scope, item]))))
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <Card aria-labelledby="recovery-title">
      <Card.Content className="grid gap-4">
        <div className="grid gap-1">
          <Typography className="text-lg font-semibold" id="recovery-title" type="h2">
            Recovery kits
          </Typography>
          <Typography color="muted" type="body-sm">
            A recovery kit is a key you keep somewhere safe. If you forget a password, it lets you
            set a new one without losing anything. Without a kit, a forgotten password cannot be
            recovered.
          </Typography>
        </div>

        {failed ? (
          <Typography className="text-danger" role="alert" type="body-sm">
            Recovery kit status could not load. It may need the Kivo desktop app.
          </Typography>
        ) : null}

        {ROWS.map((row, index) => {
          const current = status[row.scope]
          return (
            <div key={row.scope} className="grid gap-4">
              {index > 0 ? <Separator /> : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="grid min-w-0 gap-0.5">
                  <Typography className="font-medium" type="body">
                    {row.title}
                    {current?.enabled ? (
                      <span className="ml-2 text-sm font-normal text-success">Kit active</span>
                    ) : null}
                  </Typography>
                  <Typography color="muted" type="body-sm">
                    {current && !current.available ? row.unavailable : row.detail}
                  </Typography>
                </div>
                {current?.available ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onPress={() => setOpen({ scope: row.scope, mode: 'setup' })}
                    >
                      {current.enabled ? 'Replace kit' : 'Set up'}
                    </Button>
                    {current.enabled ? (
                      <Button
                        variant="secondary"
                        onPress={() => setOpen({ scope: row.scope, mode: 'disable' })}
                      >
                        Turn off
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </Card.Content>

      <RecoveryDialog
        mode={open?.mode ?? null}
        scope={open?.scope ?? 'content'}
        onClose={() => setOpen(null)}
        onDone={() => {
          setOpen(null)
          load()
        }}
      />
    </Card>
  )
}
