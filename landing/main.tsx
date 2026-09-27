import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import Landing from './Landing'
import './landing.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Landing root element was not found')
}

createRoot(root).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
)
