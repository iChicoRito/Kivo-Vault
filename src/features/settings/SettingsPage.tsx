import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Card,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  Radio,
  RadioGroup,
  Separator,
  Skeleton,
  Switch,
  Tabs,
  TextField,
  Typography,
  useOverlayState,
} from '@heroui/react'
import { getName, getVersion } from '@tauri-apps/api/app'
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'

import {
  loadProfile,
  saveProfile,
  saveStartAtLogin,
  type Density,
  type NavigationStyle,
  type Preferences,
  type Theme,
} from '../../data/settings'
import { usePreferences } from '../../app/preferences'
import PageHeader from '../../app/PageHeader'
import { notifyError, notifySuccess } from '../../lib/feedback'
import { cn } from '../../lib/utils'
import { listIndexState, type IndexState } from '../../data/indexing'
import { reindexItems } from '../../data/insights'
import AppLockSettings from '../security/AppLockSettings'
import EncryptionSettings from '../security/EncryptionSettings'
import BackupSettings from '../backup/BackupSettings'
import DangerZoneSettings from './DangerZoneSettings'
import PortabilitySettings from '../portability/PortabilitySettings'
import { ShortcutsDialog } from '../shortcuts/ShortcutsDialog'

type LoadState = 'loading' | 'ready' | 'error'

type Choice<Value extends string> = { value: Value; label: string }

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'security', label: 'Security' },
  { id: 'data', label: 'Data' },
  { id: 'about', label: 'About' },
]

const THEME_OPTIONS: Choice<Theme>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const DENSITY_OPTIONS: Choice<Density>[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
]

const NAVIGATION_OPTIONS: Choice<NavigationStyle>[] = [
  { value: 'dock', label: 'Dock' },
  { value: 'sidebar', label: 'Sidebar' },
]

const SMART_FEATURES = [
  {
    key: 'semanticSearch',
    label: 'Smarter search',
    hint: 'Also finds items with similar words, not only exact matches.',
  },
  {
    key: 'autoTag',
    label: 'Tag suggestions',
    hint: 'Suggests tags when you add something new.',
  },
  {
    key: 'summaries',
    label: 'Note summaries',
    hint: 'Suggests a short summary for long notes. It is kept only if you save it.',
  },
] as const

// Only how Kivo looks goes back to the defaults; the profile, sign-in,
// security, and smart feature settings stay as they are.
const RESET_APPEARANCE: Partial<Preferences> = {
  theme: 'dark',
  density: 'comfortable',
  navigationStyle: 'dock',
  notesView: 'grid',
  sourcesView: 'grid',
  collectionsView: 'grid',
}

const SECTION_TITLE_CLASS = 'text-lg font-semibold'
const START_AT_LOGIN_LABEL = 'Open Kivo when you sign in'

const OWNER_REQUIRED_ERROR = 'Enter your name.'
const PROFILE_SAVED_MESSAGE = 'Profile saved.'
const PROFILE_SAVE_ERROR =
  'Kivo could not save your profile. Your changes are still here. Try again.'
const APPEARANCE_SAVE_ERROR = 'Kivo could not save this change. Your settings are unchanged.'
const NATIVE_SAVE_ERROR = 'Kivo could not change whether it opens when you sign in.'
const AUTOSTART_NOT_SAVED =
  'Kivo will open when you sign in as set, but it could not save the change. Try again.'
const RESET_SAVE_ERROR = 'Kivo could not reset the appearance. Your settings are unchanged.'
const REINDEX_ERROR = 'Kivo could not refresh search. Try again.'

function SettingsSkeleton({ className }: { className: string }) {
  return <Skeleton aria-hidden="true" className={className} />
}

function SettingsSection({
  children,
  description,
  id,
  title,
}: {
  children: ReactNode
  description?: string
  id: string
  title: string
}) {
  return (
    <Card aria-labelledby={id}>
      <Card.Content className="grid gap-4">
        <div className="grid gap-1">
          <Typography className={SECTION_TITLE_CLASS} id={id} type="h2">
            {title}
          </Typography>
          {description ? (
            <Typography color="muted" type="body-sm">
              {description}
            </Typography>
          ) : null}
        </div>
        {children}
      </Card.Content>
    </Card>
  )
}

