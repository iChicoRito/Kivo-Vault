import type { PointerEvent as ReactPointerEvent } from 'react'

/** Window events that tell the collection panel what a card drag is doing. */
export const ITEM_DRAG_START_EVENT = 'kivo:item-drag-start'
export const ITEM_DRAG_END_EVENT = 'kivo:item-drag-end'
export const ITEM_DRAG_OVER_EVENT = 'kivo:item-drag-over'
export const ITEM_DROPPED_EVENT = 'kivo:item-dropped'

/** Marks the collection rows that take a drop; the value is the collection id. */
export const ITEM_DRAG_TARGET_ATTRIBUTE = 'data-collection-drop'

/** The card copy that floats with the pointer, and the dimmed card left in the list. */
export const ITEM_DRAG_GHOST_CLASS = 'kivo-drag-ghost'
export const ITEM_DRAG_SOURCE_CLASS = 'kivo-drag-source'

/** Added to the floating card while it is over a collection that can take it. */
export const ITEM_DRAG_GHOST_OVER_CLASS = 'kivo-drag-ghost-over'

/** The copy is two layers: an outer one that follows the pointer and eases its
 * width, and an inner one that carries the lift and the slight shrink over a
 * collection, so neither animation drags the follow behind the pointer. */
const ITEM_DRAG_GHOST_SCALE_CLASS = 'kivo-drag-ghost-scale'

/** Every draggable card carries its item id here, so a multi-item drag can find
 * the other selected cards and fly them into the floating stack. */
export const ITEM_DRAG_ID_ATTRIBUTE = 'data-item-drag-id'

/** How long the other selected cards take to fly into the floating stack. */
const MERGE_MS = 280

/** How far the pointer travels before a press turns into a card drag. */
const DRAG_THRESHOLD_PX = 6

/** The floating card lingers this long to fade out where it was released. */
const GHOST_FADE_MS = 160

export type ItemDragOverDetail = { collectionId: string | null }
export type ItemDropDetail = { itemIds: string[]; collectionId: string }

type DragState = {
  itemIds: string[]
  source: HTMLElement
  ghost: HTMLElement | null
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  targetId: string | null
  started: boolean
  others: HTMLElement[]
}

let drag: DragState | null = null

function targetRow(event: PointerEvent) {
  const origin = event.target instanceof Element ? event.target : null

  return origin?.closest(`[${ITEM_DRAG_TARGET_ATTRIBUTE}]`) ?? null
}

function announce(over: ItemDragOverDetail) {
  window.dispatchEvent(new CustomEvent<ItemDragOverDetail>(ITEM_DRAG_OVER_EVENT, { detail: over }))
}

/** Over a collection the copy narrows to that row's width, so it reads as the
 * card shrinking down to fit the folder. The width is read from the row the
 * pointer is on, and the change animates from the CSS transition. */
function markOver(state: DragState, row: Element | null) {
  if (!state.ghost) return

  if (row) {
    state.ghost.style.setProperty(
      '--kivo-drag-over-width',
      `${Math.round(row.getBoundingClientRect().width)}px`,
    )
  }

  state.ghost.classList.toggle(ITEM_DRAG_GHOST_OVER_CLASS, Boolean(row))
}

/** The floating card carries its geometry in custom properties, so the copy can
 * animate its width without fighting inline values. */
function moveGhost(state: DragState, x: number, y: number) {
  if (!state.ghost) return

  state.ghost.style.setProperty('--kivo-drag-x', `${x - state.offsetX}px`)
  state.ghost.style.setProperty('--kivo-drag-y', `${y - state.offsetY}px`)
}

/** The other selected cards on screen fly from their place into the floating
 * card, so the selection reads as gathering under the pointer. */
function mergeOthers(state: DragState, grabbed: DOMRect) {
  for (const id of state.itemIds) {
    const card = document.querySelector<HTMLElement>(
      `[${ITEM_DRAG_ID_ATTRIBUTE}="${CSS.escape(id)}"]`,
    )
    if (!card || card === state.source) continue

    const rect = card.getBoundingClientRect()
    const flyer = document.createElement('div')

    flyer.classList.add('kivo-drag-flyer')
    flyer.setAttribute('aria-hidden', 'true')
    flyer.style.left = `${rect.left}px`
    flyer.style.top = `${rect.top}px`
    flyer.style.width = `${rect.width}px`
    flyer.append(card.cloneNode(true))
    document.body.append(flyer)

    card.classList.add(ITEM_DRAG_SOURCE_CLASS)
    state.others.push(card)

    // Next frame, so the start position paints before the flight begins.
    requestAnimationFrame(() => {
      const target = state.ghost?.getBoundingClientRect() ?? grabbed
      flyer.style.transform = `translate(${target.left - rect.left}px, ${target.top - rect.top}px) scale(0.9)`
      flyer.style.opacity = '0'
    })
    window.setTimeout(() => flyer.remove(), MERGE_MS)
  }
}

