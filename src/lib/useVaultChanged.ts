import { useEffect, useRef } from 'react'

import { SECURITY_CHANGED_EVENT, VAULT_CHANGED_EVENT } from '../data/events'

/**
 * Runs `onChange` whenever the vault reports a write. The latest callback is
 * held in a ref so the window listener is registered once per mount.
 */
export function useVaultChanged(onChange: () => void) {
  useWindowEvent(VAULT_CHANGED_EVENT, onChange)
}

/** Runs `onChange` after the Master Password, app lock or encryption changes. */
export function useSecurityChanged(onChange: () => void) {
  useWindowEvent(SECURITY_CHANGED_EVENT, onChange)
}

function useWindowEvent(name: string, onChange: () => void) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const handleChange = () => onChangeRef.current()
    window.addEventListener(name, handleChange)
    return () => window.removeEventListener(name, handleChange)
  }, [name])
}
