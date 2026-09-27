import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import { setBrowserBackend } from '@/data/runtime'
import './demo.css'
import { demoInvoke, resetDemoBackend } from './backend'

// The landing page passes its theme in the URL, then sends theme changes and page requests as messages.
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return
  const data = event.data as { kivoTheme?: unknown; kivoNavigate?: unknown } | null
  if (data?.kivoTheme === 'light' || data?.kivoTheme === 'dark') document.documentElement.dataset.theme = data.kivoTheme
  // The landing page's feature cards open a page here. React Router follows popstate.
  if (typeof data?.kivoNavigate === 'string' && data.kivoNavigate.startsWith('/')) {
    history.pushState(null, '', data.kivoNavigate)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
})

// The app routes by path, and this page lives at demo.html, so start it on the dashboard.
history.replaceState(null, '', '/dashboard')

setBrowserBackend(demoInvoke)

const root = document.getElementById('root')

if (!root) {
  throw new Error('Kivo demo root element was not found')
}

void resetDemoBackend(theme).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
