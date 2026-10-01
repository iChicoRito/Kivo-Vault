import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { lockVault as lockContentVault } from '../data/protection'
import { lockVault as lockPasswordVault } from '../data/passwords'
import { hasAppLock } from '../data/security'
import UnlockPage from '../features/security/UnlockPage'
import { usePreferences } from './preferences'

type LockContextValue = { locked: boolean; lock: () => Promise<void>; unlock: () => void }
const LockContext = createContext<LockContextValue | null>(null)

export function useLock() {
  return useContext(LockContext)
}

export function LockProvider({ children, initialLocked = false, autoLockMinutes }: {
  children: ReactNode
  initialLocked?: boolean
  autoLockMinutes?: number
}) {
  const [locked, setLocked] = useState(initialLocked)
  const { preferences } = usePreferences()
  const minutes = autoLockMinutes ?? preferences.autoLockMinutes

  const lock = useCallback(async () => {
    // Without an app lock there is no password to ask for, so Kivo stays open;
    // the keys are still cleared, which locks the password vault. If the check
    // fails, lock anyway rather than leave content showing.
    const appLocked = await hasAppLock().catch(() => true)
    if (appLocked) setLocked(true)
    await Promise.allSettled([lockContentVault(), lockPasswordVault()])
  }, [])

  useEffect(() => {
    if (locked || !minutes) return
    const idleMs = minutes * 60_000
    let timeout: ReturnType<typeof setTimeout>
    let lastActivity = Date.now()
    const reset = () => {
      lastActivity = Date.now()
      clearTimeout(timeout)
      timeout = setTimeout(() => void lock(), idleMs)
    }
    // Timers pause while the computer sleeps, so check the real idle time when
    // the window shows again. Only input counts as activity, not focus.
    const checkIdle = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastActivity >= idleMs) void lock()
    }
    const events = ['pointerdown', 'keydown', 'scroll']
    reset()
    for (const name of events) window.addEventListener(name, reset, true)
    document.addEventListener('visibilitychange', checkIdle)
    window.addEventListener('focus', checkIdle)
    return () => {
      clearTimeout(timeout)
      for (const name of events) window.removeEventListener(name, reset, true)
      document.removeEventListener('visibilitychange', checkIdle)
      window.removeEventListener('focus', checkIdle)
    }
  }, [locked, minutes, lock])

  return <LockContext.Provider value={{ locked, lock, unlock: () => setLocked(false) }}>
    {locked ? <main aria-label="Kivo application" className="min-h-screen bg-background text-foreground"><UnlockPage onUnlocked={() => setLocked(false)} /></main> : children}
  </LockContext.Provider>
}