// Appearance options are cards: a small drawing of the choice above its radio
// and label. The card is the radio's clickable label, so keyboard and screen
// reader behavior stay HeroUI's.
const CHOICE_CARD_CLASS =
  'flex w-full cursor-pointer flex-col items-stretch gap-2 rounded-2xl border border-separator p-2 transition-colors hover:bg-(--default)/50 group-data-[selected]:border-accent group-data-[selected]:bg-accent/5 data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-offset-2 data-[focus-visible=true]:outline-accent'

// Light and dark previews use fixed colors on purpose: each must show its own
// palette whatever the app theme is right now.
function MiniWindow({ tone }: { tone: 'light' | 'dark' }) {
  const light = tone === 'light'
  return (
    <div
      className={cn('flex h-full flex-1 flex-col gap-1.5 p-2', light ? 'bg-white' : 'bg-zinc-900')}
    >
      <div className={cn('h-1.5 w-1/2 rounded-full', light ? 'bg-zinc-300' : 'bg-zinc-600')} />
      <div className={cn('h-1.5 w-3/4 rounded-full', light ? 'bg-zinc-200' : 'bg-zinc-700')} />
      <div className={cn('h-1.5 w-2/3 rounded-full', light ? 'bg-zinc-200' : 'bg-zinc-700')} />
      <div className="mt-auto h-2 w-6 rounded-full bg-accent" />
    </div>
  )
}

function PreviewLines({ count, className }: { count: number; className: string }) {
  return (
    <div className={cn('flex flex-1 flex-col', className)}>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={cn('h-1.5 rounded-full bg-foreground/15', index % 2 ? 'w-3/4' : 'w-full')}
        />
      ))}
    </div>
  )
}

function ChoicePreview({ value }: { value: string }) {
  let drawing: ReactNode
  if (value === 'light' || value === 'dark') drawing = <MiniWindow tone={value} />
  else if (value === 'system')
    drawing = (
      <div className="flex h-full">
        <MiniWindow tone="light" />
        <MiniWindow tone="dark" />
      </div>
    )
  else if (value === 'comfortable')
    drawing = <PreviewLines count={3} className="h-full gap-2.5 p-2.5" />
  else if (value === 'compact') drawing = <PreviewLines count={6} className="h-full gap-1 p-1.5" />
  else if (value === 'dock')
    drawing = (
      <div className="relative h-full">
        <PreviewLines count={2} className="gap-1.5 p-2" />
        <div className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-(--default) px-1.5 py-1">
          <span className="size-1.5 rounded-full bg-accent" />
          <span className="size-1.5 rounded-full bg-foreground/40" />
          <span className="size-1.5 rounded-full bg-foreground/40" />
          <span className="size-1.5 rounded-full bg-foreground/40" />
        </div>
      </div>
    )
  else
    drawing = (
      <div className="flex h-full gap-1.5 p-1.5">
        <div className="flex w-1/4 flex-col gap-1 rounded-md bg-(--default) p-1">
          <span className="h-1.5 rounded-full bg-accent" />
          <span className="h-1.5 rounded-full bg-foreground/30" />
          <span className="h-1.5 rounded-full bg-foreground/30" />
        </div>
        <PreviewLines count={3} className="gap-1.5 py-0.5" />
      </div>
    )

  return (
    <div
      aria-hidden="true"
      className="h-16 overflow-hidden rounded-xl border border-separator bg-background"
    >
      {drawing}
    </div>
  )
}

// One switch per row, with a short plain hint under it.
function SettingRow({
  children,
  hint,
  hintId,
}: {
  children: ReactNode
  hint: string
  hintId: string
}) {
  return (
    <div className="grid gap-0.5">
      {children}
      <Typography className="pr-14" color="muted" id={hintId} type="body-sm">
        {hint}
      </Typography>
    </div>
  )
}