function startFloating(state: DragState, event: PointerEvent) {
  const rect = state.source.getBoundingClientRect()
  const ghost = document.createElement('div')
  const scaler = document.createElement('div')

  ghost.classList.add(ITEM_DRAG_GHOST_CLASS)
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.style.setProperty('--kivo-drag-width', `${rect.width}px`)

  scaler.classList.add(ITEM_DRAG_GHOST_SCALE_CLASS)
  scaler.append(state.source.cloneNode(true))

  // A multi-item drag floats as a stack: up to two tilted copies sit behind the
  // grabbed card, and a badge shows how many items ride along.
  if (state.itemIds.length > 1) {
    for (const tilt of [-4, 3].slice(0, state.itemIds.length - 1)) {
      const layer = document.createElement('div')
      layer.classList.add('kivo-drag-stack')
      layer.style.setProperty('--kivo-drag-tilt', `${tilt}deg`)
      layer.append(state.source.cloneNode(true))
      scaler.prepend(layer)
    }

    const count = document.createElement('span')
    count.classList.add('kivo-drag-count')
    count.textContent = String(state.itemIds.length)
    scaler.append(count)
  }

  ghost.append(scaler)
  document.body.append(ghost)

  state.ghost = ghost
  state.offsetX = state.startX - rect.left
  state.offsetY = state.startY - rect.top
  state.started = true

  // Scaling around the grabbed point keeps that point under the pointer.
  ghost.style.setProperty('--kivo-drag-origin', `${state.offsetX}px ${state.offsetY}px`)

  state.source.classList.add(ITEM_DRAG_SOURCE_CLASS)
  document.body.classList.add('kivo-dragging')

  moveGhost(state, event.clientX, event.clientY)
  mergeOthers(state, rect)
  window.dispatchEvent(new Event(ITEM_DRAG_START_EVENT))
}

/** A drag that ended on a card must not land as a click on it afterwards. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

function endDrag(state: DragState, dropped: boolean) {
  drag = null
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handleCancel)
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('blur', handleCancel)

  state.source.classList.remove(ITEM_DRAG_SOURCE_CLASS)
  for (const card of state.others) card.classList.remove(ITEM_DRAG_SOURCE_CLASS)
  document.body.classList.remove('kivo-dragging')

  if (!state.started) return

  state.ghost?.classList.add(`${ITEM_DRAG_GHOST_CLASS}-leaving`)
  window.setTimeout(() => state.ghost?.remove(), GHOST_FADE_MS)

  swallowNextClick()
  announce({ collectionId: null })

  if (dropped && state.targetId) {
    window.dispatchEvent(
      new CustomEvent<ItemDropDetail>(ITEM_DROPPED_EVENT, {
        detail: { itemIds: state.itemIds, collectionId: state.targetId },
      }),
    )
  }

  window.dispatchEvent(new Event(ITEM_DRAG_END_EVENT))
}

function handlePointerMove(event: PointerEvent) {
  const state = drag

  if (!state) return

  if (!state.started) {
    const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)

    if (distance < DRAG_THRESHOLD_PX) return

    startFloating(state, event)
  }

  moveGhost(state, event.clientX, event.clientY)

  const row = targetRow(event)
  const collectionId = row?.getAttribute(ITEM_DRAG_TARGET_ATTRIBUTE) ?? null

  if (collectionId !== state.targetId) {
    state.targetId = collectionId
    markOver(state, row)
    announce({ collectionId })
  }
}

function handlePointerUp(event: PointerEvent) {
  const state = drag

  if (!state) return

  if (state.started) {
    state.targetId = targetRow(event)?.getAttribute(ITEM_DRAG_TARGET_ATTRIBUTE) ?? null
  }

  endDrag(state, state.started)
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !drag) return

  endDrag(drag, false)
}

function handleCancel() {
  if (drag) endDrag(drag, false)
}

/**
 * Card drags run on pointer events rather than HTML5 drag and drop, so the card
 * itself can float with the pointer: a full-strength copy follows it while the
 * card in the list dims. Call it from the card's `pointerdown`. Pass every
 * selected id to drag them together.
 */
export function startItemDrag(event: ReactPointerEvent<HTMLElement>, itemIds: string[]) {
  if (drag || event.button !== 0) return

  drag = {
    itemIds,
    source: event.currentTarget,
    ghost: null,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: 0,
    offsetY: 0,
    targetId: null,
    started: false,
    others: [],
  }

  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handleCancel)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('blur', handleCancel)
}
