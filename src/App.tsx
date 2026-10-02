import { useCallback, useEffect, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './app/router'
import { PreferencesProvider } from './app/preferences'
import { LockProvider } from './app/lock'
import { VaultProvider } from './app/vault'
import StatusScreen from './app/StatusScreen'
import { FeedbackToastRegion } from './components/ui/FeedbackToast'
import { initializeDatabase, resetDatabaseInitialization } from './data/database'
import { switchVault } from './data/vaults'
import { VaultSwitchContext } from './app/vaults'
import { loadBootState, type BootState } from './data/setup'
import OnboardingPage from './features/onboarding/OnboardingPage'

type AppStartupState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; route: BootState }

export function App() {
  const [attempt, setAttempt] = useState(0)
  const [startup, setStartup] = useState<AppStartupState>({ status: 'loading' })
  // Onboarding hands the app over once; unlocking is owned by LockProvider
  // afterwards, so nothing here has to track it.
  const [enteredApp, setEnteredApp] = useState(false)

  useEffect(() => {
    let active = true
    setStartup({ status: 'loading' })
    setEnteredApp(false)

    async function openApplication() {
      try {
        await initializeDatabase()
        const route = await loadBootState()

        if (active) {
          setStartup({ status: 'ready', route })
        }
      } catch (error) {
        if (active) {
          setStartup({ status: 'error', error })
        }
      }
    }

    void openApplication()
    return () => {
      active = false
    }
  }, [attempt])

  // Opening another vault restarts the boot flow: the loading screen unmounts
  // every page, then the target vault boots as onboarding, locked or ready.
  const switchTo = useCallback(async (id: string) => {
    await switchVault(id)
    resetDatabaseInitialization()
    setAttempt((value) => value + 1)
  }, [])

  if (startup.status === 'loading') {
    return <StatusScreen status="loading" />
  }

  if (startup.status === 'error') {
    return <StatusScreen status="error" error={startup.error} onRetry={() => setAttempt((value) => value + 1)} />
  }

  const route: BootState = enteredApp ? 'ready' : startup.route

  return (
    <VaultSwitchContext.Provider value={switchTo}>
      <BootRoute route={route} startTour={enteredApp} onEnterApp={() => setEnteredApp(true)} />
    </VaultSwitchContext.Provider>
  )
}

function BootRoute({
  route,
  startTour,
  onEnterApp,
}: {
  route: BootState
  startTour: boolean
  onEnterApp: () => void
}) {
  if (route === 'onboarding') {
    return (
      <main
        aria-label="Kivo application"
        className="h-screen overflow-hidden bg-background text-foreground"
      >
        <OnboardingPage onCompleted={onEnterApp} />
      </main>
    )
  }

  // The lock state lives in the provider, so a locked boot and a lock later in
  // the session take the same path: routes never mount while locked.
  // Only a vault created in this session gets the guided tour.
  return <ReadyApplication initialLocked={route === 'locked'} startTour={startTour} />
}

function ReadyApplication({ initialLocked, startTour }: { initialLocked: boolean; startTour: boolean }) {
  return (
    <PreferencesProvider>
      <LockProvider initialLocked={initialLocked}>
        <BrowserRouter>
          <VaultProvider>
            <AppRoutes startTour={startTour} />
          </VaultProvider>
        </BrowserRouter>
      </LockProvider>
      <FeedbackToastRegion />
    </PreferencesProvider>
  )
}

export default App
