import { invoke } from './runtime'

let initialization: Promise<void> | undefined

export function initializeDatabase(): Promise<void> {
  initialization ??= Promise.resolve(invoke<void>('initialize_database')).catch((error) => {
    initialization = undefined
    throw error
  })

  return initialization
}

/** Forgets the finished start-up so the next call checks the newly opened vault. */
export function resetDatabaseInitialization() {
  initialization = undefined
}
