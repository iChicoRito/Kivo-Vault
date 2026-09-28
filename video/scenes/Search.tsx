import { Airplane01Icon, Link02Icon, NoteEditIcon, Search01Icon } from '@hugeicons/core-free-icons'
import { interpolate, useCurrentFrame } from 'remotion'

import { C, CLAMP, Cursor, Doodle, Icon, Scene, Sfx, Slam, Sparkles, Sticker, alpha, b, fadeForExit, lerp, pop, snap } from '../kit'

const FIELD = { x: 160, y: 440, width: 950, height: 110 }
const PANEL = { x: 160, y: 580 }
const ROW = { height: 124, gap: 10, top: PANEL.y + 4 + 16 }
const CHIP = { width: 240, height: 48 }
// The collection chip on the last result: the cursor clicks it and the scene zooms into it.
const TARGET = {
  x: FIELD.x + FIELD.width - 4 - 20 - CHIP.width / 2,
  y: ROW.top + 2 * (ROW.height + ROW.gap) + ROW.height / 2,
}

const QUERY = 'travel'
// Frames per typed letter.
const RATE = 3
const KEYS = b(2)
const TYPE = KEYS + 2
const CLICK = b(5)

// Items tagged #travel in the demo vault, plus the note written in the previous scene.
const RESULTS = [
  { icon: NoteEditIcon, title: 'Pastéis de Belém', kind: 'Note · just now' },
  { icon: NoteEditIcon, title: 'Lisbon trip', kind: 'Note', collection: true },
  { icon: Link02Icon, title: 'Carris tram timetable', kind: 'Link · carris.pt', collection: true },
]

