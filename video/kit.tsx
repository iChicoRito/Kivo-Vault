import type { CSSProperties, ReactNode } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { loadFont } from '@remotion/google-fonts/Inter'
import '@heroui/styles/themes/default/variables.css'
import {
  AbsoluteFill,
  Easing,
  Html5Audio,
  Sequence,
  interpolate,
  random,
  spring,
  staticFile,
  useCurrentFrame,
} from 'remotion'

import { navigationGroups } from '../src/app/navigation'
import KivoMark from '../src/components/ui/KivoMark'

export const FPS = 30
/** Every cue in the video sits on this tempo's grid; `video/sounds.mjs` plays the same tempo. */
export const BPM = 110
export const BEAT = (FPS * 60) / BPM
export const WIDTH = 1920
export const HEIGHT = 1080
/**
 * Scenes are laid out on a 1440 × 1080 stage centered in the 16:9 frame. Stage x runs from
 * -STAGE_X to STAGE + STAGE_X, so a scene can still reach the frame's left and right edges.
 */
export const STAGE = 1440
export const STAGE_X = (WIDTH - STAGE) / 2
/** Frames each scene spends zooming into the next one. */
export const EXIT = 14

/** Frames for a number of beats. */
export const b = (beats: number) => Math.round(beats * BEAT)
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t
export const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/**
 * The app's component colors: HeroUI theme tokens from the same stylesheet the app uses. The
 * video's root sets `data-theme="dark"`, so they resolve to the app's dark theme. Text on a
 * colored background uses that color's own `-foreground` token.
 */
export const C = {
  accent: 'var(--accent)',
  accentForeground: 'var(--accent-foreground)',
  success: 'var(--success)',
  successForeground: 'var(--success-foreground)',
  warning: 'var(--warning)',
  warningForeground: 'var(--warning-foreground)',
  danger: 'var(--danger)',
  dangerForeground: 'var(--danger-foreground)',
  background: 'var(--background)',
  foreground: 'var(--foreground)',
  surface: 'var(--surface)',
  default: 'var(--default)',
  muted: 'var(--muted)',
  border: 'var(--border)',
  separator: 'var(--separator)',
  black: 'var(--black)',
}

