import { useState } from 'react'
import { Chip, Typography } from '@heroui/react'
import {
  Archive01Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  Delete02Icon,
  DeletePutBackIcon,
  HistoryIcon,
  PencilEdit02Icon,
  StarIcon,
  StarOffIcon,
} from '@hugeicons/core-free-icons'

import { ItemCard, type ItemCardAction } from '../../components/items/ItemCard'
import { ConfirmDialog } from '../../components/items/dialogs'
import { CredentialAvatar } from './CredentialAvatar'
import { CredentialHistoryDialog } from './CredentialHistoryDialog'
import { copySecret, copyText } from '../../lib/clipboard'
import { notifyError, notifySuccess } from '../../lib/feedback'
import {
  deleteCredentialsPermanently,
  loadCredential,
  restoreCredentials,
  setCredentialsFavorite,
  trashCredentials,
  type CredentialSummary,
} from '../../data/passwords'

export type CredentialRowProps = {
  credential: CredentialSummary
  trashed: boolean
  onEdit: (id: string) => void
  onChanged: () => void
  onViewTrash: () => void
  onBackToPasswords: () => void
  isSelecting?: boolean
  isSelected?: boolean
  onSelect?: () => void
}

type ConfirmKind = 'trash' | 'delete' | null

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) {
    return error
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function CredentialRow({
  credential,
  trashed,
  onEdit,
  onChanged,
  onViewTrash,
  onBackToPasswords,
  isSelecting,
  isSelected,
  onSelect,
}: CredentialRowProps) {
  const [confirm, setConfirm] = useState<ConfirmKind>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  async function copyPassword() {
    try {
      const value = (await loadCredential(credential.id)).password
      await copySecret(value)
      notifySuccess('Password copied')
    } catch {
      notifyError('Kivo could not copy this password. Try again.')
    }
  }

  async function copyUsername() {
    try {
      await copyText(credential.username)
      notifySuccess('Username copied')
    } catch {
      notifyError('Kivo could not copy this username. Try again.')
    }
  }

  async function toggleFavorite() {
    try {
      await setCredentialsFavorite([credential.id], !credential.isFavorite)
      onChanged()
    } catch {
      notifyError('Kivo could not change the favorite. Try again.')
    }
  }

  async function confirmTrash() {
    setConfirm(null)

    try {
      await trashCredentials([credential.id])
      notifySuccess('Credential moved to Trash')
      onChanged()
    } catch {
      notifyError('Kivo could not move this credential to Trash. Try again.')
    }
  }

  async function handleRestore() {
    try {
      await restoreCredentials([credential.id])
      notifySuccess('Credential restored')
      onChanged()
    } catch {
      notifyError('Kivo could not restore this credential. Try again.')
    }
  }

  async function confirmDelete() {
    setConfirm(null)

    try {
      await deleteCredentialsPermanently([credential.id])
      notifySuccess('Credential deleted')
      onChanged()
    } catch {
      notifyError('Kivo could not delete this credential. Try again.')
    }
  }

  function handleAction(key: string) {
    if (key === 'edit') onEdit(credential.id)
    else if (key === 'copy-username') void copyUsername()
    else if (key === 'copy-password') void copyPassword()
    else if (key === 'favorite') void toggleFavorite()
    else if (key === 'history') setHistoryOpen(true)
    else if (key === 'view-trash') onViewTrash()
    else if (key === 'back') onBackToPasswords()
    else if (key === 'trash') setConfirm('trash')
    else if (key === 'restore') void handleRestore()
    else if (key === 'delete') setConfirm('delete')
  }

  const actions: ItemCardAction[] = trashed
    ? [
        { id: 'restore', label: 'Restore', icon: DeletePutBackIcon },
        { id: 'back', label: 'Back to Passwords', icon: ArrowLeft01Icon },
        { id: 'delete', label: 'Delete forever', icon: Delete02Icon, danger: true },
      ]
    : [
        { id: 'edit', label: 'Edit', icon: PencilEdit02Icon },
        { id: 'copy-username', label: 'Copy username', icon: Copy01Icon },
        { id: 'copy-password', label: 'Copy password', icon: Copy01Icon },
        {
          id: 'favorite',
          label: credential.isFavorite ? 'Remove favorite' : 'Add to favorites',
          icon: credential.isFavorite ? StarOffIcon : StarIcon,
        },
        { id: 'history', label: 'History', icon: HistoryIcon },
        { id: 'view-trash', label: 'View Trash', icon: Archive01Icon },
        { id: 'trash', label: 'Move to trash', icon: Delete02Icon, danger: true },
      ]

  return (
    <>
      <ItemCard
        actions={actions}
        chips={
          <Chip size="sm" variant="soft">
            {credential.category || 'Uncategorized'}
          </Chip>
        }
        leading={<CredentialAvatar service={credential.service} url={credential.url} />}
        subtitle={
          <Typography className="truncate" color="muted" type="body-sm">
            {credential.username || 'No username'}
          </Typography>
        }
        isSelected={isSelected}
        isSelecting={isSelecting}
        title={credential.service}
        onAction={handleAction}
        onSelect={onSelect}
        onOpen={() => onEdit(credential.id)}
      />

      <CredentialHistoryDialog
        credentialId={historyOpen ? credential.id : null}
        service={credential.service}
        onClose={() => setHistoryOpen(false)}
        onRestored={onChanged}
      />

      <ConfirmDialog
        confirmLabel="Move to trash"
        description="This credential leaves every list. You can restore it from Trash."
        open={confirm === 'trash'}
        title="Move this credential to Trash?"
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmTrash()}
      />

      <ConfirmDialog
        confirmLabel="Delete forever"
        description="This credential is removed for good. You cannot undo this action."
        open={confirm === 'delete'}
        title="Delete this credential forever?"
        tone="danger"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}

export default CredentialRow
