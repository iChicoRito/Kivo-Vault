import { invoke, isTauriRuntime } from '../data/runtime'

/**
 * Copies a password. In the desktop app the Rust side writes it, keeps it out
 * of Windows clipboard history, and clears it after 30 seconds if it is still
 * there. The browser demo has no backend for that, so it copies plainly.
 */
export async function copySecret(text: string): Promise<void> {
  if (isTauriRuntime()) return invoke<void>('copy_secret', { text })

  return copyText(text)
}

/**
 * Copies text to the clipboard. Uses the async clipboard API when the webview
 * allows it, then falls back to a hidden textarea so copy still works when
 * clipboard permission is denied.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the execCommand fallback below.
    }
  }

  if (!copyWithHiddenTextarea(text)) {
    throw new Error('Could not copy to the clipboard')
  }
}

function copyWithHiddenTextarea(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'

  document.body.appendChild(textarea)

  try {
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}