/** A color at `percent` opacity. */
export const alpha = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`

export const { fontFamily } = loadFont('normal', {
  weights: ['500', '600', '700', '800', '900'],
  subsets: ['latin'],
})

/** 0 → 1 from frame `at`, overshooting a little before it lands. */
export const pop = (frame: number, at: number) =>
  spring({ frame, fps: FPS, delay: at, config: { damping: 12, stiffness: 120, mass: 0.8 } })

/** 0 → 1 from frame `at`, with almost no overshoot. */
export const snap = (frame: number, at: number) =>
  spring({ frame, fps: FPS, delay: at, config: { damping: 18, stiffness: 170, mass: 0.7 } })

/** 0 → 1 over `frames` from `at`: quick start, soft landing. For moves between two points. */
export const glide = (frame: number, at: number, frames: number) =>
  interpolate(frame, [at, at + frames], [0, 1], { ...CLAMP, easing: Easing.bezier(0.3, 0, 0.1, 1) })

/** A decaying bump right after each beat, for things that pulse with the music. */
export const pulse = (frame: number) => Math.exp(-(frame % BEAT) / 4)

type Sound = 'slam' | 'pop' | 'click' | 'whoosh' | 'sparkle' | 'typing' | 'impact'

// Mix levels. Every file is written at the same peak by `video/sounds.mjs`.
const LEVEL: Record<Sound, number> = {
  slam: 0.85,
  pop: 0.55,
  click: 0.75,
  whoosh: 0.75,
  sparkle: 0.45,
  typing: 0.5,
  impact: 1,
}

/** Plays a generated sound from frame `at`, for at most `frames` frames. */
export function Sfx({ name, at, frames = 2 * FPS }: { name: Sound; at: number; frames?: number }) {
  return (
    <Sequence from={at} durationInFrames={frames} layout="none" name={name}>
      <Html5Audio src={staticFile(`sfx/${name}.wav`)} volume={LEVEL[name]} />
    </Sequence>
  )
}

export function Icon({ icon, size, color, stroke = 1.8 }: { icon: IconSvgElement; size: number; color?: string; stroke?: number }) {
  return <HugeiconsIcon color={color} icon={icon} size={size} strokeWidth={stroke} />
}

/** 1 → 0 as a scene's exit starts. Hides the zoom target's icon or label, so only its color fills the frame. */
export const fadeForExit = (frame: number, beats: number) =>
  interpolate(frame, [b(beats) - EXIT, b(beats) - EXIT + 5], [1, 0], CLAMP)

type Exit = { x: number; y: number; r: number }

/**
 * A feature's stage: a flat color with drifting dots, with its content on the centered STAGE.
 * The content settles in from 1.3×, and over the last EXIT frames it zooms into `exit`: a spot
 * (in stage coordinates) inside an element filled with the next scene's color, with `r` of that
 * color around it. On the last frame that color fills the frame.
 */
export function Scene({
  beats,
  bg,
  dots = alpha(C.foreground, 16),
  exit,
  children,
}: {
  beats: number
  bg: string
  dots?: string
  exit?: Exit
  children: ReactNode
}) {
  const frame = useCurrentFrame()
  const end = b(beats)
  const t = exit ? interpolate(frame, [end - EXIT, end - 1], [0, 1], CLAMP) : 0
  // The spot in frame coordinates, and how far the zoom must go for the color to cover the
  // frame corner farthest from it.
  const spot = exit ? { x: STAGE_X + exit.x, y: exit.y } : null
  const reach = exit && spot ? (1.1 * Math.hypot(Math.max(spot.x, WIDTH - spot.x), Math.max(spot.y, HEIGHT - spot.y))) / exit.r : 1
  const zoom = Math.pow(reach, Math.pow(t, 1.5))

  return (
    <AbsoluteFill style={{ background: bg, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${dots} 2.5px, transparent 3px)`,
          backgroundSize: '44px 44px',
          backgroundPosition: `${frame * 0.8}px ${frame * 0.4}px`,
        }}
      />
      <AbsoluteFill style={{ filter: t > 0 ? `blur(${Math.sin(t * Math.PI) * 4}px)` : undefined }}>
        <AbsoluteFill style={{ transform: `scale(${lerp(1.3, 1, snap(frame, 0))})` }}>
          <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: spot ? `${spot.x}px ${spot.y}px` : undefined }}>
            <div style={{ position: 'absolute', left: STAGE_X, top: 0, width: STAGE, height: HEIGHT }}>{children}</div>
          </AbsoluteFill>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

/**
 * A word that slams in at `at`: from 1.8× down to size with a tilt, then a short shake.
 * (x, y) is its left-middle point, or its center with `center`. `until` cuts it; `out` flies it off.
 */
export function Slam({
  at,
  children,
  x,
  y,
  size = 150,
  color = C.foreground,
  block,
  tilt = -3,
  center = false,
  until,
  out,
}: {
  at: number
  children: ReactNode
  x: number
  y: number
  size?: number
  color?: string
  block?: string
  tilt?: number
  center?: boolean
  until?: number
  out?: number
}) {
  const frame = useCurrentFrame()
  const shown = frame >= at && (until === undefined || frame < until)
  const p = snap(frame, at)
  const k = frame - at - 4
  const shake = k >= 0 ? Math.sin(k * 1.8) * 6 * Math.exp(-k / 4) : 0
  const gone = out === undefined ? 0 : snap(frame, out)

  return (
    <>
      <Sfx at={at} name="slam" />
      {shown && gone < 0.99 ? (
        <div
          style={{
            position: 'absolute',
            left: x,
            top: y,
            transform: `translate(${center ? '-50%' : '0'}, -50%) translate(${shake}px, ${shake * 0.4 - gone * 520}px) rotate(${lerp(tilt - 8, tilt, p)}deg) scale(${lerp(1.8, 1, p) * (1 - gone * 0.6)})`,
            transformOrigin: center ? '50% 50%' : '0% 50%',
            opacity: 1 - gone,
            fontSize: size,
            fontWeight: 900,
            lineHeight: 0.92,
            letterSpacing: '-0.045em',
            whiteSpace: 'nowrap',
            color,
            background: block,
            padding: block ? '0.04em 0.16em 0.1em' : undefined,
            borderRadius: block ? size * 0.14 : undefined,
            textShadow: block ? undefined : `0 7px 0 ${alpha(C.background, 20)}`,
          }}
        >
          {children}
        </div>
      ) : null}
    </>
  )
}