export default function SettingsPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)

  const [ownerName, setOwnerName] = useState('')
  const [vaultName, setVaultName] = useState('')
  const [ownerError, setOwnerError] = useState<string | null>(null)
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)

  const { preferences, updatePreferences } = usePreferences()
  const [appearanceError, setAppearanceError] = useState<string | null>(null)
  const [startAtLogin, setStartAtLogin] = useState(preferences.startAtLogin)
  const [startAtLoginBusy, setStartAtLoginBusy] = useState(false)
  const [startAtLoginError, setStartAtLoginError] = useState<string | null>(null)

  const [appName, setAppName] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  const storedStartAtLogin = useRef(preferences.startAtLogin)
  const resetTriggerRef = useRef<HTMLButtonElement>(null)
  const resetDialog = useOverlayState()
  const resetWasOpen = useRef(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const navigate = useNavigate()
  const [indexStates, setIndexStates] = useState<IndexState[]>([])
  const [reindexBusy, setReindexBusy] = useState(false)

  useEffect(() => {
    let active = true
    setLoadState('loading')

    void (async () => {
      try {
        const loadedProfile = await loadProfile()

        if (!loadedProfile) {
          throw new Error('Settings are unavailable')
        }

        if (!active) return

        setOwnerName(loadedProfile.ownerName)
        setVaultName(loadedProfile.vaultName)
        setLoadState('ready')

        let nativeStartAtLogin: boolean | undefined

        try {
          const native = await isAutostartEnabled()
          if (typeof native === 'boolean') nativeStartAtLogin = native
        } catch {
          // Keep the saved preference when the native check is unavailable.
        }

        if (!active || nativeStartAtLogin === undefined) return

        setStartAtLogin(nativeStartAtLogin)

        if (nativeStartAtLogin !== storedStartAtLogin.current) {
          try {
            await saveStartAtLogin(nativeStartAtLogin)
          } catch {
            if (active) setStartAtLoginError(AUTOSTART_NOT_SAVED)
          }
        }
      } catch {
        if (active) setLoadState('error')
      }
    })()

    return () => {
      active = false
    }
  }, [attempt])

  useEffect(() => {
    let active = true

    void (async () => {
      try {
        const [name, version] = await Promise.all([getName(), getVersion()])
        if (!active) return

        setAppName(name ?? null)
        setAppVersion(version ?? null)
      } catch {
        // Leave app information empty when Tauri metadata is unavailable.
      }
    })()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true

    void listIndexState()
      .then((states) => {
        if (active) setIndexStates(Array.isArray(states) ? states : [])
      })
      .catch(() => {
        if (active) setIndexStates([])
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (resetWasOpen.current && !resetDialog.isOpen) {
      resetTriggerRef.current?.focus()
    }

    resetWasOpen.current = resetDialog.isOpen
  }, [resetDialog.isOpen])

  // Swapping dock and sidebar runs as a view transition: the sidebar slides in
  // from the left, the dock drops away, and the page area glides to its new
  // size. `data-kivo-nav-vt` scopes the CSS so the theme wipe keeps its own.
  function switchNavigation(style: NavigationStyle) {
    const apply = () => flushSync(() => void handleAppearanceChange({ navigationStyle: style }))
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (typeof document.startViewTransition !== 'function' || reduced) return apply()

    const root = document.documentElement
    root.dataset.kivoNavVt = 'active'
    const transition = document.startViewTransition(apply)
    void transition.finished.finally(() => delete root.dataset.kivoNavVt)
  }

  async function handleAppearanceChange(patch: Partial<Preferences>) {
    setAppearanceError(null)

    try {
      await updatePreferences({ ...patch, startAtLogin })
    } catch {
      setAppearanceError(APPEARANCE_SAVE_ERROR)
      notifyError(APPEARANCE_SAVE_ERROR)
    }
  }

  async function handleSaveProfile() {
    const trimmedOwner = ownerName.trim()
    const trimmedVault = vaultName.trim()

    if (!trimmedOwner) {
      setOwnerError(OWNER_REQUIRED_ERROR)
      return
    }

    setOwnerError(null)
    setProfileSaveError(null)
    setProfileSaved(false)
    setProfileSaving(true)

    const nextVault = trimmedVault || `${trimmedOwner}'s Vault`

    try {
      await saveProfile({ ownerName: trimmedOwner, vaultName: nextVault })

      setOwnerName(trimmedOwner)
      setVaultName(nextVault)
      setProfileSaved(true)
      notifySuccess('Profile saved')
    } catch {
      setProfileSaveError(PROFILE_SAVE_ERROR)
      notifyError(PROFILE_SAVE_ERROR)
    } finally {
      setProfileSaving(false)
    }
  }

  async function handleStartAtLoginChange(enabled: boolean) {
    const previous = startAtLogin

    setStartAtLogin(enabled)
    setStartAtLoginError(null)
    setStartAtLoginBusy(true)

    try {
      if (enabled) {
        await enableAutostart()
      } else {
        await disableAutostart()
      }
    } catch {
      setStartAtLogin(previous)
      setStartAtLoginError(NATIVE_SAVE_ERROR)
      notifyError(NATIVE_SAVE_ERROR)
      setStartAtLoginBusy(false)
      return
    }

    try {
      await saveStartAtLogin(enabled)
    } catch {
      let reconciled = enabled

      try {
        const native = await isAutostartEnabled()
        if (typeof native === 'boolean') reconciled = native
      } catch {
        // Fall back to the requested value when the native state cannot be read.
      }

      setStartAtLogin(reconciled)
      setStartAtLoginError(AUTOSTART_NOT_SAVED)
      notifyError(AUTOSTART_NOT_SAVED)
      setStartAtLoginBusy(false)
      return
    }

    setStartAtLoginBusy(false)
  }

  async function handleResetPreferences() {
    setResetBusy(true)
    setResetError(null)

    try {
      await updatePreferences(RESET_APPEARANCE)
      setAppearanceError(null)
      resetDialog.close()
      notifySuccess('Appearance reset')
    } catch {
      setResetError(RESET_SAVE_ERROR)
      notifyError(RESET_SAVE_ERROR)
    } finally {
      setResetBusy(false)
    }
  }

  async function handleReindex() {
    setReindexBusy(true)

    try {
      const report = await reindexItems()
      notifySuccess('Search refreshed', `${report.indexed} items ready, ${report.pending} waiting.`)
      const states = await listIndexState()
      setIndexStates(Array.isArray(states) ? states : [])
    } catch {
      notifyError(REINDEX_ERROR)
    } finally {
      setReindexBusy(false)
    }
  }

  const indexReady = indexStates.filter((state) => !state.needsIndex).length
  const indexWaiting = indexStates.filter((state) => state.needsIndex).length

  const heading = (
    <PageHeader
      description="Choose how Kivo looks, opens, and keeps your things safe."
      title="Settings"
      titleId="settings-title"
    />
  )

  if (loadState === 'loading') {
    return (
      <section aria-labelledby="settings-title" className="grid gap-5">
        {heading}
        <div aria-label="Loading settings" className="grid gap-5" role="status">
          <SettingsSkeleton className="h-10 w-96 max-w-full rounded-full" />
          <Card>
            <Card.Content className="grid gap-4">
              <SettingsSkeleton className="h-5 w-24 rounded" />
              <div className="grid gap-4 sm:grid-cols-2">
                <SettingsSkeleton className="h-10 w-full rounded-xl" />
                <SettingsSkeleton className="h-10 w-full rounded-xl" />
              </div>
              <SettingsSkeleton className="h-10 w-28 rounded-full" />
            </Card.Content>
          </Card>
          <Card>
            <Card.Content className="grid gap-4">
              <SettingsSkeleton className="h-5 w-32 rounded" />
              <SettingsSkeleton className="h-4 w-full rounded" />
              <SettingsSkeleton className="h-4 w-4/5 rounded" />
            </Card.Content>
          </Card>
        </div>
      </section>
    )
  }

  if (loadState === 'error') {
    return (
      <section aria-labelledby="settings-title" className="grid gap-5">
        {heading}
        <Card aria-labelledby="settings-error-title" className="border-danger" role="alert">
          <Card.Content className="grid gap-2">
            <Typography className={SECTION_TITLE_CLASS} id="settings-error-title" type="h2">
              Settings could not load
            </Typography>
            <Typography color="muted" type="body">
              Kivo could not read your settings. Try again to reload this screen.
            </Typography>
            <Button
              className="justify-self-start"
              variant="secondary"
              onPress={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </Card.Content>
        </Card>
      </section>
    )
  }

  const choiceGroups = [
    {
      name: 'theme',
      label: 'Theme',
      hint: 'Light, dark, or match your computer.',
      value: preferences.theme,
      options: THEME_OPTIONS,
      onChange: (value: string) => void handleAppearanceChange({ theme: value as Theme }),
    },
    {
      name: 'density',
      label: 'Spacing',
      hint: 'How much room Kivo leaves around things.',
      value: preferences.density,
      options: DENSITY_OPTIONS,
      onChange: (value: string) => void handleAppearanceChange({ density: value as Density }),
    },
    {
      name: 'navigation',
      label: 'Menu style',
      hint: 'A dock at the bottom, or a sidebar on the left.',
      value: preferences.navigationStyle,
      options: NAVIGATION_OPTIONS,
      onChange: (value: string) => switchNavigation(value as NavigationStyle),
    },
  ]

  return (
    <section aria-labelledby="settings-title" className="grid gap-5">
      {heading}

      <Tabs defaultSelectedKey="general">
        <Tabs.ListContainer className="overflow-x-auto">
          <Tabs.List aria-label="Settings sections" className="w-fit">
            {TABS.map((tab) => (
              <Tabs.Tab key={tab.id} id={tab.id}>
                {tab.label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel className="grid gap-5 pt-5" id="general">
          <SettingsSection
            description="Your name and vault name appear on the Dashboard."
            id="settings-profile-title"
            title="Profile"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                isRequired
                isInvalid={ownerError !== null}
                value={ownerName}
                onChange={(value) => {
                  setOwnerName(value)
                  setOwnerError(null)
                  setProfileSaved(false)
                }}
              >
                <Label>Your name</Label>
                <Input fullWidth autoComplete="name" variant="secondary" />
                {ownerError ? <FieldError>{ownerError}</FieldError> : null}
              </TextField>

              <TextField
                value={vaultName}
                onChange={(value) => {
                  setVaultName(value)
                  setProfileSaved(false)
                }}
              >
                <Label>Vault name</Label>
                <Input fullWidth variant="secondary" />
              </TextField>
            </div>

            {profileSaveError ? (
              <Typography className="font-semibold text-danger" role="alert" type="body">
                {profileSaveError}
              </Typography>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button isDisabled={profileSaving} onPress={handleSaveProfile}>
                Save profile
              </Button>
              <Typography aria-live="polite" className="font-semibold text-accent" type="body-sm">
                {profileSaved ? PROFILE_SAVED_MESSAGE : ''}
              </Typography>
            </div>
          </SettingsSection>

          <SettingsSection id="settings-startup-title" title="Startup and shortcuts">
            <SettingRow
              hint="Kivo opens by itself when you sign in to this computer."
              hintId="settings-startup-hint"
            >
              <Switch
                aria-describedby="settings-startup-hint"
                className="w-full"
                isDisabled={startAtLoginBusy}
                isSelected={startAtLogin}
                onChange={(enabled) => void handleStartAtLoginChange(enabled)}
              >
                <Switch.Content className="w-full justify-between">
                  <span className="font-medium">{START_AT_LOGIN_LABEL}</span>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </SettingRow>
            {startAtLoginError ? (
              <Typography className="font-semibold text-danger" role="alert" type="body-sm">
                {startAtLoginError}
              </Typography>
            ) : null}
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-0.5">
                <Typography type="body" weight="medium">
                  Keyboard shortcuts
                </Typography>
                <Typography color="muted" type="body-sm">
                  Keys for search, quick add, and moving between pages.
                </Typography>
              </div>
              <Button variant="secondary" onPress={() => setShortcutsOpen(true)}>
                Show shortcuts
              </Button>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-0.5">
                <Typography type="body" weight="medium">
                  Guided tour
                </Typography>
                <Typography color="muted" type="body-sm">
                  Walk through every page again and see what each one does.
                </Typography>
              </div>
              <Button variant="secondary" onPress={() => navigate('/dashboard', { state: { tour: true } })}>
                Take the tour
              </Button>
            </div>
          </SettingsSection>

          <SettingsSection
            description="Optional helpers. They run on this device and never send anything online."
            id="settings-smart-title"
            title="Smart features"
          >
            {SMART_FEATURES.map((feature, index) => (
              <Fragment key={feature.key}>
                {index > 0 ? <Separator /> : null}
                <SettingRow hint={feature.hint} hintId={`settings-${feature.key}-hint`}>
                  <Switch
                    aria-describedby={`settings-${feature.key}-hint`}
                    className="w-full"
                    isSelected={preferences[feature.key]}
                    onChange={(enabled) => void handleAppearanceChange({ [feature.key]: enabled })}
                  >
                    <Switch.Content className="w-full justify-between">
                      <span className="font-medium">{feature.label}</span>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </SettingRow>
                {feature.key === 'semanticSearch' && preferences.semanticSearch ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-(--default) px-4 py-3">
                    <Typography aria-live="polite" type="body-sm">
                      {indexWaiting
                        ? `Search is ready for ${indexReady} items. ${indexWaiting} still waiting.`
                        : indexReady
                          ? `Search is ready for all ${indexReady} items.`
                          : 'Nothing to search yet.'}
                    </Typography>
                    <Button
                      isDisabled={reindexBusy}
                      size="sm"
                      variant="secondary"
                      onPress={() => void handleReindex()}
                    >
                      {reindexBusy ? 'Refreshing...' : 'Refresh search'}
                    </Button>
                  </div>
                ) : null}
              </Fragment>
            ))}
          </SettingsSection>
        </Tabs.Panel>

        <Tabs.Panel className="grid gap-5 pt-5" id="appearance">
          <SettingsSection id="settings-appearance-title" title="Appearance">
            {choiceGroups.map((group, index) => (
              <Fragment key={group.name}>
                {index > 0 ? <Separator /> : null}
                <RadioGroup
                  className="grid gap-3"
                  name={group.name}
                  orientation="horizontal"
                  value={group.value}
                  variant="secondary"
                  onChange={group.onChange}
                >
                  <div className="grid gap-0.5">
                    <Label className="text-base font-medium">{group.label}</Label>
                    <Description className="text-sm">{group.hint}</Description>
                  </div>
                  {/* Three columns for every group, so cards keep one width
                      whether a group has two options or three. */}
                  <div className="grid max-w-2xl grid-cols-3 gap-3 max-sm:grid-cols-2">
                    {group.options.map((option) => (
                      <Radio key={option.value} className="group" value={option.value}>
                        <Radio.Content className={CHOICE_CARD_CLASS}>
                          <ChoicePreview value={option.value} />
                          <span className="flex items-center gap-2 px-1 pb-0.5">
                            <Radio.Control>
                              <Radio.Indicator />
                            </Radio.Control>
                            {option.label}
                          </span>
                        </Radio.Content>
                      </Radio>
                    ))}
                  </div>
                </RadioGroup>
              </Fragment>
            ))}

            {appearanceError ? (
              <Typography className="font-semibold text-danger" role="alert" type="body-sm">
                {appearanceError}
              </Typography>
            ) : null}
          </SettingsSection>

          <SettingsSection id="settings-reset-title" title="Reset appearance">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Typography color="muted" type="body-sm">
                Puts theme, spacing, menu style, and page layouts back to how they started.
              </Typography>
              <Modal state={resetDialog}>
                <Button ref={resetTriggerRef} variant="secondary">
                  Reset appearance
                </Button>
                <Modal.Backdrop>
                  <Modal.Container>
                    <Modal.Dialog>
                      <Modal.Header>
                        <Modal.Heading>Reset appearance?</Modal.Heading>
                      </Modal.Header>
                      <Modal.Body>
                        <Typography type="body">
                          Theme, spacing, menu style, and page layouts go back to how they started.
                          Your profile, password, and data stay the same.
                        </Typography>
                        {resetError ? (
                          <Typography
                            className="font-semibold text-danger"
                            role="alert"
                            type="body"
                          >
                            {resetError}
                          </Typography>
                        ) : null}
                      </Modal.Body>
                      <Modal.Footer>
                        <Button
                          isDisabled={resetBusy}
                          variant="secondary"
                          onPress={resetDialog.close}
                        >
                          Cancel
                        </Button>
                        <Button
                          isDisabled={resetBusy}
                          onPress={() => void handleResetPreferences()}
                        >
                          Yes, reset
                        </Button>
                      </Modal.Footer>
                    </Modal.Dialog>
                  </Modal.Container>
                </Modal.Backdrop>
              </Modal>
            </div>
          </SettingsSection>
        </Tabs.Panel>

        <Tabs.Panel className="grid gap-5 pt-5" id="security">
          <AppLockSettings />
          <EncryptionSettings />
        </Tabs.Panel>

        <Tabs.Panel className="grid gap-5 pt-5" id="data">
          <Typography color="muted" type="body-sm">
            Your vault is saved on this device only. Kivo never sends it anywhere.
          </Typography>
          <BackupSettings />
          <PortabilitySettings />
          <DangerZoneSettings />
        </Tabs.Panel>

        <Tabs.Panel className="grid gap-5 pt-5" id="about">
          <SettingsSection id="settings-about-title" title="About Kivo">
            {appName || appVersion ? (
              <dl className="grid max-w-md gap-2">
                {appName ? (
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted">App</dt>
                    <dd className="m-0 font-semibold">{appName}</dd>
                  </div>
                ) : null}
                {appVersion ? (
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted">Version</dt>
                    <dd className="m-0 font-semibold">{appVersion}</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <Typography color="muted" type="body">
                App details are not available here.
              </Typography>
            )}
          </SettingsSection>
        </Tabs.Panel>
      </Tabs>

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </section>
  )
}
