import {
  Airplane01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  EyeIcon,
  File01Icon,
  FolderOpenIcon,
  Home01Icon,
  Image01Icon,
  LockIcon,
  Pdf01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useCurrentFrame } from 'remotion'

import { C, Cursor, Icon, Scene, Sfx, Slam, Sparkles, alpha, b, fadeForExit, glide, lerp, pop, snap } from '../kit'

// The demo vault's collections (landing/demo/backend.ts). Important documents starts with the warranty.
const FOLDERS = [
  { name: 'Moving house', icon: Home01Icon, tint: C.warning, color: C.warningForeground, x: -60 },
  { name: 'Lisbon, October', icon: Airplane01Icon, tint: C.success, color: C.successForeground, x: 520 },
  { name: 'Important documents', icon: File01Icon, tint: C.accent, color: C.accentForeground, x: 1100 },
]
const FOLDER = { y: 90, width: 400, height: 260 }
// Important documents: where cards drop, and its top-right corner where the lock stamps on.
const DOCS = { x: FOLDERS[2].x + FOLDER.width / 2, y: FOLDER.y + FOLDER.height / 2 }
const LOCK = { x: FOLDERS[2].x + FOLDER.width - 30, y: 104 }

const LEASE = { x: 330, y: 520 }
const PASSPORT = { x: 620, y: 560 }
const MENU = { x: 660, y: 570, width: 400 }
const SUB = { x: MENU.x + MENU.width + 10, y: 630, width: 350 }
const ITEM = 64

const GRAB = b(2.5)
const DROP = b(3)
const RIGHT_CLICK = b(4)
const MOVE_TO = b(4.5)
const PICK = b(5)
const LANDED = PICK + 10
const LOCKED = b(5.75)

