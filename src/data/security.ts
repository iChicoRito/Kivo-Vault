import { notifySecurityChanged } from './events'
import { invoke } from './runtime'

export async function hashPassword(password: string): Promise<string> {
  try {
    return await invoke<string>('hash_password', { password })
  } catch {
    throw new Error('Could not protect the password.')
  }
}

export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  try {
    return await invoke<boolean>('verify_password', { password, verifier })
  } catch {
    throw new Error('Could not check the password.')
  }
}

export async function readAppLockVerifier(): Promise<string | null> {
  try {
    return await invoke<string | null>('load_password_verifier')
  } catch {
    throw new Error('Could not read app lock.')
  }
}

export async function hasAppLock(): Promise<boolean> {
  // The backend is the only authority on lock state: it reports a lock only when
  // the stored value parses as an Argon2 verifier, matching boot classification.
  // A raw or corrupted value on its own never counts as a lock.
  try {
    return await invoke<boolean>('has_password_verifier')
  } catch {
    throw new Error('Could not read app lock.')
  }
}

export async function setAppLock(password: string): Promise<void> {
  // Hash first. Only the encoded verifier is ever handed to storage.
  const verifier = await hashPassword(password)

  try {
    await invoke<void>('set_password_verifier', { verifier })
  } catch {
    throw new Error('Could not turn on app lock.')
  }
  notifySecurityChanged()
}

export async function removeAppLock(): Promise<void> {
  try {
    await invoke<void>('remove_password_verifier')
  } catch {
    throw new Error('Could not turn off app lock.')
  }
  notifySecurityChanged()
}
