import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import GuidedTour from '../features/tour/GuidedTour'

// A welcome step, then per page: its icon in the navigation, then the page itself.
const PAGE_COUNT = 12
const STEP_COUNT = 1 + (PAGE_COUNT - 1) * 2

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function renderTour(onDone = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <GuidedTour onDone={onDone} />
      <Location />
    </MemoryRouter>,
  )
  return { onDone }
}

function pressNext(times: number) {
  for (let step = 0; step < times; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  }
}

describe('GuidedTour', () => {
  it('opens with a welcome step, then shows each page in the navigation before opening it', () => {
    renderTour()
    const dialog = screen.getByRole('dialog')

    expect(dialog).toHaveTextContent('Welcome to Kivo')
    expect(dialog).toHaveTextContent(`1 of ${PAGE_COUNT}`)
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()

    pressNext(1)
    expect(dialog).toHaveTextContent('Go to Dashboard')
    expect(dialog).toHaveTextContent(`2 of ${PAGE_COUNT}`)

    pressNext(1)
    expect(dialog).toHaveTextContent('Highlighted: Your overview')
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard')

    // The navigation step stays on the current page; the page step opens the next one.
    pressNext(1)
    expect(dialog).toHaveTextContent('Go to All Items')
    expect(dialog).toHaveTextContent('Highlighted: All Items in the navigation')
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard')

    pressNext(1)
    expect(dialog).toHaveTextContent('Highlighted: Search, filters, and Quick Add')
    expect(screen.getByTestId('location')).toHaveTextContent('/items')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(dialog).toHaveTextContent('Go to All Items')
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard')

    pressNext(STEP_COUNT - 4)
    expect(dialog).toHaveTextContent(`${PAGE_COUNT} of ${PAGE_COUNT}`)
    expect(screen.getByTestId('location')).toHaveTextContent('/settings')
    expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument()
  })

  it('returns to the Dashboard on Finish', () => {
    const { onDone } = renderTour()
    pressNext(STEP_COUNT - 1)
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard')
  })

  it('makes the app inert while it runs', () => {
    const shell = document.createElement('div')
    shell.id = 'kivo-shell'
    document.body.append(shell)

    const { unmount } = render(
      <MemoryRouter>
        <GuidedTour onDone={vi.fn()} />
      </MemoryRouter>,
    )
    expect(shell).toHaveAttribute('inert')

    unmount()
    expect(shell).not.toHaveAttribute('inert')
    shell.remove()
  })

  it('ends on Skip tour and on Escape', () => {
    const { onDone } = renderTour()
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onDone).toHaveBeenCalledTimes(2)
  })
})