export function Collections({ beats }: { beats: number }) {
  const frame = useCurrentFrame()
  const count = frame >= LANDED ? 3 : frame >= DROP ? 2 : 1
  const closing = snap(frame, PICK)
  const fade = fadeForExit(frame, beats)

  // The lease card: flies in, is grabbed, dragged onto Important documents, and drops in.
  const leaseIn = snap(frame, b(2))
  const drag = glide(frame, GRAB, DROP - GRAB)
  const leaseDrop = glide(frame, DROP, 8)
  // The passport card: flies in, gets the right-click menu, then flies into the folder.
  const passportIn = snap(frame, b(3.5))
  const passportFly = glide(frame, PICK, LANDED - PICK)

  return (
    <Scene beats={beats} bg={C.success} dots={alpha(C.successForeground, 14)} exit={{ x: LOCK.x, y: LOCK.y, r: 50 }}>
      <Slam at={0} color={C.successForeground} size={150} x={-100} y={800}>
        STAY
      </Slam>
      <Slam at={b(0.5)} block={C.background} color={C.foreground} size={130} tilt={2} x={-100} y={962}>
        ORGANIZED.
      </Slam>

      {FOLDERS.map((folder, i) => {
        const at = b(1 + i / 4)
        const p = pop(frame, at)
        const docs = i === 2
        const squish = docs ? [DROP, LANDED].reduce((sum, drop) => sum + bounce(frame - drop), 0) : 0
        return frame >= at ? (
          <div
            key={folder.name}
            style={{
              position: 'absolute',
              left: folder.x,
              top: FOLDER.y,
              width: FOLDER.width,
              height: FOLDER.height,
              transform: `rotate(${lerp(i % 2 ? 24 : -24, 0, p)}deg) scale(${p * (1 + squish)}, ${p * (1 - squish)})`,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: -30,
                width: 160,
                height: 60,
                borderRadius: '20px 20px 0 0',
                background: C.default,
                border: `4px solid ${C.background}`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                padding: 26,
                borderRadius: 28,
                background: C.surface,
                border: `4px solid ${C.background}`,
                boxShadow: `10px 12px 0 ${C.background}`,
                color: C.foreground,
              }}
            >
              <div
                style={{
                  width: 70,
                  height: 70,
                  borderRadius: 20,
                  display: 'grid',
                  placeItems: 'center',
                  background: folder.tint,
                  color: folder.color,
                }}
              >
                <Icon icon={folder.icon} size={36} stroke={2} />
              </div>
              <div style={{ fontSize: 31, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15, marginTop: 18 }}>
                {folder.name}
              </div>
              <div style={{ fontSize: 22, color: C.muted, marginTop: 6 }}>{docs ? count : 2} items</div>
            </div>
          </div>
        ) : null
      })}
      {FOLDERS.map((folder, i) => (
        <Sfx key={folder.name} at={b(1 + i / 4)} name="pop" />
      ))}

      {frame >= b(2) && leaseDrop < 1 ? (
        <FileCard
          icon={Pdf01Icon}
          lifted={frame >= GRAB}
          scale={lerp(1, 0.2, leaseDrop)}
          size="1.2 MB"
          title="Lease agreement 2026.pdf"
          x={lerp(lerp(-400, LEASE.x, leaseIn), DOCS.x, drag)}
          y={lerp(LEASE.y, DOCS.y, drag)}
        />
      ) : null}
      <Sfx at={b(2)} name="pop" />
      <Sparkles at={DROP} colors={[C.warning, C.foreground, C.accent]} x={DOCS.x} y={DOCS.y} />
      <PlusOne at={DROP} />

      {frame >= b(3.5) && passportFly < 1 ? (
        <FileCard
          icon={Image01Icon}
          lifted={frame >= PICK}
          scale={lerp(1, 0.2, passportFly)}
          size="840 KB"
          title="Passport scan.jpg"
          x={lerp(lerp(1900, PASSPORT.x, passportIn), DOCS.x, passportFly)}
          y={lerp(PASSPORT.y, DOCS.y, passportFly)}
        />
      ) : null}
      <Sfx at={b(3.5)} name="pop" />

      {frame >= RIGHT_CLICK && closing < 0.99 ? (
        <Menu
          items={[
            { label: 'Open', icon: EyeIcon },
            { label: 'Move to collection', icon: FolderOpenIcon, more: true, on: frame >= MOVE_TO - 2 },
            { label: 'Move to trash', icon: Delete02Icon, danger: true },
          ]}
          scale={pop(frame, RIGHT_CLICK) * (1 - closing)}
          width={MENU.width}
          x={MENU.x}
          y={MENU.y}
        />
      ) : null}
      {frame >= MOVE_TO && closing < 0.99 ? (
        <Menu
          items={FOLDERS.map((folder, i) => ({ label: folder.name, icon: folder.icon, on: i === 2 && frame >= PICK - 3 }))}
          scale={pop(frame, MOVE_TO) * (1 - closing)}
          width={SUB.width}
          x={SUB.x}
          y={SUB.y}
        />
      ) : null}
      <Sfx at={RIGHT_CLICK} name="pop" />
      <Sfx at={MOVE_TO} name="pop" />
      <Sparkles at={LANDED} colors={[C.warning, C.foreground, C.accent]} x={DOCS.x} y={DOCS.y} />
      <PlusOne at={LANDED} />

      <Sfx at={LOCKED} name="slam" />
      {frame >= LOCKED ? (
        <div
          style={{
            position: 'absolute',
            left: LOCK.x - 58,
            top: LOCK.y - 58,
            width: 116,
            height: 116,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            background: C.danger,
            border: `5px solid ${C.background}`,
            boxShadow: `6px 8px 0 ${C.background}`,
            color: C.dangerForeground,
            transform: `rotate(${lerp(-40, 10, snap(frame, LOCKED))}deg) scale(${lerp(2.6, 1, snap(frame, LOCKED))})`,
          }}
        >
          <div style={{ display: 'flex', opacity: fade }}>
            <Icon icon={LockIcon} size={54} stroke={2.2} />
          </div>
        </div>
      ) : null}

      <Cursor
        clicks={[GRAB, RIGHT_CLICK, MOVE_TO, PICK]}
        fade={fade}
        path={[
          [b(1.85), 180, 1150],
          [GRAB - 2, LEASE.x + 60, LEASE.y + 10],
          [GRAB, LEASE.x + 60, LEASE.y + 10],
          [DROP, DOCS.x + 60, DOCS.y + 10],
          [b(3.5), DOCS.x + 60, DOCS.y + 10],
          [RIGHT_CLICK - 2, MENU.x, MENU.y],
          [RIGHT_CLICK, MENU.x, MENU.y],
          [MOVE_TO - 2, MENU.x + 240, MENU.y + 12 + ITEM * 1.5],
          [MOVE_TO, MENU.x + 240, MENU.y + 12 + ITEM * 1.5],
          [PICK - 2, SUB.x + 190, SUB.y + 12 + ITEM * 2.5],
          [PICK + 4, SUB.x + 190, SUB.y + 12 + ITEM * 2.5],
          [b(6.2), 1520, 1180],
        ]}
      />
    </Scene>
  )
}

