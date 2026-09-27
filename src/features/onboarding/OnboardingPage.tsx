import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Description,
  FieldError,
  Input,
  Label,
  TextField,
  Typography,
} from '@heroui/react'

import KivoMark from '../../components/ui/KivoMark'
import SplitText from '../../components/ui/SplitText'
import { hashPassword } from '../../data/security'
import { completeSetup } from '../../data/setup'
import {
  STARTER_COLLECTIONS,
  STARTER_COLLECTION_DETAILS,
  createOnboardingDraft,
  getNextStep,
  getPreviousStep,
  resolveVaultName,
  toSetupInput,
  validateOwnerName,
  validateMasterPassword,
  validatePasswordConfirmation,
  type OnboardingDraft,
  type OnboardingStep,
} from './onboarding'

export type OnboardingPageProps = {
  onCompleted?: () => void
}

const STEP_CONTENT: Record<OnboardingStep, { title: string; description: string }> = {
  intro: {
    title: 'Kivo',
    description: 'Your personal space for everything you want to keep close',
  },
  welcome: {
    title: 'Everything important, in one place.',
    description:
      'Keep your notes, files, useful links, documents, and personal information organized inside your own private vault.',
  },
  profile: {
    title: 'Make Kivo yours',
    description: 'Tell us a little about how you want your personal vault to be set up.',
  },
  collections: {
    title: 'What will you keep in Kivo',
    description: 'Choose anything that applies. Kivo can prepare some starter collections for you.',
  },
  lock: {
    title: 'Keep your vault private',
    description:
      "Add a Master Password to lock Kivo and help protect your personal information when you're away from your device",
  },
  complete: {
    title: 'Congrats! Your vault has been created',
    description:
      'Your personal space is ready. Start organizing your notes, files, links, and important information.',
  },
}

const INTRO_DURATION_MS = 5000

/** Kept in step with the exit animations under `.kivo-intro-leaving` in `styles/globals.css`. */
const INTRO_EXIT_MS = 500

// SplitText's default end state, plus a start delay added per line.
const INTRO_TEXT_TO = { opacity: 1, y: 0 }

const SAVE_ERROR_MESSAGE =
  'We could not create your vault. Your details are still here. Try again.'

function GoBackButton({ onPress, isDisabled = false }: { onPress: () => void; isDisabled?: boolean }) {
  return (
    <Button variant="ghost" isDisabled={isDisabled} onPress={onPress}>
      <span aria-hidden="true">←</span> Go back
    </Button>
  )
}