/** A pill that pops in with a spin at `at`, centered on (x, y): dark outline, hard shadow, gentle bob. */
export function Sticker({
  at,
  x,
  y,
  children,
  bg = C.foreground,
  color = C.background,
  rotate = -6,
  size = 40,
  round = false,
  silent = false,
}: {
  at: number
  x: number
  y: number
  children: ReactNode
  bg?: string
  color?: string
  rotate?: number
  size?: number
  round?: boolean
  silent?: boolean
}) {
  const frame = useCurrentFrame()
  const p = pop(frame, at)

  return (
    <>
      {silent ? null : <Sfx at={at} name="pop" />}
      {frame >= at ? (
        <div
          style={{
            position: 'absolute',
            left: x,
            top: y,
            transform: `translate(-50%, -50%) translateY(${Math.sin((frame - at) / 9) * 5}px) rotate(${lerp(rotate - 40, rotate, p)}deg) scale(${p})`,
            display: 'flex',
            alignItems: 'center',
            gap: '0.3em',
            padding: round ? '0.45em' : '0.3em 0.7em 0.34em',
            borderRadius: round ? '32%' : 999,
            border: `4px solid ${C.background}`,
            boxShadow: `6px 7px 0 ${C.background}`,
            background: bg,
            color,
            fontSize: size,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          {children}
        </div>
      ) : null}
    </>
  )
}

type Key = [frame: number, x: number, y: number]

/**
 * The mouse pointer. Its tip glides through `path` keyframes; it squishes and ripples on each click.
 * `fade` hides it, for example while its scene zooms into what it just clicked.
 */
export function Cursor({ path, clicks = [], fade = 1 }: { path: Key[]; clicks?: number[]; fade?: number }) {
  const frame = useCurrentFrame()
  let [, x, y] = path[0]
  for (let i = 1; i < path.length; i++) {
    const [from, x0, y0] = path[i - 1]
    const [to, x1, y1] = path[i]
    if (frame >= from) {
      const t = glide(frame, from, to - from)
      x = lerp(x0, x1, t)
      y = lerp(y0, y1, t)
    }
  }
  const ages = clicks.map((at) => frame - at).filter((age) => age >= 0)
  const age = ages.length ? Math.min(...ages) : Infinity
  const press = age <= 8 ? 1 - 0.25 * Math.sin((age / 8) * Math.PI) : 1

  return (
    <>
      {clicks.map((at) => (
        <Sfx key={at} at={at} name="click" />
      ))}
      {age <= 16 ? (
        <div
          style={{
            position: 'absolute',
            left: x,
            top: y,
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: `5px solid ${C.foreground}`,
            transform: `translate(-50%, -50%) scale(${lerp(0.6, 5, age / 16)})`,
            opacity: (1 - age / 16) * fade,
          }}
        />
      ) : null}
      {frame >= path[0][0] ? (
        <svg
          height={60}
          style={{
            position: 'absolute',
            left: x - 4.6,
            top: y - 4.6,
            transform: `scale(${press})`,
            transformOrigin: '4.6px 4.6px',
            opacity: fade,
            filter: `drop-shadow(0 8px 12px ${alpha(C.black, 35)})`,
            overflow: 'visible',
          }}
          viewBox="0 0 22 26"
          width={51}
        >
          <path
            d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.6 15.2 L17 15.2 Z"
            fill={C.foreground}
            stroke={C.background}
            strokeLinejoin="round"
            strokeWidth={1.6}
          />
        </svg>
      ) : null}
    </>
  )
}

/** A four-point star. */
export function Star({ x, y, size, color, rotate = 0 }: { x: number; y: number; size: number; color: string; rotate?: number }) {
  return (
    <svg
      height={size}
      style={{ position: 'absolute', left: x - size / 2, top: y - size / 2, transform: `rotate(${rotate}deg)` }}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0 Z" fill={color} />
    </svg>
  )
}

/** A burst of stars flying out of (x, y) from frame `at`. */
export function Sparkles({
  at,
  x,
  y,
  count = 8,
  radius = 130,
  colors = [C.warning, C.foreground, C.success],
}: {
  at: number
  x: number
  y: number
  count?: number
  radius?: number
  colors?: string[]
}) {
  const frame = useCurrentFrame()
  const age = frame - at
  const seed = (i: number, kind: string) => random(`${kind}-${at}-${x}-${y}-${i}`)

  return (
    <>
      <Sfx at={at} name="sparkle" />
      {age >= 0 && age <= 22
        ? Array.from({ length: count }, (_, i) => {
            const angle = (i / count) * Math.PI * 2 + (seed(i, 'a') - 0.5) * 0.7
            const distance = radius * (0.55 + 0.45 * seed(i, 'd')) * Easing.out(Easing.cubic)(Math.min(1, age / 17))
            const size = 38 * Math.sin((age / 22) * Math.PI) * (0.6 + 0.6 * seed(i, 's'))
            return (
              <Star
                key={i}
                color={colors[i % colors.length]}
                rotate={age * 9}
                size={size}
                x={x + Math.cos(angle) * distance}
                y={y + Math.sin(angle) * distance}
              />
            )
          })
        : null}
    </>
  )
}

const DOODLES = {
  arrow: { box: [200, 110], paths: ['M8 88 C 40 30, 110 8, 176 44', 'M150 22 L 180 46 L 146 62'] },
  squiggle: { box: [180, 30], paths: ['M4 18 Q 19 2, 34 18 T 64 18 T 94 18 T 124 18 T 154 18 T 176 14'] },
  loop: { box: [220, 120], paths: ['M34 76 C 8 28, 196 6, 210 54 C 220 98, 64 120, 26 84 C 10 66, 44 30, 128 22'] },
}

/**
 * A hand-drawn mark that draws itself in from `at` at (x, y), its top-left corner. It "boils"
 * afterwards: a tiny new tilt every 5 frames, like a flipbook.
 */
export function Doodle({
  kind,
  at,
  x,
  y,
  width,
  rotate = 0,
  color = C.background,
  stroke = 9,
}: {
  kind: keyof typeof DOODLES
  at: number
  x: number
  y: number
  width: number
  rotate?: number
  color?: string
  stroke?: number
}) {
  const frame = useCurrentFrame()
  if (frame < at) return null
  const { box, paths } = DOODLES[kind]
  const boil = (random(`${kind}-${at}-${Math.floor(frame / 5)}`) - 0.5) * 3

  return (
    <svg
      height={(width * box[1]) / box[0]}
      style={{ position: 'absolute', left: x, top: y, overflow: 'visible', transform: `rotate(${rotate + boil}deg)` }}
      viewBox={`0 0 ${box[0]} ${box[1]}`}
      width={width}
    >
      {paths.map((d, i) => (
        <path
          key={d}
          d={d}
          fill="none"
          pathLength={1}
          stroke={color}
          strokeDasharray={1}
          strokeDashoffset={1 - interpolate(frame, [at + i * 6, at + i * 6 + 10], [0, 1], CLAMP)}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={stroke}
        />
      ))}
    </svg>
  )
}

/** The Kivo app icon: the mark (at `glyph` opacity) on an accent tile. */
export function AppIcon({ size, glyph = 1 }: { size: number; glyph?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size * 0.23,
        background: C.accent,
        color: C.accentForeground,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div style={{ display: 'flex', width: size * 0.49, opacity: glyph }}>
        <KivoMark />
      </div>
    </div>
  )
}

export const TITLE_BAR = 64

/** The Kivo desktop window: app icon, page title and window buttons over the page content. */
export function AppWindow({
  title,
  width,
  height,
  children,
  style,
  glyph,
}: {
  title: string
  width: number
  height: number
  children?: ReactNode
  style?: CSSProperties
  glyph?: number
}) {
  return (
    <div
      style={{
        position: 'absolute',
        width,
        height,
        borderRadius: 28,
        background: C.background,
        border: `2px solid ${C.border}`,
        boxShadow: `0 50px 100px -30px ${alpha(C.black, 55)}, 0 14px 30px -12px ${alpha(C.black, 40)}`,
        overflow: 'hidden',
        color: C.foreground,
        ...style,
      }}
    >
      <div
        style={{
          height: TITLE_BAR,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 22px',
          borderBottom: `2px solid ${C.separator}`,
          fontSize: 24,
        }}
      >
        <AppIcon glyph={glyph} size={34} />
        <span style={{ fontWeight: 700 }}>Kivo</span>
        <span style={{ fontWeight: 500, color: C.muted }}>{title}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 30, alignItems: 'center', color: C.muted }}>
          <div style={{ width: 18, height: 2.5, background: 'currentColor' }} />
          <div style={{ width: 16, height: 16, border: '2.5px solid currentColor', borderRadius: 3 }} />
          <div style={{ fontSize: 30, lineHeight: 0, fontWeight: 400 }}>×</div>
        </div>
      </div>
      <div style={{ position: 'relative', height: height - TITLE_BAR }}>{children}</div>
    </div>
  )
}