export function Search({ beats }: { beats: number }) {
  const frame = useCurrentFrame()
  const field = pop(frame, b(1))
  const typed = QUERY.slice(0, Math.max(0, Math.floor((frame - TYPE) / RATE)))
  const panel = snap(frame, b(3))
  const fade = fadeForExit(frame, beats)
  const press = frame >= CLICK && frame <= CLICK + 8 ? 1 - 0.12 * Math.sin(((frame - CLICK) / 8) * Math.PI) : 1

  return (
    <Scene beats={beats} bg={C.warning} dots={alpha(C.warningForeground, 14)} exit={{ x: TARGET.x, y: TARGET.y, r: 22 }}>
      <Slam at={0} center color={C.warningForeground} size={170} x={720} y={140}>
        FIND
      </Slam>
      <Slam at={b(0.5)} block={C.background} center color={C.foreground} size={150} tilt={2} x={720} y={300}>
        ANYTHING.
      </Slam>

      <Sfx at={b(1)} name="pop" />
      {frame >= b(1) ? (
        <div
          style={{
            position: 'absolute',
            left: FIELD.x,
            top: FIELD.y,
            width: FIELD.width,
            height: FIELD.height,
            padding: '0 34px',
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            borderRadius: 30,
            background: C.surface,
            border: `4px solid ${C.background}`,
            boxShadow: `12px 14px 0 ${C.background}`,
            color: C.foreground,
            fontSize: 46,
            fontWeight: 600,
            transform: `rotate(${lerp(-14, 0, field)}deg) scale(${lerp(0.3, 1, field)})`,
          }}
        >
          <Icon color={C.muted} icon={Search01Icon} size={44} stroke={2} />
          {typed ? <span>{typed}</span> : <span style={{ color: C.muted }}>Search your vault</span>}
          {frame >= TYPE && Math.floor(frame / 9) % 2 === 0 ? (
            <span style={{ width: 5, height: 50, marginLeft: -14, background: C.foreground }} />
          ) : null}
        </div>
      ) : null}

      <Keycap at={b(1.5)} label="Ctrl" x={1205} />
      <Keycap at={b(1.75)} label="F" x={1330} />
      <Sfx at={KEYS} name="click" />
      <Sfx at={TYPE} frames={QUERY.length * RATE} name="typing" />

      {frame >= b(3) ? (
        <div
          style={{
            position: 'absolute',
            left: PANEL.x,
            top: PANEL.y,
            width: FIELD.width,
            padding: 16,
            display: 'grid',
            gap: ROW.gap,
            borderRadius: 30,
            background: C.surface,
            border: `4px solid ${C.background}`,
            boxShadow: `12px 14px 0 ${C.background}`,
            color: C.foreground,
            transform: `scaleY(${lerp(0.3, 1, panel)})`,
            transformOrigin: '50% 0',
            opacity: interpolate(frame, [b(3), b(3) + 3], [0, 1], CLAMP),
          }}
        >
          {RESULTS.map((result, i) => {
            const at = b(3 + i / 2)
            const p = snap(frame, at)
            return (
              <div
                key={result.title}
                style={{
                  height: ROW.height,
                  padding: '0 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  borderRadius: 20,
                  background: i === 2 && frame >= CLICK ? C.default : 'transparent',
                  opacity: frame >= at ? 1 : 0,
                  transform: `translateX(${lerp(500, 0, p)}px)`,
                }}
              >
                <div style={{ width: 80, height: 80, borderRadius: 20, background: C.default, display: 'grid', placeItems: 'center' }}>
                  <Icon icon={result.icon} size={40} />
                </div>
                <div>
                  <div style={{ fontSize: 32, fontWeight: 700 }}>{result.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 22, color: C.muted }}>
                    {result.kind}
                    <span style={{ padding: '2px 12px', borderRadius: 999, background: C.warning, color: C.warningForeground, fontWeight: 800 }}>
                      #travel
                    </span>
                  </div>
                </div>
                {result.collection ? (
                  <div
                    style={{
                      marginLeft: 'auto',
                      width: CHIP.width,
                      height: CHIP.height,
                      borderRadius: 999,
                      background: C.success,
                      color: C.successForeground,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      fontSize: 21,
                      fontWeight: 700,
                      transform: i === 2 ? `scale(${press})` : undefined,
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: i === 2 ? fade : 1 }}>
                      <Icon icon={Airplane01Icon} size={24} stroke={2} />
                      Lisbon, October
                    </span>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {RESULTS.map((result, i) => (
        <Sfx key={result.title} at={b(3 + i / 2)} name="pop" />
      ))}
      <Sparkles at={b(3) + 4} colors={[C.success, C.foreground, C.accent]} x={440} y={690} />

      <Doodle at={b(4.5)} kind="arrow" rotate={161} width={220} x={1105} y={770} />
      <Sparkles at={CLICK + 2} colors={[C.success, C.foreground, C.background]} x={TARGET.x} y={TARGET.y} />
      <Sticker at={b(5.5)} rotate={-5} size={34} x={1225} y={1000}>
        Titles · tags · files
      </Sticker>

      <Cursor
        clicks={[CLICK]}
        fade={fade}
        path={[
          [b(4), 1500, 1150],
          [b(4.75), TARGET.x + 30, TARGET.y + 6],
        ]}
      />
    </Scene>
  )
}

/** A keyboard key that stamps in at `at` and is pressed on KEYS, as the typing starts. */
function Keycap({ at, label, x }: { at: number; label: string; x: number }) {
  const frame = useCurrentFrame()
  const down = frame >= KEYS && frame < KEYS + 7 ? 1 : 0

  return (
    <>
      <Sfx at={at} name="pop" />
      {frame >= at ? (
        <div
          style={{
            position: 'absolute',
            left: x,
            top: FIELD.y + FIELD.height / 2,
            padding: '10px 24px',
            borderRadius: 20,
            background: C.foreground,
            border: `4px solid ${C.background}`,
            boxShadow: `0 ${down ? 3 : 11}px 0 ${C.background}`,
            color: C.background,
            fontSize: 40,
            fontWeight: 800,
            transform: `translate(-50%, ${-50 + down * 8}%) rotate(${lerp(20, -4, snap(frame, at))}deg) scale(${lerp(1.8, 1, snap(frame, at))})`,
          }}
        >
          {label}
        </div>
      ) : null}
    </>
  )
}
