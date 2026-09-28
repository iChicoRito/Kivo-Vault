import { Dropdown, Label, Typography } from '@heroui/react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { CheckmarkSquare02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useRef, useState, type ReactNode } from 'react'

export type ItemCardAction = {
  id: string
  label: string
  icon: IconSvgElement
  isDisabled?: boolean
  danger?: boolean
}

export type ItemCardProps = {
  title: string
  leading?: ReactNode
  chips?: ReactNode
  subtitle?: ReactNode
  /** Rows without actions render without the right-click menu. */
  actions?: ItemCardAction[]
  onOpen?: () => void
  isOpenDisabled?: boolean
  onAction?: (id: string) => void
  /** Adds a Select entry to the menu; while selecting, a click calls it instead of `onOpen`. */
  onSelect?: () => void
  isSelecting?: boolean
  isSelected?: boolean
}

const SELECT_ACTION = '__select'

export function ItemCard({
  title,
  leading,
  chips,
  subtitle,
  actions,
  onOpen,
  isOpenDisabled,
  onAction,
  onSelect,
  isSelecting = false,
  isSelected = false,
}: ItemCardProps) {
  const items = [
    ...(onSelect
      ? [{ id: SELECT_ACTION, label: isSelected ? 'Deselect' : 'Select', icon: CheckmarkSquare02Icon }]
      : []),
    ...(actions ?? []).filter((action) => action.danger !== true),
  ]
  const dangerItems = (actions ?? []).filter((action) => action.danger === true)
  const hasMenu = items.length > 0 || dangerItems.length > 0

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const menuAnchorRef = useRef<HTMLSpanElement>(null)

  return (
    <div
      className={`kivo-item-card relative rounded-3xl border bg-surface transition-[background-color,scale,border-color] duration-300 ease-out hover:z-10 hover:scale-[1.02] hover:bg-surface-hover ${isSelected ? 'border-accent/40' : 'border-default'}`}
      onContextMenu={(event) => {
        event.preventDefault()

        if (!hasMenu) return

        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpen(true)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

        event.preventDefault()

        if (!hasMenu) return

        setMenuPoint({ x: 16, y: 16 })
        setMenuOpen(true)
      }}
    >
      <button
        aria-label={title}
        aria-pressed={isSelecting ? isSelected : undefined}
        className="flex w-full items-center gap-3 rounded-3xl p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isOpenDisabled && !isSelecting}
        type="button"
        onClick={isSelecting && onSelect ? onSelect : onOpen}
      >
        {isSelecting ? <SelectMark isSelected={isSelected} /> : null}
        {leading}
        {/* The badge and the meta line sit close under the title: the row gap
            plus the two line boxes would otherwise leave a wide band. */}
        <span className="grid min-w-0 flex-1 gap-1">
          {chips ? (
            <span className="-mb-1.5 flex flex-wrap items-center gap-2">{chips}</span>
          ) : null}
          <Typography className="truncate font-semibold" type="body">
            {title}
          </Typography>
          {subtitle ? <span className="-mt-2.5 min-w-0">{subtitle}</span> : null}
        </span>
      </button>

      {hasMenu ? (
        <>
          {/* The popover anchors to this zero-size mark so the menu opens where
              the pointer was, rather than at a fixed corner of the card. */}
          <span
            ref={menuAnchorRef}
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
          <Dropdown
            isOpen={menuOpen}
            onOpenChange={(isOpen) => {
              if (!isOpen) setMenuOpen(false)
            }}
          >
            <Dropdown.Trigger aria-label={`Actions for ${title}`} className="sr-only" />
            <Dropdown.Popover triggerRef={menuAnchorRef}>
              <Dropdown.Menu
                autoFocus
                className="kivo-row-actions-menu"
                onAction={(key) => {
                  if (key === SELECT_ACTION) onSelect?.()
                  else onAction?.(String(key))
                }}
              >
                {items.map((action) => (
                  <Dropdown.Item
                    key={action.id}
                    id={action.id}
                    isDisabled={action.isDisabled}
                    textValue={action.label}
                  >
                    <HugeiconsIcon aria-hidden="true" icon={action.icon} size={16} />
                    <Label>{action.label}</Label>
                  </Dropdown.Item>
                ))}
                {dangerItems.length > 0 ? (
                  <Dropdown.Section
                    aria-label="Danger zone"
                    className="mt-1 border-t border-separator pt-1"
                  >
                    {dangerItems.map((action) => (
                      <Dropdown.Item
                        key={action.id}
                        id={action.id}
                        isDisabled={action.isDisabled}
                        textValue={action.label}
                        variant="danger"
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          className="text-danger"
                          icon={action.icon}
                          size={16}
                        />
                        <Label>{action.label}</Label>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                ) : null}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </>
      ) : null}
    </div>
  )
}

/** The checkbox look for a row in selection mode; the row button carries the state. */
export function SelectMark({ isSelected }: { isSelected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5 shrink-0 place-items-center rounded-md border transition-colors ${
        isSelected ? 'border-accent bg-accent text-accent-foreground' : 'border-default bg-default'
      }`}
    >
      {isSelected ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2.5} /> : null}
    </span>
  )
}