/** A squash that rings out after a drop at `age` 0. */
function bounce(age: number) {
  return age >= 0 && age < 18 ? 0.1 * Math.sin((age / 18) * Math.PI * 3) * Math.exp(-age / 6) : 0
}

function PlusOne({ at }: { at: number }) {
  const frame = useCurrentFrame()
  const age = frame - at
  if (age < 0 || age > 26) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: DOCS.x + 110,
        top: DOCS.y - 40 - age * 2.5,
        padding: '6px 18px',
        borderRadius: 999,
        background: C.warning,
        border: `4px solid ${C.background}`,
        color: C.warningForeground,
        fontSize: 34,
        fontWeight: 900,
        transform: `translate(-50%, -50%) scale(${pop(frame, at)})`,
        opacity: age > 20 ? 1 - (age - 20) / 6 : 1,
      }}
    >
      +1
    </div>
  )
}

function FileCard({
  icon,
  title,
  size,
  x,
  y,
  scale,
  lifted,
}: {
  icon: IconSvgElement
  title: string
  size: string
  x: number
  y: number
  scale: number
  lifted: boolean
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 220,
        top: y - 55,
        width: 440,
        height: 110,
        padding: '0 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        borderRadius: 24,
        background: C.surface,
        border: `4px solid ${C.background}`,
        boxShadow: `${lifted ? 14 : 8}px ${lifted ? 18 : 10}px 0 ${C.background}`,
        color: C.foreground,
        transform: `rotate(${lifted ? 4 : 0}deg) scale(${scale * (lifted ? 1.05 : 1)})`,
      }}
    >
      <div style={{ width: 64, height: 64, borderRadius: 18, background: C.default, display: 'grid', placeItems: 'center' }}>
        <Icon icon={icon} size={34} />
      </div>
      <div>
        <div style={{ fontSize: 25, fontWeight: 700, whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 20, color: C.muted, marginTop: 4 }}>{size}</div>
      </div>
    </div>
  )
}

type MenuItem = { label: string; icon: IconSvgElement; more?: boolean; danger?: boolean; on?: boolean }

/** A right-click menu growing from its top-left corner. */
function Menu({ items, x, y, width, scale }: { items: MenuItem[]; x: number; y: number; width: number; scale: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        padding: 8,
        borderRadius: 22,
        background: C.surface,
        border: `4px solid ${C.background}`,
        boxShadow: `10px 12px 0 ${C.background}`,
        color: C.foreground,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            height: ITEM,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            borderRadius: 14,
            background: item.on ? C.default : 'transparent',
            color: item.danger ? C.danger : C.foreground,
            fontSize: 24,
            fontWeight: 600,
          }}
        >
          <Icon color={item.danger ? C.danger : C.muted} icon={item.icon} size={26} />
          {item.label}
          {item.more ? (
            <span style={{ marginLeft: 'auto', display: 'flex', color: C.muted }}>
              <Icon icon={ArrowRight01Icon} size={24} />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