export default function OnboardingPage({ onCompleted }: OnboardingPageProps) {
  const [step, setStep] = useState<OnboardingStep>('intro')
  const [draft, setDraft] = useState<OnboardingDraft>(createOnboardingDraft)
  const [ownerError, setOwnerError] = useState<string | null>(null)
  const [masterError, setMasterError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [introLeaving, setIntroLeaving] = useState(false)

  const headingRef = useRef<HTMLHeadingElement>(null)
  const ownerInputRef = useRef<HTMLInputElement>(null)
  const masterInputRef = useRef<HTMLInputElement>(null)
  const confirmInputRef = useRef<HTMLInputElement>(null)

  const currentStep = STEP_CONTENT[step]

  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  // The logo intro moves on by itself; nothing on it needs input. It starts its
  // exit animation just before the step changes.
  useEffect(() => {
    if (step !== 'intro') return
    const exitTimer = window.setTimeout(() => setIntroLeaving(true), INTRO_DURATION_MS - INTRO_EXIT_MS)
    const nextTimer = window.setTimeout(() => setStep('welcome'), INTRO_DURATION_MS)
    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(nextTimer)
    }
  }, [step])

  // The intro text leaves as SplitText's entrance in reverse: the last letter
  // or word goes first, dropping back down as it fades.
  useEffect(() => {
    const header = headingRef.current?.closest('header')
    if (!introLeaving || !header) return

    const title = header.querySelectorAll('h1 .split-char')
    const words = header.querySelectorAll('p .split-word')
    const exit = { opacity: 0, y: 40, ease: 'power3.in', stagger: { each: 0.03, from: 'end' as const } }

    if (title.length > 0) gsap.to(title, { ...exit, duration: 0.3 })
    if (words.length > 0) gsap.to(words, { ...exit, duration: 0.3, stagger: { each: 0.02, from: 'end' } })
  }, [introLeaving])

  function updateDraft(patch: Partial<OnboardingDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function goForward() {
    const next = getNextStep(step)
    setOwnerError(null)
    setMasterError(null)
    setPasswordError(null)
    setSaveError(null)
    if (next) setStep(next)
  }

  function goBack() {
    const previous = getPreviousStep(step)
    setOwnerError(null)
    setMasterError(null)
    setPasswordError(null)
    setSaveError(null)
    if (previous) setStep(previous)
  }

  function handleProfileContinue() {
    const error = validateOwnerName(draft.ownerName)

    setOwnerError(error)
    if (error) {
      ownerInputRef.current?.focus()
      return
    }

    goForward()
  }

  function handleSkipCollections() {
    updateDraft({ starterCollections: [] })
    goForward()
  }

  async function createVault(password: string) {
    setSaving(true)
    setSaveError(null)

    try {
      const verifier = password ? await hashPassword(password) : null

      await completeSetup(toSetupInput(draft, verifier))

      setDraft((current) => ({ ...current, password: '', confirmPassword: '' }))
      setStep('complete')
    } catch {
      setSaveError(SAVE_ERROR_MESSAGE)
    } finally {
      setSaving(false)
    }
  }

  function handleCreateVault() {
    const emptyError = validateMasterPassword(draft.password)

    setMasterError(emptyError)
    if (emptyError) {
      setPasswordError(null)
      masterInputRef.current?.focus()
      return
    }

    const error = validatePasswordConfirmation(draft.password, draft.confirmPassword)

    setPasswordError(error)
    if (error) {
      confirmInputRef.current?.focus()
      return
    }

    void createVault(draft.password)
  }

  function handleSkipPassword() {
    setMasterError(null)
    setPasswordError(null)
    void createVault('')
  }

  // Intro, Welcome, and Complete are centered statements; the form steps align left.
  const isIntro = step === 'intro'
  const isCenteredStep = isIntro || step === 'welcome' || step === 'complete'

  return (
    <section
      aria-labelledby="onboarding-heading"
      aria-busy={saving}
      className="flex h-full w-full flex-col items-center justify-center px-6 py-8 sm:px-10"
    >
      <div className="grid w-full max-w-2xl gap-10">
        {/* Same SplitText settings as the page headers (see `app/PageHeader.tsx`).
            The key remounts the header per step so each step's text plays its entrance. */}
        <header
          key={step}
          className={[
            isCenteredStep ? 'grid justify-items-center gap-3 text-center' : 'grid gap-3',
            introLeaving && isIntro ? 'kivo-intro-leaving' : '',
          ].join(' ')}
        >
          {isIntro && <KivoMark className="kivo-logo-intro h-28 w-auto overflow-visible text-foreground" />}
          <SplitText
            className="typography typography--h1 outline-none"
            delay={30}
            duration={0.55}
            id="onboarding-heading"
            ref={headingRef}
            splitType="chars"
            tag="h1"
            tabIndex={-1}
            text={currentStep.title}
            textAlign={isCenteredStep ? 'center' : 'start'}
            // On the intro the text waits for the two halves of the mark to meet.
            to={isIntro ? { ...INTRO_TEXT_TO, delay: 0.7 } : undefined}
          />
          <SplitText
            className={`typography typography--body typography--color-muted${isIntro ? ' max-w-74 text-lg' : ''}`}
            delay={25}
            duration={0.5}
            splitType="words"
            tag="p"
            text={currentStep.description}
            textAlign={isCenteredStep ? 'center' : 'start'}
            to={isIntro ? { ...INTRO_TEXT_TO, delay: 0.9 } : undefined}
          />
        </header>

        {step === 'welcome' && (
          <div className="flex justify-center">
            <Button variant="primary" onPress={goForward}>
              Get Started
            </Button>
          </div>
        )}

        {step === 'profile' && (
          <div className="grid gap-6">
            <TextField
              className="w-full"
              isRequired
              isInvalid={ownerError !== null}
              value={draft.ownerName}
              onChange={(value) => updateDraft({ ownerName: value })}
            >
              <Label>Your name</Label>
              <Input
                fullWidth
                ref={ownerInputRef}
                autoComplete="name"
                placeholder="Enter your Name"
                variant="secondary"
              />
              {ownerError ? <FieldError>{ownerError}</FieldError> : null}
            </TextField>

            <div>
              <Button variant="primary" onPress={handleProfileContinue}>
                Save name
              </Button>
            </div>
          </div>
        )}

        {step === 'collections' && (
          <div className="grid gap-8">
            <CheckboxGroup
              className="grid gap-4"
              value={draft.starterCollections}
              onChange={(values) => updateDraft({ starterCollections: values })}
            >
              <Label className="sr-only">Starter collections</Label>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {STARTER_COLLECTIONS.map((collection) => (
                  <Checkbox
                    key={collection}
                    value={collection}
                    className="relative mt-0! flex cursor-pointer flex-col gap-1 rounded-3xl border border-default bg-surface p-4 transition-colors duration-200 ease-out hover:bg-surface-hover data-[selected=true]:border-accent data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-offset-2 data-[focus-visible=true]:outline-focus"
                  >
                    {/* The overlay stretches the label's click area over the whole card. */}
                    <Checkbox.Content className="static after:absolute after:inset-0 after:rounded-3xl">
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span className="font-semibold">{collection}</span>
                    </Checkbox.Content>
                    <Description>{STARTER_COLLECTION_DETAILS[collection]}</Description>
                  </Checkbox>
                ))}
              </div>
            </CheckboxGroup>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <GoBackButton onPress={goBack} />
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onPress={handleSkipCollections}>
                  Skip for now
                </Button>
                <Button variant="primary" onPress={goForward}>
                  Submit
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'lock' && (
          <div className="grid gap-6">
            <TextField
              className="w-full"
              type="password"
              isInvalid={masterError !== null}
              value={draft.password}
              onChange={(value) => updateDraft({ password: value })}
            >
              <Label>Master Password</Label>
              <Input
                fullWidth
                ref={masterInputRef}
                autoComplete="new-password"
                placeholder="Enter master password"
                variant="secondary"
              />
              {masterError ? <FieldError>{masterError}</FieldError> : null}
            </TextField>

            <TextField
              className="w-full"
              type="password"
              isInvalid={passwordError !== null}
              value={draft.confirmPassword}
              onChange={(value) => updateDraft({ confirmPassword: value })}
            >
              <Label>Confirm Password</Label>
              <Input
                fullWidth
                ref={confirmInputRef}
                autoComplete="new-password"
                placeholder="Enter master password"
                variant="secondary"
              />
              {passwordError ? <FieldError>{passwordError}</FieldError> : null}
            </TextField>

            {saveError ? (
              <Typography className="font-semibold text-danger" role="alert" type="body">
                {saveError}
              </Typography>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <GoBackButton onPress={goBack} isDisabled={saving} />
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" isDisabled={saving} onPress={handleSkipPassword}>
                  Skip for now
                </Button>
                <Button variant="primary" isDisabled={saving} onPress={handleCreateVault}>
                  {saving ? 'Creating your vault...' : 'Create Password'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'complete' && (
          <div className="flex justify-center">
            {onCompleted ? (
              <Button variant="primary" onPress={onCompleted}>
                Let's Go!
              </Button>
            ) : (
              <Button variant="primary" isDisabled>
                Let's Go! (not available)
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
