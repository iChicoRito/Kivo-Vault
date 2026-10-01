import { useState } from 'react'
import { Button, Dropdown, Label, Typography } from '@heroui/react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  FileImportIcon,
  Folder01Icon,
  Link01Icon,
  Note01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { useNavigate } from 'react-router-dom'

import { useFileImport } from '../files/useFileImport'
import { pickFile } from '../../data/files'
import SaveSourceDialog from '../sources/SaveSourceDialog'
import QuickAddDialog from './QuickAddDialog'

type QuickAddMenuProps = {
  onAdded?: () => void
}

const IMPORT_ERROR = 'Kivo could not import that file. Try again.'

export function QuickAddMenu({ onAdded }: QuickAddMenuProps) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [collectionOpen, setCollectionOpen] = useState(false)
  const { importPaths, dialog: importDialog } = useFileImport()

  function handleNewNote() {
    onAdded?.()
    navigate('/notes/new')
  }

  async function handleImport() {
    setError(null)

    let path: string | null

    try {
      path = await pickFile()
    } catch {
      setError(IMPORT_ERROR)
      return
    }

    if (!path) return

    setBusy(true)

    try {
      const summary = await importPaths([path])
      if (summary.failed > 0) {
        setError(IMPORT_ERROR)
        return
      }
      if (summary.imported > 0) {
        onAdded?.()
        navigate('/files')
      }
    } finally {
      setBusy(false)
    }
  }

  function handleAction(key: string) {
    if (key === 'note') {
      handleNewNote()
      return
    }

    if (key === 'source') {
      setError(null)
      setSourceOpen(true)
      return
    }

    if (key === 'file') {
      void handleImport()
      return
    }

    if (key === 'collection') {
      setError(null)
      setCollectionOpen(true)
    }
  }

  return (
    <div className="grid justify-items-end gap-2">
      <Dropdown>
        <Button aria-label="Quick Add" isDisabled={busy} variant="primary">
          <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={16} />
          Quick Add
        </Button>
        <Dropdown.Popover>
          <Dropdown.Menu onAction={(key) => handleAction(String(key))}>
            <Dropdown.Item id="note" textValue="New note">
              <HugeiconsIcon aria-hidden="true" icon={Note01Icon} size={16} />
              <Label>New note</Label>
            </Dropdown.Item>
            <Dropdown.Item id="source" textValue="New source">
              <HugeiconsIcon aria-hidden="true" icon={Link01Icon} size={16} />
              <Label>New source</Label>
            </Dropdown.Item>
            <Dropdown.Item id="file" textValue="Import file">
              <HugeiconsIcon aria-hidden="true" icon={FileImportIcon} size={16} />
              <Label>Import file</Label>
            </Dropdown.Item>
            <Dropdown.Item id="collection" textValue="New collection">
              <HugeiconsIcon aria-hidden="true" icon={Folder01Icon} size={16} />
              <Label>New collection</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      {error ? (
        <Typography className="font-semibold text-danger" role="alert" type="body">
          {error}
        </Typography>
      ) : null}

      <SaveSourceDialog
        itemId={null}
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        onSaved={() => {
          setSourceOpen(false)
          onAdded?.()
        }}
      />

      <QuickAddDialog
        initialMode="collection"
        open={collectionOpen}
        onClose={() => setCollectionOpen(false)}
      />
      {importDialog}
    </div>
  )
}

export default QuickAddMenu
