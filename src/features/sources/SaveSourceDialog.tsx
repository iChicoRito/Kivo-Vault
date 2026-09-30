import { useEffect, useState } from 'react'
import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Skeleton,
  TextField,
  Typography,
} from '@heroui/react'
import { Link01Icon } from '@hugeicons/core-free-icons'

import { notifyError, notifySuccess } from '../../lib/feedback'
import { loadItem, saveItem, type VaultItem } from '../../data/items'
import { DialogHeader } from '../../components/DialogHeader'

const ADDRESS_REQUIRED = 'Address is required.'
const ADDRESS_INVALID = 'Address must start with http:// or https://.'
const TITLE_REQUIRED = 'Title is required.'
const SAVE_ERROR = 'Kivo could not save this source. Try again.'
const LOAD_ERROR = 'Kivo could not load this source.'

type FieldErrors = {
  address?: string
  title?: string
}

type SaveSourceDialogProps = {
  open: boolean
  onClose: () => void
  itemId?: string | null
  onSaved: () => void
}

export function SaveSourceDialog({ open, onClose, itemId, onSaved }: SaveSourceDialogProps) {
  const [address, setAddress] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState<VaultItem | null>(null)

  useEffect(() => {
    if (!open) return

    setErrors({})
    setFormError(null)

    if (!itemId) {
      setLoading(false)
      setAddress('')
      setTitle('')
      setDescription('')
      setLoaded(null)
      return
    }

    let active = true
    setLoading(true)

    loadItem(itemId)
      .then((item) => {
        if (!active) return
        setAddress(item.url ?? '')
        setTitle(item.title)
        setDescription(item.description)
        setLoaded(item)
      })
      .catch(() => {
        if (active) setFormError(LOAD_ERROR)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [open, itemId])

  function validate() {
    const next: FieldErrors = {}
    const addressValue = address.trim()

    if (!addressValue) next.address = ADDRESS_REQUIRED
    else if (!/^https?:\/\//i.test(addressValue)) next.address = ADDRESS_INVALID

    if (!title.trim()) next.title = TITLE_REQUIRED

    setErrors(next)
    return Object.keys(next).length === 0
  }

  async function handleSubmit() {
    setFormError(null)
    if (!validate()) return

    setBusy(true)

    try {
      await saveItem({
        id: itemId ?? undefined,
        kind: 'source',
        title: title.trim(),
        description: description.trim(),
        url: address.trim(),
        // The personal note is no longer edited here, so a save keeps it as it is.
        content: loaded?.content ?? '',
        collectionId: loaded?.collectionId ?? null,
        isFavorite: loaded?.isFavorite ?? false,
        isPinned: loaded?.isPinned ?? false,
      })
      notifySuccess('Source saved')
      onSaved()
      onClose()
    } catch {
      setFormError(SAVE_ERROR)
      notifyError(SAVE_ERROR)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <DialogHeader
              description="Save a link with a title and a short note."
              icon={Link01Icon}
              title={itemId ? 'Edit source' : 'New source'}
            />

            <Modal.Body className="grid gap-4">
              {loading ? (
                <div
                  aria-label="Loading source fields"
                  className="grid gap-4"
                  role="status"
                >
                  <span className="sr-only">Loading source fields</span>
                  {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} aria-hidden="true" className="grid gap-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-9 w-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <form
                  className="grid gap-4"
                  id="save-source-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault()
                    void handleSubmit()
                  }}
                >
                  <TextField
                    isRequired
                    isInvalid={errors.address !== undefined}
                    type="url"
                    value={address}
                    onChange={(value) => {
                      setAddress(value)
                      setErrors((current) => ({ ...current, address: undefined }))
                    }}
                  >
                    <Label>Address</Label>
                    <Input fullWidth placeholder="https://example.com" variant="secondary" />
                    {errors.address ? <FieldError>{errors.address}</FieldError> : null}
                  </TextField>

                  <TextField
                    isRequired
                    isInvalid={errors.title !== undefined}
                    value={title}
                    onChange={(value) => {
                      setTitle(value)
                      setErrors((current) => ({ ...current, title: undefined }))
                    }}
                  >
                    <Label>Title</Label>
                    <Input fullWidth variant="secondary" />
                    {errors.title ? <FieldError>{errors.title}</FieldError> : null}
                  </TextField>

                  <TextField value={description} onChange={setDescription}>
                    <Label>Description</Label>
                    <Input fullWidth variant="secondary" />
                  </TextField>
                </form>
              )}

              {formError ? (
                <Typography className="font-semibold text-danger" role="alert" type="body">
                  {formError}
                </Typography>
              ) : null}
            </Modal.Body>

            <Modal.Footer>
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
              <Button isDisabled={busy || loading} onPress={() => void handleSubmit()}>
                Save
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default SaveSourceDialog
