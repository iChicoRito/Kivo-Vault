import { useEffect, useState, type FormEvent } from 'react'
import {
  Button,
  FieldError,
  Input,
  InputGroup,
  Label,
  ListBox,
  Modal,
  Popover,
  Select,
  Switch,
  TextArea,
  TextField,
  Typography,
} from '@heroui/react'
import { DiceIcon, EyeIcon, Key01Icon, ViewOffIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import {
  PASSWORD_CATEGORIES,
  saveCredential,
  type Credential,
  type CredentialInput,
} from '../../data/passwords'
import { PasswordGeneratorPanel } from './PasswordGeneratorPanel'
import { DialogHeader } from '../../components/DialogHeader'

export type CredentialDialogProps = {
  open: boolean
  /** The credential to edit, or null to add a new one. */
  credential: Credential | null
  onClose: () => void
  onSaved: () => void
}

const SAVE_ERROR = 'Kivo could not save this credential. Your changes are still here. Try again.'
const SERVICE_REQUIRED = 'A service name is required.'
const PASSWORD_REQUIRED = 'A password is required.'

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) {
    return error
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

export function CredentialDialog({ open, credential, onClose, onSaved }: CredentialDialogProps) {
  const [service, setService] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [url, setUrl] = useState('')
  const [category, setCategory] = useState(PASSWORD_CATEGORIES[0])
  const [notes, setNotes] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)

  const [serviceError, setServiceError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)

  useEffect(() => {
    if (!open) return

    setService(credential?.service ?? '')
    setUsername(credential?.username ?? '')
    setPassword(credential?.password ?? '')
    setUrl(credential?.url ?? '')
    setCategory(credential?.category || PASSWORD_CATEGORIES[0])
    setNotes(credential?.notes ?? '')
    setIsFavorite(credential?.isFavorite ?? false)
    setServiceError(null)
    setPasswordError(null)
    setSaveError(null)
    setRevealed(false)
    setGeneratorOpen(false)
  }, [open, credential])

  async function handleSave(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (busy) return

    const trimmedService = service.trim()
    const serviceMissing = trimmedService.length === 0
    const passwordMissing = password.length === 0

    setServiceError(serviceMissing ? SERVICE_REQUIRED : null)
    setPasswordError(passwordMissing ? PASSWORD_REQUIRED : null)

    if (serviceMissing || passwordMissing) return

    const input: CredentialInput = {
      id: credential?.id,
      service: trimmedService,
      username: username.trim(),
      password,
      url: url.trim(),
      category,
      // Tags are no longer edited in this form; existing tags are kept as they are.
      tags: credential?.tags ?? [],
      notes,
      isFavorite,
    }

    setBusy(true)
    setSaveError(null)

    try {
      await saveCredential(input)
      onSaved()
      onClose()
    } catch (error) {
      setSaveError(errorText(error, SAVE_ERROR))
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
          <Modal.Dialog className="max-w-2xl">
            <DialogHeader
              description={credential ? 'Changes are saved to this login. The old details stay in its History.' : 'Save a login. It is encrypted on this device.'}
              icon={Key01Icon}
              title={credential ? 'Edit password' : 'Add password'}
            />

            <Modal.Body>
              <form className="grid gap-4" noValidate onSubmit={(event) => void handleSave(event)}>
                <TextField
                  isRequired
                  isInvalid={serviceError !== null}
                  value={service}
                  onChange={(value) => {
                    setService(value)
                    setServiceError(null)
                  }}
                >
                  <Label>Service or website</Label>
                  <Input fullWidth autoComplete="off" variant="secondary" />
                  {serviceError ? <FieldError>{serviceError}</FieldError> : null}
                </TextField>

                <TextField value={username} onChange={setUsername}>
                  <Label>Username or email</Label>
                  <Input fullWidth autoComplete="off" variant="secondary" />
                </TextField>

                <TextField
                  isRequired
                  isInvalid={passwordError !== null}
                  type={revealed ? 'text' : 'password'}
                  value={password}
                  onChange={(value) => {
                    setPassword(value)
                    setPasswordError(null)
                  }}
                >
                  <Label>Password</Label>
                  <InputGroup fullWidth variant="secondary">
                    <InputGroup.Input autoComplete="new-password" className="min-w-0" />
                    <InputGroup.Suffix className="gap-1 px-1.5">
                      <Button
                        isIconOnly
                        aria-label={revealed ? 'Hide password' : 'Show password'}
                        size="sm"
                        variant="tertiary"
                        onPress={() => setRevealed((current) => !current)}
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          icon={revealed ? ViewOffIcon : EyeIcon}
                          size={18}
                        />
                      </Button>
                      <Popover isOpen={generatorOpen} onOpenChange={setGeneratorOpen}>
                        <Button
                          isIconOnly
                          aria-label="Generate password"
                          size="sm"
                          variant="tertiary"
                        >
                          <HugeiconsIcon aria-hidden="true" icon={DiceIcon} size={18} />
                        </Button>
                        <Popover.Content className="flex flex-col overflow-hidden">
                          <Popover.Dialog className="flex min-h-0 w-96 flex-1 flex-col">
                            <Popover.Heading>Generate password</Popover.Heading>
                            <PasswordGeneratorPanel
                              onUsePassword={(generated) => {
                                setPassword(generated)
                                setRevealed(true)
                                setPasswordError(null)
                                setGeneratorOpen(false)
                              }}
                            />
                          </Popover.Dialog>
                        </Popover.Content>
                      </Popover>
                    </InputGroup.Suffix>
                  </InputGroup>
                  {passwordError ? <FieldError>{passwordError}</FieldError> : null}
                </TextField>

                <TextField value={url} onChange={setUrl}>
                  <Label>Website address</Label>
                  <Input fullWidth autoComplete="off" variant="secondary" />
                </TextField>

                <Select
                  selectedKey={category}
                  variant="secondary"
                  onSelectionChange={(key) => setCategory(String(key ?? PASSWORD_CATEGORIES[0]))}
                >
                  <Label>Category</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {PASSWORD_CATEGORIES.map((name) => (
                        <ListBox.Item key={name} id={name} textValue={name}>
                          {name}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>

                <TextField value={notes} onChange={setNotes}>
                  <Label>Notes</Label>
                  <TextArea fullWidth variant="secondary" />
                </TextField>

                <Switch isSelected={isFavorite} onChange={setIsFavorite}>
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    Favorite
                  </Switch.Content>
                </Switch>

                {saveError ? (
                  <Typography className="font-semibold text-danger" role="alert" type="body">
                    {saveError}
                  </Typography>
                ) : null}
              </form>
            </Modal.Body>

            <Modal.Footer>
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
              <Button isDisabled={busy} onPress={() => void handleSave()}>
                {busy ? 'Saving...' : 'Save'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default CredentialDialog
