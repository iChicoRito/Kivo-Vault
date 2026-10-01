import { fireEvent, render, screen } from '@testing-library/react'

import Landing from '../../landing/Landing'
import { demoInvoke, resetDemoBackend } from '../../landing/demo/backend'
import type { ItemSummary, VaultItem } from '../data/items'
import type { VaultSummary } from '../data/dashboard'

describe('landing page', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'dark'
    localStorage.clear()
  })

  it('links every download button to the installer', () => {
    render(<Landing />)

    const links = screen.getAllByRole('link', { name: /download/i })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'downloads/Kivo_0.3.0_x64-setup.exe')
      expect(link).toHaveAttribute('download')
    }
  })

  it('switches between dark and light and remembers the choice', () => {
    render(<Landing />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('kivo.landing.theme')).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('embeds the real app demo with the current theme', () => {
    render(<Landing />)

    expect(screen.getByTitle('Kivo demo')).toHaveAttribute('src', 'demo.html?theme=dark')
  })
})

describe('demo backend', () => {
  beforeEach(async () => {
    await resetDemoBackend('light')
  })

  it('starts as a finished setup with seeded content', async () => {
    expect(await demoInvoke('load_boot_state')).toBe('ready')
    expect(await demoInvoke('load_preferences')).toMatchObject({ theme: 'light' })

    const summary = await demoInvoke<VaultSummary>('load_vault_summary')
    expect(summary).toMatchObject({ noteCount: 4, sourceCount: 3, fileCount: 3, collectionCount: 3 })
    expect(await demoInvoke<unknown[]>('list_credentials', { filter: null })).toHaveLength(4)
  })

  it('filters and orders items like the Rust backend', async () => {
    const notes = await demoInvoke<ItemSummary[]>('list_items', { filter: { kind: 'note' } })
    expect(notes.map((note) => note.title)[0]).toBe('Apartment move checklist')

    const byTitle = await demoInvoke<ItemSummary[]>('list_items', { filter: { sort: 'title' } })
    expect(byTitle[0].title).toBe('Apartment move checklist')

    const found = await demoInvoke<ItemSummary[]>('list_items', { filter: { query: 'garlic' } })
    expect(found.map((item) => item.title)).toEqual(["Mom's adobo"])
  })

  it('saves, trashes and restores items', async () => {
    const { item: created } = await demoInvoke<{ item: VaultItem }>('save_item', {
      input: { kind: 'note', title: 'Car insurance', content: '<p>Renew in May</p>' },
    })
    const all = await demoInvoke<ItemSummary[]>('list_items', { filter: null })
    expect(all[0].id).toBe(created.id)

    await demoInvoke('trash_items', { ids: [created.id] })
    expect(await demoInvoke<ItemSummary[]>('list_items', { filter: { trashed: true } })).toHaveLength(1)

    await demoInvoke('restore_items', { ids: [created.id] })
    const tags = await demoInvoke<string[]>('set_item_tags', { id: created.id, tags: ['car', 'car', ' '] })
    expect(tags).toEqual(['car'])
    expect(await demoInvoke<VaultItem>('load_item', { id: created.id })).toMatchObject({ tags: ['car'] })
  })

  it('points desktop-only actions at the download', async () => {
    await expect(demoInvoke('pick_file')).rejects.toThrow(/desktop app/)
  })
})
