import { Button, Modal } from '@heroui/react'
import { KeyboardIcon } from '@hugeicons/core-free-icons'
import { shortcuts } from '../../app/shortcuts'
import { DialogHeader } from '../../components/DialogHeader'

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose() }}><Modal.Backdrop><Modal.Container><Modal.Dialog>
    <DialogHeader icon={KeyboardIcon} title="Keyboard shortcuts" description="Keys for moving around Kivo faster." />
    <Modal.Body><dl className="grid gap-2">{shortcuts.map((shortcut) => <div key={shortcut.id} className="flex justify-between gap-3"><dt>{shortcut.label}</dt><dd className="font-mono">Ctrl/{'⌘'}+{shortcut.shift ? 'Shift+' : ''}{shortcut.key.toUpperCase()}</dd></div>)}</dl></Modal.Body>
    <Modal.Footer><Button onPress={onClose}>Close</Button></Modal.Footer>
  </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
}
