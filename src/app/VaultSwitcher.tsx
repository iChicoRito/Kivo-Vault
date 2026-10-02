import { useEffect, useState, type Key } from 'react'

import { Button, Dropdown, Label } from '@heroui/react'
import { Add01Icon, Delete02Icon, SafeIcon, UnfoldMoreIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { listVaults, type VaultList } from '../data/vaults'
import DeleteVaultDialog from '../features/vaults/DeleteVaultDialog'
import NewVaultDialog from '../features/vaults/NewVaultDialog'
import { notifyError } from '../lib/feedback'
import { cn } from '../lib/utils'
import { useVaultSwitch } from './vaults'

type VaultSwitcherProps = {
  /** Hide the switcher when there is nothing to switch to. */
  hideWhenSingle?: boolean
  /** Offer New vault and Delete. Off on the lock screen, which only switches. */
  canManage?: boolean
  className?: string
  /** Classes for the name and chevron, e.g. to hide them on the narrow sidebar rail. */
  labelClassName?: string
  placement?: 'top start' | 'bottom end' | 'bottom'
}

// Lists vault names only; the contents of other vaults stay locked.
export default function VaultSwitcher({
  hideWhenSingle = false,
  canManage = true,
  className,
  labelClassName,
  placement = 'bottom end',
}: VaultSwitcherProps) {
  const switchTo = useVaultSwitch()
  const [list, setList] = useState<VaultList | null>(null)
  const [switching, setSwitching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let active = true
    // Wrapped so a missing backend (landing demo, tests) just hides the switcher.
    void Promise.resolve()
      .then(listVaults)
      .then((loaded) => {
        if (active && loaded) setList(loaded)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  if (!list || !switchTo || (hideWhenSingle && list.vaults.length < 2)) return null

  const current = list.vaults.find((vault) => vault.id === list.activeId)
  const currentName = current?.name ?? 'Vault'

  function handleAction(key: Key) {
    const id = String(key)
    if (id === 'new-vault') {
      setCreating(true)
      return
    }
    if (id === 'delete-vault') {
      setDeleting(true)
      return
    }
    if (id === list?.activeId || !switchTo) return
    setSwitching(true)
    switchTo(id).catch((reason: unknown) => {
      setSwitching(false)
      notifyError(reason instanceof Error ? reason.message : 'Kivo could not open that vault.')
    })
  }

  return (
    <>
      <Dropdown>
        <Button
          aria-label={`Vault: ${currentName}. Switch vault`}
          className={cn('justify-start gap-2', className)}
          isDisabled={switching}
          variant="ghost"
        >
          <HugeiconsIcon aria-hidden="true" icon={SafeIcon} size={18} />
          <span className={cn('min-w-0 flex-1 truncate text-left text-sm font-medium', labelClassName)}>
            {currentName}
          </span>
          <HugeiconsIcon aria-hidden="true" className={cn('text-muted', labelClassName)} icon={UnfoldMoreIcon} size={14} />
        </Button>
        <Dropdown.Popover className="min-w-56" placement={placement}>
          <Dropdown.Menu aria-label="Vaults" onAction={handleAction}>
            <Dropdown.Section aria-label="Your vaults" selectedKeys={[list.activeId]} selectionMode="single">
              {list.vaults.map((vault) => (
                <Dropdown.Item key={vault.id} id={vault.id} textValue={vault.name}>
                  <Label>{vault.name}</Label>
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
            {canManage ? (
              <Dropdown.Section aria-label="Vault actions" className="mt-1 border-t border-separator pt-1">
                <Dropdown.Item id="new-vault" textValue="New vault">
                  <HugeiconsIcon aria-hidden="true" icon={Add01Icon} size={16} />
                  <Label>New vault</Label>
                </Dropdown.Item>
                {/* The last vault cannot be deleted, so the entry stays off with one vault. */}
                <Dropdown.Item
                  id="delete-vault"
                  isDisabled={list.vaults.length < 2}
                  textValue="Delete this vault"
                  variant="danger"
                >
                  <HugeiconsIcon aria-hidden="true" className="text-danger" icon={Delete02Icon} size={16} />
                  <Label>{list.vaults.length < 2 ? 'Delete this vault (last vault)' : 'Delete this vault…'}</Label>
                </Dropdown.Item>
              </Dropdown.Section>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {canManage ? <NewVaultDialog open={creating} onClose={() => setCreating(false)} /> : null}
      {canManage ? (
        <DeleteVaultDialog vault={deleting ? (current ?? null) : null} onClose={() => setDeleting(false)} />
      ) : null}
    </>
  )
}
