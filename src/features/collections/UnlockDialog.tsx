import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Button,
  FieldError,
  Input,
  InputOTP,
  Label,
  Modal,
  REGEXP_ONLY_DIGITS,
  TextField,
  Typography,
} from '@heroui/react'
import { SquareLock01Icon } from '@hugeicons/core-free-icons'

import { type Collection, verifyCollectionSecret } from '../../data/collections'
import { DialogHeader } from '../../components/DialogHeader'

export type UnlockDialogProps = {
  collection: Collection | null
  onCancel: () => void
  onUnlocked: (id: string) => void
}

const EMPTY_PASSWORD_MESSAGE = 'Enter the password.'
const EMPTY_PIN_MESSAGE = 'Enter the PIN.'
const WRONG_PASSWORD_MESSAGE = 'That password did not match. Try again.'
const WRONG_PIN_MESSAGE = 'That PIN did not match. Try again.'
const CHECK_ERROR_MESSAGE = 'We could not check the password. Try again.'

const PIN_SLOTS = [0, 1, 2, 3, 4, 5]

/**
 * Asks for a protected collection's secret before a blocked action runs. One
 * dialog serves every collection: a password field or a PIN field. A correct
 * secret calls `onUnlocked`; a wrong or empty one leaves an inline message. The
 * field and the message reset whenever the collection changes or the dialog
 * closes, so the next collection never starts with the last secret.
 */
export function UnlockDialog({ collection, onCancel, onUnlocked }: UnlockDialogProps) {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const otpRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  // Bumped whenever the dialog closes or swaps collections, so a check that
  // lands after a cancel cannot unlock a collection the user walked away from.
  const requestSeq = useRef(0)

  const isPin = collection?.protection === 'pin'

  useEffect(() => {
    requestSeq.current += 1
    setSecret('')
    setError(null)
  }, [collection])

  useEffect(() => {
    if (collection?.protection === 'pin') {
      otpRef.current?.focus()
    } else if (collection) {
      passwordRef.current?.focus()
    }
  }, [collection])

  if (!collection) return null

  function handleClose() {
    requestSeq.current += 1
    setSecret('')
    setError(null)
    onCancel()
  }

  function handleSecret(value: string) {
    setSecret(value)
    setError(null)
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    if (!collection || busyRef.current) return

    if (!secret) {
      setError(isPin ? EMPTY_PIN_MESSAGE : EMPTY_PASSWORD_MESSAGE)
      return
    }

    busyRef.current = true
    setChecking(true)
    setError(null)

    const request = requestSeq.current

    try {
      const matched = await verifyCollectionSecret(collection.id, secret)

      if (request !== requestSeq.current) return

      if (matched) {
        setSecret('')
        onUnlocked(collection.id)
      } else {
        setError(isPin ? WRONG_PIN_MESSAGE : WRONG_PASSWORD_MESSAGE)
      }
    } catch {
      if (request !== requestSeq.current) return

      setError(CHECK_ERROR_MESSAGE)
    } finally {
      busyRef.current = false
      setChecking(false)
    }
  }

  return (
    <Modal
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen) handleClose()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <DialogHeader
              description={`This collection is locked. Enter its ${isPin ? 'PIN' : 'password'} to open it.`}
              icon={SquareLock01Icon}
              title={`Open "${collection.name}"`}
            />

            <Modal.Body className="grid gap-4">
              <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
                {isPin ? (
                  <TextField isInvalid={error !== null}>
                    <Label>PIN</Label>
                    <InputOTP
                      aria-label="Collection PIN"
                      className="kivo-otp"
                      inputMode="numeric"
                      maxLength={6}
                      pattern={REGEXP_ONLY_DIGITS}
                      ref={otpRef}
                      value={secret}
                      onChange={handleSecret}
                    >
                      <InputOTP.Group>
                        {PIN_SLOTS.map((index) => (
                          <InputOTP.Slot key={index} index={index} />
                        ))}
                      </InputOTP.Group>
                    </InputOTP>
                    {error ? <FieldError>{error}</FieldError> : null}
                  </TextField>
                ) : (
                  <TextField
                    isRequired
                    isInvalid={error !== null}
                    type="password"
                    value={secret}
                    onChange={handleSecret}
                  >
                    <Label>Password</Label>
                    <Input
                      fullWidth
                      autoComplete="current-password"
                      ref={passwordRef}
                      variant="secondary"
                    />
                    {error ? <FieldError>{error}</FieldError> : null}
                  </TextField>
                )}

                <Typography color="muted" type="body">
                  {isPin
                    ? 'This collection is protected. Enter the PIN.'
                    : 'This collection is protected. Enter the password.'}
                </Typography>
              </form>
            </Modal.Body>

            <Modal.Footer>
              <Button isDisabled={checking} variant="secondary" onPress={handleClose}>
                Cancel
              </Button>
              <Button isDisabled={checking} onPress={() => void submit()}>
                {checking ? 'Checking...' : 'Unlock'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
