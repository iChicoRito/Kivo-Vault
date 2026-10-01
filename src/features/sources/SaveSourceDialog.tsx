import { useEffect, useRef, useState } from 'react'
import {
  Button,
  FieldError,
  Input,
  Label,
  Modal,
  Skeleton,
  Switch,
  TextField,
  Typography,
} from '@heroui/react'
import { Link01Icon } from '@hugeicons/core-free-icons'

import { notifyError, notifySuccess } from '../../lib/feedback'
import { loadItem, saveItem, type VaultItem } from '../../data/items'
import { fetchLinkDetails, type LinkDetails } from '../../data/linkDetails'
import { DialogHeader } from '../../components/DialogHeader'

const ADDRESS_REQUIRED = 'Address is required.'
const ADDRESS_INVALID = 'Address must start with http:// or https://.'
const TITLE_REQUIRED = 'Title is required.'
const SAVE_ERROR = 'Kivo could not save this source. Try again.'
const LOAD_ERROR = 'Kivo could not load this source.'
const DETAILS_ERROR = 'Kivo could not fetch details for this link. You can type them yourself.'
const DETAILS_DELAY_MS = 400

// ponytail: remembered for this session only; phase 3 moves it into saved preferences.
let fetchDetailsSetting = true

function isWebAddress(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')
  } catch {
    return false
  }
}

// A field can take fetched text while it is empty or still holds what Kivo filled in.
function canFill(current: string, filled: string | null) {
  return current.trim() === '' || current === filled
}

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
  const [autoFetch, setAutoFetch] = useState(fetchDetailsSetting)
  const [detailsStatus, setDetailsStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [retryCount, setRetryCount] = useState(0)
  // Each address change, close, or save starts a new generation; older answers are dropped.
  const generation = useRef(0)
  const detailsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addressTouched = useRef(false)
  const filled = useRef<{ title: string | null; description: string | null }>({
    title: null,
    description: null,
  })
  const latest = useRef({ title, description })
  latest.current = { title, description }

  function cancelDetails() {
    generation.current += 1
    if (detailsTimer.current) clearTimeout(detailsTimer.current)
    detailsTimer.current = null
    setDetailsStatus('idle')
  }

  useEffect(() => {
    generation.current += 1
    if (!open) return

    setErrors({})
    setFormError(null)
    setDetailsStatus('idle')
    addressTouched.current = false
    filled.current = { title: null, description: null }

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

  useEffect(() => {
    const url = address.trim()
    if (!open || !autoFetch || !addressTouched.current || !isWebAddress(url)) return

    const request = ++generation.current
    detailsTimer.current = setTimeout(() => {
      detailsTimer.current = null
      setDetailsStatus('loading')
      fetchLinkDetails(url)
        .then((details) => {
          if (generation.current !== request) return
          applyDetails(details)
          setDetailsStatus('idle')
        })
        .catch(() => {
          if (generation.current === request) setDetailsStatus('error')
        })
    }, DETAILS_DELAY_MS)

    return () => {
      if (detailsTimer.current) clearTimeout(detailsTimer.current)
      detailsTimer.current = null
    }
  }, [open, autoFetch, address, retryCount])

  function applyDetails(details: LinkDetails) {
    if (details.title !== null && canFill(latest.current.title, filled.current.title)) {
      filled.current.title = details.title
      setTitle(details.title)
      setErrors((current) => ({ ...current, title: undefined }))
    }
    if (
      details.description !== null &&
      canFill(latest.current.description, filled.current.description)
    ) {
      filled.current.description = details.description
      setDescription(details.description)
    }
  }

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

    // What the user sees now is what gets saved; a late answer must not change it.
    cancelDetails()
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
                      addressTouched.current = true
                      setDetailsStatus('idle')
                      setAddress(value)
                      setErrors((current) => ({ ...current, address: undefined }))
                    }}
                  >
                    <Label>Address</Label>
                    <Input fullWidth placeholder="https://example.com" variant="secondary" />
                    {errors.address ? <FieldError>{errors.address}</FieldError> : null}
                  </TextField>

                  {detailsStatus === 'loading' ? (
                    <Typography className="text-muted" role="status" type="body-sm">
                      Fetching link details...
                    </Typography>
                  ) : null}
                  {detailsStatus === 'error' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Typography className="text-muted" role="status" type="body-sm">
                        {DETAILS_ERROR}
                      </Typography>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => setRetryCount((count) => count + 1)}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}

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

                  <div className="grid gap-1">
                    <Switch
                      aria-describedby="source-link-details-hint"
                      className="w-full"
                      isSelected={autoFetch}
                      onChange={(enabled) => {
                        fetchDetailsSetting = enabled
                        setAutoFetch(enabled)
                        if (!enabled) cancelDetails()
                      }}
                    >
                      <Switch.Content className="w-full justify-between">
                        <span className="font-medium">Fetch link details automatically</span>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch.Content>
                    </Switch>
                    <Typography className="text-muted" id="source-link-details-hint" type="body-sm">
                      Pasting a link contacts that website to read its title and description. No
                      cookies or logins are sent.
                    </Typography>
                  </div>
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
