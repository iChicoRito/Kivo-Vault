import '@testing-library/jest-dom/vitest'

import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const itemsMock = vi.hoisted(() => ({
  importFile: vi.fn(),
  listItems: vi.fn(),
  loadItem: vi.fn(),
  moveItemsToCollection: vi.fn(),
  saveItem: vi.fn(),
  trashItems: vi.fn(),
}))

const filesMock = vi.hoisted(() => ({
  openItemFile: vi.fn(),
  pickFiles: vi.fn(),
  revealItemFile: vi.fn(),
}))

const collectionsMock = vi.hoisted(() => ({
  listCollections: vi.fn(),
}))

vi.mock('../data/items', () => itemsMock)
vi.mock('../data/files', () => filesMock)
vi.mock('../data/collections', () => collectionsMock)
vi.mock('../data/tags', () => ({ listTags: vi.fn().mockResolvedValue([]) }))

import { FilesPage } from '../features/files/FilesPage'

function findLoadingStatus(copy: string) {
  const status = screen
    .getAllByRole('status')
    .find((element) => element.textContent?.includes(copy))

  if (!status) throw new Error(`Loading status for "${copy}" was not found.`)

  return status
}

describe('FilesPage loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    itemsMock.listItems.mockReturnValue(new Promise(() => undefined))
    collectionsMock.listCollections.mockResolvedValue([])
  })

  it('shows accessible file icon and row skeletons while files load', () => {
    render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/files" element={<FilesPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const status = findLoadingStatus('Loading your files')
    const loadingList = status.querySelector('ul')

    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Loading your files')
    expect(loadingList).not.toBeNull()
    expect(loadingList).toHaveClass('grid', 'gap-2')
    expect(loadingList?.children).toHaveLength(4)
    expect(loadingList?.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    expect(loadingList?.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBeInTheDocument()
  })

  it('keeps the Files heading mounted when loading finishes', async () => {
    let resolveItems: (items: never[]) => void = () => undefined
    itemsMock.listItems.mockReturnValue(
      new Promise((resolve) => {
        resolveItems = resolve
      }),
    )

    render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/files" element={<FilesPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const heading = screen.getByRole('heading', { level: 1, name: 'Files' })

    await act(async () => {
      resolveItems([])
    })

    expect(await screen.findByText('No files yet.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBe(heading)
  })

  it('shows the load error and retries', async () => {
    itemsMock.listItems
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce([])

    render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/files" element={<FilesPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Your files could not load')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('No files yet.')).toBeInTheDocument()
    expect(itemsMock.listItems).toHaveBeenCalledTimes(2)
  })

  it('keeps the collection sidebar visible while files load', async () => {
    collectionsMock.listCollections.mockResolvedValue([
      {
        id: 'col-1',
        name: 'Work',
        icon: null,
        protection: 'none',
        sortOrder: 0,
        createdAt: '2026-09-10T11:20:00.000Z',
        itemCount: 1,
      },
    ])

    render(
      <MemoryRouter initialEntries={['/files']}>
        <Routes>
          <Route path="/files" element={<FilesPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('complementary', { name: 'Collection folders' }),
    ).toBeInTheDocument()
    expect(findLoadingStatus('Loading your files').querySelector('ul')).toHaveClass('grid', 'gap-2')
  })
})