export const DOCK_LINKS = navigationGroups.flatMap((group) => group.links)
export const DOCK_ICON = 56
export const DOCK_GAP = 12
export const DOCK_WIDTH = DOCK_LINKS.length * (DOCK_ICON + DOCK_GAP) + DOCK_GAP

/**
 * The app's dock, centered on (x, y). Icons pop in one per frame from `at`; `active` is filled with
 * the accent and its glyph shows at `glyph` opacity.
 */
export function Dock({ at, x, y, active, glyph = 1 }: { at: number; x: number; y: number; active?: string; glyph?: number }) {
  const frame = useCurrentFrame()
  if (frame < at) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: x - DOCK_WIDTH / 2,
        top: y - (DOCK_ICON + 2 * DOCK_GAP) / 2,
        display: 'flex',
        gap: DOCK_GAP,
        padding: DOCK_GAP,
        borderRadius: 26,
        background: alpha(C.default, 90),
        boxShadow: `inset 0 0 0 2px ${C.border}`,
        transform: `translateY(${lerp(120, 0, snap(frame, at))}px)`,
      }}
    >
      {DOCK_LINKS.map((link, i) => {
        const on = link.label === active
        return (
          <div
            key={link.to}
            style={{
              width: DOCK_ICON,
              height: DOCK_ICON,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: on ? C.accent : 'transparent',
              color: on ? C.accentForeground : C.foreground,
              transform: `scale(${pop(frame, at + i)})`,
            }}
          >
            <div style={{ display: 'flex', opacity: on ? glyph : 1 }}>
              <Icon icon={link.icon} size={30} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Center of the dock icon for `label`, for a dock centered on (x, y). */
export function dockIcon(label: string, x: number, y: number) {
  const i = DOCK_LINKS.findIndex((link) => link.label === label)
  return { x: x - DOCK_WIDTH / 2 + DOCK_GAP + i * (DOCK_ICON + DOCK_GAP) + DOCK_ICON / 2, y }
}
