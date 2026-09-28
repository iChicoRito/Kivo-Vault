import {
  ArrowRight01Icon,
  Layers01Icon,
  NoteEditIcon,
  Search01Icon,
  SquareLockPasswordIcon,
} from '@hugeicons/core-free-icons'
import { useCurrentFrame } from 'remotion'

import KivoMark from '../../src/components/ui/KivoMark'
import { C, Cursor, Doodle, Icon, Scene, Sfx, Slam, Sparkles, Star, Sticker, alpha, b, lerp, pop, pulse, snap } from '../kit'

// The four features, floating around the end card.
const STICKERS = [
  { icon: NoteEditIcon, x: 70, y: 250, bg: C.warning, color: C.warningForeground, rotate: -10 },
  { icon: Search01Icon, x: 1370, y: 240, bg: C.success, color: C.successForeground, rotate: 8 },
  { icon: Layers01Icon, x: 60, y: 800, bg: C.foreground, color: C.background, rotate: 7 },
  { icon: SquareLockPasswordIcon, x: 1380, y: 810, bg: C.danger, color: C.dangerForeground, rotate: -8 },
]
const STARS = [
  { x: 560, y: 160, size: 44 },
  { x: 905, y: 300, size: 34 },
  { x: 585, y: 355, size: 26 },
]

const MARK = { x: 720, y: 250, height: 230 }
const BUTTON = { x: 720, y: 890 }
const BUTTON_AT = b(3.5)
const CLICK = b(4.5)

export function Outro({ beats }: { beats: number }) {
  const frame = useCurrentFrame()
  const mark = pop(frame, 0)
  const ring = Math.min(1, frame / 20)
  const button = pop(frame, BUTTON_AT)
  const pressed = frame >= CLICK && frame < CLICK + 8 ? 1 : 0
  const caption = snap(frame, b(5))

  return (
    <Scene beats={beats} bg={C.accent} dots={alpha(C.accentForeground, 16)}>
      <Sfx at={0} name="impact" />
      {ring < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: MARK.x,
            top: MARK.y,
            width: 2 * lerp(60, 340, ring),
            height: 2 * lerp(60, 340, ring),
            borderRadius: '50%',
            border: `${lerp(16, 2, ring)}px solid ${C.accentForeground}`,
            transform: 'translate(-50%, -50%)',
            opacity: 1 - ring,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: MARK.x - (MARK.height * 134) / 166 / 2,
          top: MARK.y - MARK.height / 2,
          width: (MARK.height * 134) / 166,
          display: 'flex',
          color: C.accentForeground,
          filter: `drop-shadow(0 10px 0 ${alpha(C.background, 20)})`,
          transform: `translateY(${Math.sin(frame / 12) * 6}px) rotate(${lerp(-120, 0, mark)}deg) scale(${mark * (1 + 0.03 * pulse(frame))})`,
        }}
      >
        <KivoMark />
      </div>
      <Sparkles at={3} count={10} radius={280} x={MARK.x} y={MARK.y} />
      {frame >= b(0.5)
        ? STARS.map((star, i) => (
            <Star
              key={i}
              color={i === 1 ? C.warning : C.accentForeground}
              rotate={frame * 1.5}
              size={star.size * (0.7 + 0.5 * pulse(frame)) * snap(frame, b(0.5) + i * 3)}
              x={star.x}
              y={star.y}
            />
          ))
        : null}

      <Slam at={b(1)} center color={C.accentForeground} size={180} tilt={0} x={720} y={478}>
        Kivo
      </Slam>
      <Slam at={b(2)} center color={C.accentForeground} size={72} tilt={-1} x={720} y={640}>
        Everything important,
      </Slam>
      <Slam at={b(2.5)} center color={C.accentForeground} size={72} tilt={1} x={720} y={728}>
        in one place.
      </Slam>
      <Doodle at={b(3)} color={C.warning} kind="squiggle" stroke={7} width={300} x={570} y={766} />

      {STICKERS.map((sticker, i) => (
        <Sticker
          key={i}
          at={b(1.5 + i / 4)}
          bg={sticker.bg}
          rotate={sticker.rotate}
          round
          silent
          x={sticker.x + Math.cos(frame / 22 + i * 1.7) * 14}
          y={sticker.y + Math.sin(frame / 18 + i) * 14}
        >
          <Icon color={sticker.color} icon={sticker.icon} size={70} stroke={2} />
        </Sticker>
      ))}

      <Sfx at={BUTTON_AT} name="pop" />
      {frame >= BUTTON_AT ? (
        <div
          style={{
            position: 'absolute',
            left: BUTTON.x,
            top: BUTTON.y,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '24px 50px 26px',
            borderRadius: 999,
            background: C.warning,
            border: `5px solid ${C.background}`,
            boxShadow: `${pressed ? 3 : 10}px ${pressed ? 4 : 12}px 0 ${C.background}`,
            color: C.warningForeground,
            fontSize: 54,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
            transform: `translate(-50%, -50%) translate(${pressed * 6}px, ${pressed * 8}px) rotate(${lerp(-12, 0, button)}deg) scale(${button * (1 + 0.035 * pulse(frame))})`,
          }}
        >
          Try it now
          <Icon icon={ArrowRight01Icon} size={50} stroke={2.6} />
        </div>
      ) : null}
      <Sparkles at={CLICK + 2} count={12} radius={250} x={BUTTON.x} y={BUTTON.y} />

      {frame >= b(5) ? (
        <div
          style={{
            position: 'absolute',
            left: 720,
            top: 990,
            color: C.accentForeground,
            fontSize: 30,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            opacity: 0.9 * caption,
            transform: `translate(-50%, -50%) translateY(${lerp(30, 0, caption)}px)`,
          }}
        >
          For Windows 10 and 11
        </div>
      ) : null}

      <Cursor
        clicks={[CLICK]}
        path={[
          [b(3.75), 1500, 1150],
          [CLICK - 3, BUTTON.x + 150, BUTTON.y + 10],
          [b(6.5), BUTTON.x + 270, BUTTON.y + 40],
        ]}
      />
    </Scene>
  )
}
