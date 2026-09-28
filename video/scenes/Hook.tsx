import {
  File01Icon,
  Link02Icon,
  NoteEditIcon,
  SquareLockPasswordIcon,
} from '@hugeicons/core-free-icons'
import { AbsoluteFill, useCurrentFrame } from 'remotion'

import { AppWindow, C, Cursor, Dock, Icon, Scene, Sfx, Slam, Sticker, alpha, b, dockIcon, fadeForExit, lerp, pop, snap } from '../kit'

// Four words, one per half beat, each on one of the theme's four colors.
const WORDS = [
  { word: 'NOTES.', bg: C.accent, color: C.accentForeground, size: 210 },
  { word: 'LINKS.', bg: C.warning, color: C.warningForeground, size: 210 },
  { word: 'FILES.', bg: C.success, color: C.successForeground, size: 210 },
  { word: 'PASSWORDS.', bg: C.danger, color: C.dangerForeground, size: 170 },
].map((word, i) => ({ ...word, at: b(i / 2) }))

const STICKERS = [
  { icon: NoteEditIcon, x: 70, y: 250, bg: C.warning, color: C.warningForeground, rotate: -10 },
  { icon: Link02Icon, x: 1370, y: 240, bg: C.success, color: C.successForeground, rotate: 8 },
  { icon: File01Icon, x: 60, y: 840, bg: C.foreground, color: C.background, rotate: 7 },
  { icon: SquareLockPasswordIcon, x: 1380, y: 830, bg: C.foreground, color: C.background, rotate: -8 },
]

// Counts from the demo vault.
const STATS = [
  { label: 'Notes', value: 4, icon: NoteEditIcon, tint: C.warning, color: C.warningForeground },
  { label: 'Links', value: 3, icon: Link02Icon, tint: C.accent, color: C.accentForeground },
  { label: 'Files', value: 3, icon: File01Icon, tint: C.success, color: C.successForeground },
  { label: 'Passwords', value: 4, icon: SquareLockPasswordIcon, tint: C.danger, color: C.dangerForeground },
]

const WINDOW = { x: 220, y: 230, width: 1000, height: 600 }
const DOCK = { x: 720, y: WINDOW.y + WINDOW.height - 72 }
const NOTES = dockIcon('Notes', DOCK.x, DOCK.y)
const CLICK = b(4)

export function Hook({ beats }: { beats: number }) {
  const frame = useCurrentFrame()
  // The word on screen sets the background; from beat 2 the scene settles on the accent.
  const current = frame < b(2) ? ([...WORDS].reverse().find((word) => frame >= word.at) ?? WORDS[0]) : WORDS[0]
  const landed = pop(frame, b(3))
  const fly = snap(frame, b(3))

  return (
    <Scene beats={beats} bg={current.bg} dots={alpha(current.color, 16)} exit={{ x: NOTES.x, y: NOTES.y, r: 26 }}>
      {WORDS.map((word, i) => (
        <Slam
          key={word.word}
          at={word.at}
          center
          color={word.color}
          size={word.size}
          until={WORDS[i + 1]?.at ?? b(2)}
          x={720}
          y={540}
        >
          {word.word}
        </Slam>
      ))}

      <AbsoluteFill style={{ opacity: 1 - fly }}>
        {STICKERS.map((sticker, i) => (
          <Sticker
            key={i}
            at={WORDS[i].at}
            bg={sticker.bg}
            rotate={sticker.rotate}
            round
            silent
            x={lerp(sticker.x, 720, fly)}
            y={lerp(sticker.y, 540, fly)}
          >
            <Icon color={sticker.color} icon={sticker.icon} size={78} stroke={2} />
          </Sticker>
        ))}
      </AbsoluteFill>

      <Slam at={b(2)} center color={C.accentForeground} out={b(3)} size={200} x={720} y={430}>
        ALL IN
      </Slam>
      <Slam at={b(2.5)} block={C.warning} center color={C.warningForeground} out={b(3)} size={200} tilt={2} x={720} y={650}>
        ONE APP.
      </Slam>

      <Sfx at={b(3) - 6} name="whoosh" />
      <Sfx at={b(3.25)} name="pop" />
      <Sfx at={b(3.5)} name="pop" />
      {frame >= b(3) ? (
        <AbsoluteFill style={{ transform: `rotate(${lerp(-30, 0, landed)}deg) scale(${lerp(0.1, 1, landed)})` }}>
          <AppWindow height={WINDOW.height} style={{ left: WINDOW.x, top: WINDOW.y }} title="Dashboard" width={WINDOW.width}>
            <div style={{ padding: '34px 36px' }}>
              <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: '-0.03em' }}>Good morning, Alex</div>
              <div style={{ fontSize: 24, color: C.muted, marginTop: 8 }}>Here is your vault at a glance.</div>
              <div style={{ display: 'flex', gap: 20, marginTop: 36 }}>
                {STATS.map((stat, i) => (
                  <div
                    key={stat.label}
                    style={{
                      flex: 1,
                      padding: 22,
                      borderRadius: 24,
                      background: C.surface,
                      transform: `translateY(${lerp(60, 0, snap(frame, b(3.25) + i * 3))}px) scale(${pop(frame, b(3.25) + i * 3)})`,
                    }}
                  >
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 16,
                        display: 'grid',
                        placeItems: 'center',
                        background: stat.tint,
                        color: stat.color,
                      }}
                    >
                      <Icon icon={stat.icon} size={30} stroke={2} />
                    </div>
                    <div style={{ fontSize: 56, fontWeight: 800, marginTop: 16, letterSpacing: '-0.03em' }}>{stat.value}</div>
                    <div style={{ fontSize: 22, color: C.muted }}>{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </AppWindow>
          <Dock active={frame >= CLICK ? 'Notes' : 'Dashboard'} at={b(3.5)} glyph={fadeForExit(frame, beats)} x={DOCK.x} y={DOCK.y} />
        </AbsoluteFill>
      ) : null}

      <Cursor clicks={[CLICK]} fade={fadeForExit(frame, beats)} path={[[b(3.25), 1500, 1150], [b(3.85), NOTES.x, NOTES.y]]} />
    </Scene>
  )
}
