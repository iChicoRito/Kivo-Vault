import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Tabs,
  TextField,
  Typography,
} from '@heroui/react'
import {
  ArrowLeft01Icon,
  Delete02Icon,
  FileImportIcon,
  PlusSignIcon,
  Shield01Icon,
  SquareLock01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import PageHeader from '../../app/PageHeader'
import { useVault } from '../../app/vault'
import { ConfirmDialog } from '../../components/items/dialogs'
import { ListScrollArea } from '../../components/items/ListScrollArea'
import { SelectionBar } from '../../components/items/SelectionBar'
import { useSelection } from '../../components/items/useSelection'
import {
  deleteCredentialsPermanently,
  listCredentials,
  loadCredential,
  trashCredentials,
  type Credential,
  type CredentialFilter,
  type CredentialSummary,
} from '../../data/passwords'
import { notifyError, notifySuccess } from '../../lib/feedback'
import { useVaultChanged } from '../../lib/useVaultChanged'
import { CredentialDialog } from './CredentialDialog'
import { CredentialRow } from './CredentialRow'
import { PasswordImportDialog } from './PasswordImportDialog'
import { ChangeVaultPasswordDialog } from './ChangeVaultPasswordDialog'
import { PasswordGeneratorPanel } from './PasswordGeneratorPanel'
import { VaultGate } from './VaultGate'

type LoadState = 'loading' | 'ready' | 'error'

const panelLabelClass = 'uppercase'

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) {
    return error
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function CredentialsSkeleton() {
  return (
    <div aria-label="Loading passwords" aria-live="polite" className="grid gap-3" role="status">
      <span className="sr-only">Loading passwords</span>
      <ul aria-hidden="true" className="grid gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <li key={index}>
            <div className="flex items-center gap-3 rounded-3xl border border-default bg-surface p-3">
              <Skeleton animationType="shimmer" className="size-12 shrink-0 rounded-full" />
              <div className="grid min-w-0 flex-1 gap-1">
                <Skeleton animationType="shimmer" className="h-5 w-14 rounded-full" />
                <Skeleton animationType="shimmer" className="h-5 w-2/3 rounded-md" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PasswordsPageContent() {
  const { lock } = useVault()

  const [items, setItems] = useState<CredentialSummary[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [attempt, setAttempt] = useState(0)

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [trashed, setTrashed] = useState(false)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Credential | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [changeOpen, setChangeOpen] = useState(false)
  const [locking, setLocking] = useState(false)

  useVaultChanged(() => setAttempt((value) => value + 1))

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    let active = true
    setLoadState((state) => (state === 'ready' ? state : 'loading'))

    const filter: CredentialFilter = { trashed }

    if (query.trim()) filter.query = query.trim()

    listCredentials(filter)
      .then((loaded) => {
        if (!active) return
        setItems(loaded)
        setLoadState('ready')
      })
      .catch((error) => {
        if (!active) return
        setErrorMessage(errorText(error, 'Kivo could not read saved passwords. Try again.'))
        setLoadState('error')
      })

    return () => {
      active = false
    }
  }, [attempt, query, trashed])

  const selection = useSelection()
  const [bulkIds, setBulkIds] = useState<string[] | null>(null)

  // Selection belongs to one list: switching to or from Trash starts fresh.
  useEffect(() => selection.clear(), [trashed]) // eslint-disable-line react-hooks/exhaustive-deps

  async function runBulk() {
    const ids = bulkIds
    if (!ids) return
    setBulkIds(null)
    const count = `${ids.length} ${ids.length === 1 ? 'credential' : 'credentials'}`

    try {
      if (trashed) {
        await deleteCredentialsPermanently(ids)
        notifySuccess(`${count} deleted`)
      } else {
        await trashCredentials(ids)
        notifySuccess(`${count} moved to Trash`)
      }
      selection.clear()
      setAttempt((value) => value + 1)
    } catch {
      notifyError(
        trashed
          ? 'Kivo could not delete these credentials. Try again.'
          : 'Kivo could not move these credentials to Trash. Try again.',
      )
    }
  }

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }

  async function openEdit(id: string) {
    try {
      const credential = await loadCredential(id)
      setEditing(credential)
      setDialogOpen(true)
    } catch (error) {
      notifyError(errorText(error, 'Kivo could not open this credential. Try again.'))
    }
  }

  async function handleLock() {
    if (locking) return

    setLocking(true)

    try {
      await lock()
      notifySuccess('Vault locked')
    } catch {
      notifyError('Kivo could not lock the vault. Try again.')
      setLocking(false)
    }
  }

  const searching = query.trim() !== ''

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <TextField className="w-full max-w-md" value={search} onChange={setSearch}>
          <Label>Search collection</Label>
          <Input fullWidth placeholder="I am looking for..." variant="secondary" />
        </TextField>

        <div className="flex flex-wrap items-center gap-2" data-tour="passwords">
          <Button isDisabled={locking} variant="secondary" onPress={() => void handleLock()}>
            <HugeiconsIcon aria-hidden="true" icon={SquareLock01Icon} size={18} />
            {locking ? 'Locking...' : 'Lock Vault'}
          </Button>
          <Button variant="secondary" onPress={() => setChangeOpen(true)}>
            Change Password
          </Button>
          <Button variant="secondary" onPress={() => setImportOpen(true)}>
            <HugeiconsIcon aria-hidden="true" icon={FileImportIcon} size={18} />
            Import
          </Button>
          <Button onPress={openCreate}>
            <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
            New Password
          </Button>
        </div>
      </div>

      {loadState === 'loading' ? <CredentialsSkeleton /> : null}

      {loadState === 'error' ? (
        <Alert aria-labelledby="passwords-error-title" role="alert" status="danger">
          <Alert.Content className="grid gap-3">
            <Typography className={panelLabelClass} color="muted" type="body-xs" weight="bold">
              ERROR
            </Typography>
            <Typography id="passwords-error-title" type="h2">
              Your passwords could not load
            </Typography>
            <Typography type="body">{errorMessage}</Typography>
            <Button
              className="justify-self-start"
              variant="secondary"
              onPress={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {loadState === 'ready' && items.length === 0 ? (
        <EmptyState className="flex min-h-[20rem] flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-default px-6 py-16 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-default">
            <HugeiconsIcon
              aria-hidden="true"
              className="text-muted"
              icon={trashed ? Delete02Icon : Shield01Icon}
              size={26}
            />
          </span>
          <Typography type="h3" weight="semibold">
            {trashed ? 'Trash is Empty' : searching ? 'No Passwords Found' : 'No Passwords Yet'}
          </Typography>
          <Typography className="max-w-sm" color="muted" type="body">
            {trashed
              ? 'Passwords you delete stay here until you remove them for good.'
              : searching
                ? 'No passwords match your search.'
                : "You haven't created any password yet. Get started by creating your first password."}
          </Typography>
          {trashed ? (
            <Button variant="secondary" onPress={() => setTrashed(false)}>
              <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} size={18} />
              Back to Passwords
            </Button>
          ) : searching ? null : (
            <Button onPress={openCreate}>
              <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={18} />
              Create Password
            </Button>
          )}
        </EmptyState>
      ) : null}

      {loadState === 'ready' && items.length > 0 ? (
        <SelectionBar
          actionLabel={trashed ? 'Delete forever' : 'Move to Trash'}
          selection={selection}
          visibleIds={items.map((entry) => entry.id)}
          onAction={setBulkIds}
        />
      ) : null}

      {loadState === 'ready' && items.length > 0 ? (
        <ListScrollArea>
          <ul aria-label={trashed ? 'Trashed passwords' : 'All passwords'} className="grid gap-3">
            {items.map((credential) => (
              <li key={credential.id} className="min-w-0">
                <CredentialRow
                  credential={credential}
                  isSelected={selection.isSelected(credential.id)}
                  isSelecting={selection.isActive}
                  trashed={trashed}
                  onSelect={() => selection.pick(credential.id)}
                  onBackToPasswords={() => setTrashed(false)}
                  onChanged={() => setAttempt((value) => value + 1)}
                  onEdit={(id) => void openEdit(id)}
                  onViewTrash={() => setTrashed(true)}
                />
              </li>
            ))}
          </ul>
        </ListScrollArea>
      ) : null}

      <CredentialDialog
        credential={editing}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null)
        }}
        onSaved={() => setAttempt((value) => value + 1)}
      />

      <PasswordImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => setAttempt((value) => value + 1)}
      />

      <ChangeVaultPasswordDialog open={changeOpen} onClose={() => setChangeOpen(false)} />

      <ConfirmDialog
        confirmLabel={trashed ? 'Delete forever' : 'Move to trash'}
        description={
          trashed
            ? 'These credentials are removed from this device. This cannot be undone.'
            : 'You can restore them from Trash.'
        }
        open={bulkIds !== null}
        title={
          trashed
            ? `Delete ${bulkIds?.length ?? 0} credentials forever?`
            : `Move ${bulkIds?.length ?? 0} credentials to Trash?`
        }
        tone="danger"
        onCancel={() => setBulkIds(null)}
        onConfirm={() => void runBulk()}
      />
    </div>
  )
}

export function PasswordsPage() {
  return (
    <section aria-labelledby="passwords-title" className="grid gap-5">
      <PageHeader
        description="Saved logins stay encrypted on this device."
        title="Password Manager"
        titleId="passwords-title"
      />

      <Tabs className="w-full" defaultSelectedKey="passwords">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Password sections">
            <Tabs.Tab id="passwords">
              Password Vault
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="generator">
              Password Generator
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel className="pt-2" id="passwords">
          <VaultGate>
            <PasswordsPageContent />
          </VaultGate>
        </Tabs.Panel>

        <Tabs.Panel className="pt-2" id="generator">
          <Card className="w-full">
            <Card.Content className="gap-7 p-3">
              <Typography type="h4">Password Generator</Typography>
              <PasswordGeneratorPanel />
            </Card.Content>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </section>
  )
}

export default PasswordsPage
