export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'kivo.landing.theme'

/** The theme `index.html` already put on `<html>` before paint. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme

  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Private windows can block storage; the theme still applies for this visit.
  }
}
