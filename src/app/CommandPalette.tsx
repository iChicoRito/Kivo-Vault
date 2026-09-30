import { useEffect, useState } from 'react'
import { Button, Kbd, Modal } from '@heroui/react'
import { CommandIcon } from '@hugeicons/core-free-icons'
import { useNavigate } from 'react-router-dom'
import { listItems, setItemsFavorite, trashItems, type ItemSummary } from '../data/items'
import { ItemDetailsDialog } from '../features/items/ItemDetailsDialog'
import { ConfirmDialog } from '../components/items/dialogs'
import { notifyError } from '../lib/feedback'
import { navigationGroups } from './navigation'
import { shortcuts } from './shortcuts'
import { DialogHeader } from '../components/DialogHeader'

type PaletteProps = { open: boolean; onClose: () => void; onQuickAdd: (action?: 'file' | 'source' | 'collection') => void; onShortcuts: () => void }

export function CommandPalette({ open, onClose, onQuickAdd, onShortcuts }: PaletteProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ItemSummary[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [selectedFavorite, setSelectedFavorite] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  useEffect(() => {
    if (!open) { setQuery(''); setItems([]); setActive(0); return }
    let current = true
    setLoading(true); setError(false)
    listItems(query.trim() ? { query: query.trim() } : undefined).then((rows) => { if (current) { setItems(rows); setLoading(false) } }).catch(() => { if (current) { setError(true); setLoading(false) } })
    return () => { current = false }
  }, [open, query])

  const actions = [
    { label: 'New Note', run: () => navigate('/notes/new') },
    { label: 'Add File', run: () => onQuickAdd('file') },
    { label: 'Save Link', run: () => onQuickAdd('source') },
    { label: 'Create Collection', run: () => onQuickAdd('collection') },
    { label: 'Quick Add', run: () => onQuickAdd() },
    { label: 'Open Settings', run: () => navigate('/settings') },
    { label: 'Open Storage Manager', run: () => navigate('/storage') },
    { label: 'Show Shortcuts', run: onShortcuts },
    ...(openId ? [
      { label: 'Toggle Favorite', run: () => { void setItemsFavorite([openId], !selectedFavorite).then(() => setSelectedFavorite(!selectedFavorite)).catch(() => notifyError('Could not change favorite.')) } },
      { label: 'Move to Trash', run: () => setTrashOpen(true) },
    ] : []),
  ]
  const pages = navigationGroups.flatMap((group) => group.links).map((link) => ({ label: `Go to ${link.label}`, run: () => navigate(link.to), group: 'Go to' }))
  const term = query.trim().toLowerCase()
  const matches = [
    ...[...actions.map((entry) => ({ ...entry, group: 'Actions' })), ...pages]
      .filter((entry) => entry.label.toLowerCase().includes(term)),
    ...items.map((item) => ({
      label: item.title,
      group: 'Items',
      run: () => { setOpenId(item.id); setSelectedFavorite(item.isFavorite) },
    })),
  ].slice(0, 30)
  function choose(index: number) { const result = matches[index]; if (!result) return; onClose(); result.run() }
  return <>
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose() }}><Modal.Backdrop><Modal.Container size="lg"><Modal.Dialog>
      <DialogHeader icon={CommandIcon} title="Command palette" description="Jump to a page, run a command or open an item." />
      <Modal.Body className="grid gap-3"><label className="sr-only" htmlFor="kivo-command-query">Command or item</label><input autoFocus id="kivo-command-query" className="w-full rounded-lg bg-default p-3 text-foreground focus-visible:outline-2 focus-visible:outline-focus" placeholder="Search commands, pages, items" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0) }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, matches.length - 1)) }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)) }
        if (event.key === 'Enter') { event.preventDefault(); choose(active) }
      }} />
      {loading ? <p role="status">Loading vault items...</p> : null}
      {error ? <p role="alert">Items could not load. Commands and pages remain available.</p> : null}
      {!loading && matches.length === 0 ? <p>No matching commands or items. Try another term.</p> : null}
      <ul className="max-h-[55vh] overflow-auto">{matches.map((entry, index) => {
        const hint = shortcuts.find((shortcut) => shortcut.label === entry.label || `Go to ${shortcut.label}` === entry.label)
        return <li key={`${entry.label}-${index}`}>{(index === 0 || matches[index - 1].group !== entry.group) ? <h3 className="px-3 py-2 text-xs font-semibold text-muted">{entry.group}</h3> : null}<button type="button" aria-current={index === active ? 'true' : undefined} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left hover:bg-default focus-visible:outline-2 focus-visible:outline-focus aria-current:bg-default" onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>{entry.label}{hint ? <Kbd aria-hidden="true"><Kbd.Abbr keyValue="ctrl" /><Kbd.Content>{hint.shift ? 'Shift+' : ''}{hint.key.toUpperCase()}</Kbd.Content></Kbd> : null}</button></li>
      })}</ul>
      </Modal.Body><Modal.Footer><Button variant="secondary" onPress={onClose}>Close</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    <ItemDetailsDialog key={`${openId}-${selectedFavorite}`} itemId={openId} onClose={() => setOpenId(null)} onChanged={() => undefined} />
    <ConfirmDialog open={trashOpen} title="Move selected item to Trash?" description="You can restore it from Trash." confirmLabel="Move to Trash" tone="danger" onCancel={() => setTrashOpen(false)} onConfirm={() => { if (!openId) return; void trashItems([openId]).then(() => { setTrashOpen(false); setOpenId(null) }).catch(() => notifyError('Could not move item to Trash.')) }} />
  </>
}
