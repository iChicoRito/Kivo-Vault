import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it } from 'vitest'
import { FilePreviewDialog } from '../features/preview/FilePreviewDialog'
import { StorageManagerPage } from '../features/storage/StorageManagerPage'
import { VersionHistoryDialog } from '../features/notes/VersionHistoryDialog'
import { ShortcutsDialog } from '../features/shortcuts/ShortcutsDialog'
import { ItemDetailsDialog } from '../features/items/ItemDetailsDialog'
import { getTauriInvoke } from './setup'

beforeEach(() => getTauriInvoke().mockReset())

it('renders read-only text preview metadata and external actions', async () => {
  getTauriInvoke().mockResolvedValue({ preview: 'text', mime: 'text/plain', text: 'local content', payloadBase64: null, byteSize: 13, originalName: 'readme.txt', importedAt: '2026-09-24T00:00:00Z', truncated: false })
  render(<FilePreviewDialog itemId="file" onClose={() => undefined} />)
  expect(await screen.findByText('local content')).toBeInTheDocument()
  expect(screen.getByText('readme.txt')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Open externally' })).toBeInTheDocument()
})

it('shows unsupported preview fallback', async () => {
  getTauriInvoke().mockResolvedValue({ preview: 'unsupported', mime: null, text: null, payloadBase64: null, byteSize: 26, originalName: 'archive.zip', importedAt: '2026-09-24', truncated: false })
  render(<FilePreviewDialog itemId="file" onClose={() => undefined} />)
  expect(await screen.findByText('This file type cannot be previewed here. Open it externally.')).toBeInTheDocument()
})

it('shows storage sizes and an empty file list', async () => {
  getTauriInvoke().mockResolvedValue({ totalBytes: 1024, databaseBytes: 1024, fileBytes: 0, fileCount: 0, groups: [], largest: [] })
  render(<MemoryRouter><StorageManagerPage /></MemoryRouter>)
  expect(await screen.findByText('No managed files yet. Add a file to see it here.')).toBeInTheDocument()
  expect(screen.getAllByText('1 KB')).toHaveLength(3)
})

it('lists the largest files with usage by type and asks before trashing one', async () => {
  getTauriInvoke().mockResolvedValue({
    totalBytes: 3072,
    databaseBytes: 1024,
    fileBytes: 2048,
    fileCount: 1,
    groups: [{ label: 'PDFs', count: 1, bytes: 2048 }],
    largest: [{ itemId: 'f1', title: 'Lease', originalName: 'lease.pdf', byteSize: 2048, importedAt: '2026-09-24T00:00:00Z' }],
  })
  render(<MemoryRouter><StorageManagerPage /></MemoryRouter>)
  expect(await screen.findByText('Lease')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'PDFs 2 KB, Database 1 KB' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Move Lease to Trash' }))
  expect(await screen.findByText('Move this file to Trash?')).toBeInTheDocument()
})

it('shows versions and shortcut reference', async () => {
  getTauriInvoke().mockResolvedValue([{ id: 'v1', itemId: 'n1', title: 'Earlier', content: 'Old body', createdAt: '2026-09-24T00:00:00Z' }])
  render(<><VersionHistoryDialog itemId="n1" onClose={() => undefined} onRestore={() => undefined} /><ShortcutsDialog open onClose={() => undefined} /></>)
  expect(await screen.findByText('Old body')).toBeInTheDocument()
  expect(screen.getByText('Command palette')).toBeInTheDocument()
})

it('toggles favorite on the open item with Ctrl+D', async () => {
  const item = { id: 'n1', kind: 'note', title: 'Selected', description: '', content: '', url: null, collectionId: null, isFavorite: false, isPinned: false, tags: [], file: null, fileMissing: false, createdAt: '2026-09-24', updatedAt: '2026-09-24' }
  getTauriInvoke().mockImplementation(async (command: string, args: { input?: typeof item }) => command === 'load_item' ? item : command === 'save_item' ? { status: 'saved', item: { ...item, ...args.input } } : [])
  render(<ItemDetailsDialog itemId="n1" onClose={() => undefined} onChanged={() => undefined} />)
  expect(await screen.findByDisplayValue('Selected')).toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
  await waitFor(() => expect(getTauriInvoke()).toHaveBeenCalledWith('save_item', { input: expect.objectContaining({ id: 'n1', isFavorite: true }) }))
})

it('shows no-text PDF indexing status in file details', async () => {
  const file = { id: 'pdf', kind: 'file', title: 'Scan', description: '', content: null, url: null, collectionId: null, isFavorite: false, isPinned: false, tags: [], file: { originalName: 'scan.pdf', byteSize: 12, importedAt: '2026-09-24' }, fileMissing: false, createdAt: '2026-09-24', updatedAt: '2026-09-24' }
  getTauriInvoke().mockImplementation(async (command: string) => command === 'load_item' ? file : command === 'list_index_state' ? [{ itemId: 'pdf', needsIndex: false, indexedAt: null, status: 'no_text' }] : [])
  render(<ItemDetailsDialog itemId="pdf" onClose={() => undefined} onChanged={() => undefined} />)
  expect(await screen.findByText('No searchable text in this PDF')).toBeInTheDocument()
})
