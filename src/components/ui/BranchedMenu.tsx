import {
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

import './BranchedMenu.css'

const PAD = 6
const MARK = 16

type MenuIcon = ReactNode | IconSvgElement

export type BranchedMenuChild = {
  value: string
  label: ReactNode
  icon?: MenuIcon
  disabled?: boolean
  /** Lets the caller start a drag from a child row. */
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}

export type BranchedMenuItem = {
  label: ReactNode
  value?: string
  icon?: MenuIcon
  ariaLabel?: string
  data?: Record<string, string>
  className?: string
  children?: BranchedMenuChild[]
}

export type BranchedMenuProps = {
  items: BranchedMenuItem[]
  defaultOpen?: number | number[]
  defaultActive?: string
  onSelect?: (value: string, item: BranchedMenuItem | BranchedMenuChild) => void
  onToggle?: (index: number, open: boolean) => void
  /** Right click on a head or a child row. The row that was clicked is passed
   * back so the caller can open its own menu without guessing from the event. */
  onContextMenu?: (
    event: ReactMouseEvent<HTMLButtonElement>,
    node: BranchedMenuItem | BranchedMenuChild,
  ) => void
  color?: string
  accentColor?: string
  lineColor?: string
  width?: number
  rowHeight?: number
  indent?: number
  trunk?: number
  radius?: number
  lineWidth?: number
  fontSize?: number
  drawDuration?: number
  foldDuration?: number
  className?: string
}

const renderIcon = (icon: MenuIcon) =>
  isValidElement(icon) ? icon : <HugeiconsIcon icon={icon as IconSvgElement} size={16} strokeWidth={1.8} />

const toSet = (open: number | number[]) => new Set(Array.isArray(open) ? open : open >= 0 ? [open] : [])

export function BranchedMenu({
  items = [],
  defaultOpen = 0,
  defaultActive,
  onSelect,
  onToggle,
  onContextMenu,
  color = '#f5f5f5',
  accentColor = '#f5f5f5',
  lineColor = '#3f3f46',
  width = 240,
  rowHeight = 36,
  indent = 40,
  trunk = 14,
  radius = 10,
  lineWidth = 1.5,
  fontSize = 14,
  drawDuration = 400,
  foldDuration = 300,
  className = '',
}: BranchedMenuProps) {
  const [open, setOpen] = useState(() => toSet(defaultOpen))
  const [active, setActive] = useState(() => {
    // An empty string means "nothing is active yet", which the panel needs
    // because its items arrive after the first render.
    if (defaultActive !== undefined) return defaultActive
    const first = items.find((it, i) => it.children && toSet(defaultOpen).has(i))
    return first?.children?.[0]?.value ?? ''
  })
  const navRef = useRef<HTMLElement>(null)
  const heads = useRef<Array<HTMLButtonElement | null>>([])
  const markerRef = useRef<HTMLSpanElement>(null)
  const latest = useRef<{
    onSelect?: BranchedMenuProps['onSelect']
    onToggle?: BranchedMenuProps['onToggle']
  }>({})
  latest.current = { onSelect, onToggle }

  const activeSection = items.findIndex(it => it.children?.some(kid => kid.value === active))
  const markerShown = activeSection >= 0 && open.has(activeSection)
  useLayoutEffect(() => {
    const place = (glide: boolean) => {
      const m = markerRef.current
      const el = heads.current[activeSection]
      if (!m) return
      const on = markerShown && el
      if (!glide) m.style.transition = 'none'
      if (on) m.style.top = `${el.offsetTop + (el.offsetHeight - MARK) / 2}px`
      m.toggleAttribute('data-on', Boolean(on))
      if (!glide) {
        void m.offsetHeight
        m.style.transition = ''
      }
    }
    place(true)
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      place(false)
    })
    if (navRef.current) ro.observe(navRef.current)
    return () => ro.disconnect()
  }, [activeSection, markerShown, items, fontSize, rowHeight])

  const select = (value: string, item: BranchedMenuItem | BranchedMenuChild) => {
    setActive(value)
    latest.current.onSelect?.(value, item)
  }
  const toggle = (i: number) => {
    const isOpen = !open.has(i)
    setOpen(prev => {
      const next = new Set(prev)
      if (isOpen) next.add(i)
      else next.delete(i)
      return next
    })
    // The caller is told after the state change, so its own updates never run
    // inside this component's render.
    latest.current.onToggle?.(i, isOpen)
  }

  const r = Math.min(radius, rowHeight / 2 - 2)
  const endX = indent - 8
  const rowY = (k: number) => PAD + k * rowHeight + rowHeight / 2
  const branch = (k: number) => `M ${trunk} ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`
  const reach = (k: number) =>
    `M ${trunk} 0 V ${rowY(k) - r} A ${r} ${r} 0 0 0 ${trunk + r} ${rowY(k)} H ${endX}`
  const length = (k: number) => rowY(k) - r + (Math.PI * r) / 2 + (endX - trunk - r)

  return (
    <nav
      ref={navRef}
      className={`branched-menu${className ? ` ${className}` : ''}`}
      style={{
        '--bm-w': `${width}px`,
        '--bm-ink': color,
        '--bm-accent': accentColor,
        '--bm-line': lineColor,
        '--bm-font': `${fontSize}px`,
        '--bm-row': `${rowHeight}px`,
        '--bm-indent': `${indent}px`,
        '--bm-line-w': lineWidth,
        '--bm-draw': `${drawDuration}ms`,
        '--bm-fold': `${foldDuration}ms`,
      } as React.CSSProperties}
    >
      <span ref={markerRef} className="branched-menu__marker" aria-hidden="true" />
      {items.map((item, i) => {
        const kids = item.children
        const isOpen = kids ? open.has(i) : false
        const leafValue = item.value ?? ''
        const leafActive = !kids && leafValue === active
        const bodyH = kids ? PAD * 2 + kids.length * rowHeight : 0
        return (
          <div
            key={item.value ?? `section-${i}`}
            {...item.data}
            className={`branched-menu__section${item.className ? ` ${item.className}` : ''}`}
            data-open={isOpen ? '' : undefined}
          >
            <button
              ref={el => {
                heads.current[i] = el
              }}
              type="button"
              className="branched-menu__head"
              aria-expanded={kids ? isOpen : undefined}
              aria-label={item.ariaLabel}
              aria-current={leafActive ? 'true' : undefined}
              data-active={leafActive ? '' : undefined}
              data-bm-row={leafValue}
              onClick={() => (kids ? toggle(i) : select(leafValue, item))}
              onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
            >
              {item.icon ? (
                <span className="branched-menu__icon" aria-hidden="true">
                  {renderIcon(item.icon)}
                </span>
              ) : null}
              <span className="branched-menu__label">{item.label}</span>
            </button>
            {kids ? (
              // A folded branch stays in the DOM for the fold animation, so it
              // leaves the tab order and the accessibility tree while closed.
              <div className="branched-menu__body" inert={!isOpen}>
                <div className="branched-menu__fold">
                  <div className="branched-menu__tree" style={{ height: bodyH }}>
                    <svg className="branched-menu__lines" width={indent} height={bodyH} aria-hidden="true">
                      {kids.length === 0 ? null : (
                        <path className="branched-menu__base" d={`M ${trunk} 0 V ${rowY(kids.length - 1) - r}`} />
                      )}
                      {kids.map((kid, k) => (
                        <path key={kid.value} className="branched-menu__base" d={branch(k)} />
                      ))}
                      {kids.map((kid, k) => (
                        <path
                          key={kid.value}
                          className="branched-menu__reach"
                          d={reach(k)}
                          style={{
                            strokeDasharray: length(k),
                            strokeDashoffset: kid.value === active ? 0 : length(k),
                          }}
                        />
                      ))}
                    </svg>
                    {kids.map(kid => (
                      <button
                        key={kid.value}
                        type="button"
                        className="branched-menu__item"
                        aria-current={kid.value === active ? 'true' : undefined}
                        data-active={kid.value === active ? '' : undefined}
                        disabled={kid.disabled}
                        tabIndex={isOpen ? 0 : -1}
                        data-bm-row={kid.value}
                        onClick={() => select(kid.value, kid)}
                        onPointerDown={kid.onPointerDown}
                        onContextMenu={onContextMenu ? (event) => onContextMenu(event, kid) : undefined}
                      >
                        {kid.icon ? (
                          <span className="branched-menu__icon" aria-hidden="true">
                            {renderIcon(kid.icon)}
                          </span>
                        ) : null}
                        <span className="branched-menu__label">{kid.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}

export default BranchedMenu
