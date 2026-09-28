import { Add01Icon, NoteEditIcon, PinIcon, StarIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { interpolate, useCurrentFrame } from 'remotion'

import { AppWindow, C, CLAMP, Cursor, Doodle, Icon, Scene, Sfx, Slam, Sparkles, Sticker, TITLE_BAR, alpha, b, lerp, pop, snap } from '../kit'

// The demo vault's notes (landing/demo/backend.ts).
const NOTES = [
  { title: 'Apartment move checklist', text: 'Book the elevator for Saturday, 9am.', tags: ['home', 'todo'], mark: PinIcon },
  { title: 'Lisbon trip', text: 'Tram 28 early, before 8am.', tags: ['travel'], mark: StarIcon },
  { title: "Mom's adobo", text: 'Vinegar first, and do not stir until it boils.', tags: ['recipes', 'family'], mark: StarIcon },
  { title: 'Book notes: Deep Work', text: 'Schedule every minute of the workday.', tags: ['reading'] },
]

const WINDOW = { x: 620, y: 390, width: 900, height: 640 }
const PAD = 28
// "+ New note", top right of the page; its center is where the cursor clicks.
const BUTTON = { width: 196, height: 56 }
const BUTTON_AT = {
  x: WINDOW.x + WINDOW.width - PAD - BUTTON.width / 2,
  y: WINDOW.y + TITLE_BAR + PAD + BUTTON.height / 2,
}
const CARD = { x: 560, y: 650, width: 640, height: 400, tilt: -4 }
const TITLE = 'Pastéis de Belém'
const BODY = 'The original one.'
// Frames per typed letter.
const TITLE_RATE = 1.5
const TITLE_FRAMES = Math.ceil(TITLE.length * TITLE_RATE)

const CLICK = b(3)
const OUT = b(3.25)
const TYPE_TITLE = b(3.5)
const TYPE_BODY = TYPE_TITLE + TITLE_FRAMES + 2
const PIN = b(5.5)

export function Notes({ beats }: { beats: number }) {
  const frame = useCurrentFrame()
  const inWindow = pop(frame, b(1))
  const back = snap(frame, OUT)
  const press = frame >= CLICK && frame <= CLICK + 8 ? 1 - 0.12 * Math.sin(((frame - CLICK) / 8) * Math.PI) : 1
  const card = pop(frame, OUT)
  const title = TITLE.slice(0, Math.max(0, Math.floor((frame - TYPE_TITLE) / TITLE_RATE)))
  const body = BODY.slice(0, Math.max(0, frame - TYPE_BODY))
  const typing = frame < TYPE_BODY + BODY.length
  const caret = typing || Math.floor(frame / 9) % 2 === 0
  const pin = pop(frame, PIN)

  // The exit zooms into a blank spot low on the new note, below its text.
  return (
    <Scene beats={beats} bg={C.accent} dots={alpha(C.accentForeground, 16)} exit={{ x: CARD.x + 83, y: CARD.y + 44, r: 110 }}>
      <Slam at={0} color={C.accentForeground} size={150} x={-60} y={150}>
        WRITE IT
      </Slam>
      <Slam at={b(0.5)} block={C.warning} color={C.warningForeground} size={150} tilt={-2} x={-50} y={318}>
        DOWN.
      </Slam>

      <Sfx at={b(1) - 6} name="whoosh" />
      {frame >= b(1) ? (
        <AppWindow
          height={WINDOW.height}
          style={{
            left: WINDOW.x,
            top: WINDOW.y,
            transform: `perspective(1800px) translate(${lerp(900, 0, inWindow) + back * 70}px, ${back * 40}px) rotateY(${lerp(-50, 0, inWindow)}deg) scale(${1 - back * 0.08})`,
            filter: back > 0 ? `brightness(${1 - back * 0.35})` : undefined,
          }}
          title="Notes"
          width={WINDOW.width}
        >
          <div style={{ padding: PAD }}>
            <div style={{ display: 'flex', alignItems: 'center', height: BUTTON.height }}>
              <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.03em' }}>Notes</div>
              <div style={{ fontSize: 22, color: C.muted, marginLeft: 14, marginTop: 6 }}>4 notes</div>
              <div
                style={{
                  marginLeft: 'auto',
                  width: BUTTON.width,
                  height: BUTTON.height,
                  borderRadius: 16,
                  background: C.accent,
                  color: C.accentForeground,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontSize: 24,
                  fontWeight: 700,
                  transform: `scale(${press})`,
                }}
              >
                <Icon icon={Add01Icon} size={26} stroke={2.4} />
                New note
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 26 }}>
              {NOTES.map((note, i) => {
                const at = b(1.25 + i / 4)
                const p = pop(frame, at)
                return (
                  <div
                    key={note.title}
                    style={{
                      height: 196,
                      padding: 22,
                      borderRadius: 22,
                      background: C.surface,
                      opacity: frame >= at ? 1 : 0,
                      transform: `translateY(${lerp(260, 0, p)}px) rotate(${lerp(i % 2 ? 10 : -10, 0, p)}deg) scale(${lerp(0.6, 1, p)})`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontSize: 28, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {note.title}
                      </div>
                      {note.mark ? (
                        <div style={{ marginLeft: 'auto', color: C.muted, display: 'flex' }}>
                          <Icon icon={note.mark} size={24} />
                        </div>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 21, lineHeight: 1.4, color: C.muted, marginTop: 10, height: 59, overflow: 'hidden' }}>
                      {note.text}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                      {note.tags.map((tag) => (
                        <div key={tag} style={{ fontSize: 18, padding: '4px 12px', borderRadius: 999, background: C.default }}>
                          #{tag}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </AppWindow>
      ) : null}
      {NOTES.map((note, i) => (
        <Sfx key={note.title} at={b(1.25 + i / 4)} name="pop" />
      ))}

      <Sparkles at={CLICK} x={BUTTON_AT.x} y={BUTTON_AT.y} />

      <Sfx at={OUT} name="pop" />
      {/* Behind the note, so the burst frames the pin instead of covering it. */}
      <Sparkles at={PIN + 4} colors={[C.foreground, C.danger, C.success]} x={868} y={430} />
      {frame >= OUT ? (
        <div
          style={{
            position: 'absolute',
            left: lerp(BUTTON_AT.x, CARD.x, card) - CARD.width / 2,
            top: lerp(BUTTON_AT.y, CARD.y, card) - CARD.height / 2,
            width: CARD.width,
            height: CARD.height,
            padding: '34px 40px',
            borderRadius: 30,
            background: C.warning,
            border: `5px solid ${C.background}`,
            boxShadow: `12px 14px 0 ${C.background}`,
            color: C.warningForeground,
            transform: `rotate(${lerp(25, CARD.tilt, card)}deg) scale(${lerp(0.12, 1, card)})`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 22, fontWeight: 700, opacity: 0.7 }}>
            <Icon icon={NoteEditIcon} size={26} stroke={2} />
            New note
          </div>
          <div style={{ fontSize: 56, fontWeight: 900, letterSpacing: '-0.035em', marginTop: 18, minHeight: 64 }}>
            {title}
            {caret && frame < TYPE_BODY ? <Caret /> : null}
          </div>
          <div style={{ fontSize: 30, fontWeight: 600, marginTop: 8, minHeight: 40 }}>
            {body}
            {caret && frame >= TYPE_BODY ? <Caret /> : null}
          </div>
          {frame >= b(5) ? (
            <div
              style={{
                position: 'absolute',
                left: 40,
                bottom: 34,
                fontSize: 26,
                fontWeight: 800,
                padding: '8px 20px',
                borderRadius: 999,
                background: C.background,
                color: C.warning,
                transform: `scale(${pop(frame, b(5))})`,
              }}
            >
              #travel
            </div>
          ) : null}
          {frame >= PIN ? (
            <div
              style={{
                position: 'absolute',
                right: -26,
                top: -34,
                width: 84,
                height: 84,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                background: C.danger,
                border: `5px solid ${C.background}`,
                color: C.dangerForeground,
                transform: `translateY(${lerp(-260, 0, pin)}px) rotate(${lerp(-60, 0, pin)}deg)`,
                opacity: interpolate(frame, [PIN, PIN + 3], [0, 1], CLAMP),
              }}
            >
              <Icon icon={PinIcon} size={42} stroke={2.2} />
            </div>
          ) : null}
        </div>
      ) : null}
      <Sfx at={TYPE_TITLE} frames={TITLE_FRAMES} name="typing" />
      <Sfx at={TYPE_BODY} frames={BODY.length} name="typing" />
      <Sfx at={b(5)} name="pop" />
      <Sfx at={PIN} name="pop" />

      <Sticker at={b(4.5)} rotate={5} size={38} x={1090} y={250}>
        <Icon color={C.accent} icon={Tick02Icon} size={42} stroke={3} />
        Saves as you type
      </Sticker>
      <Doodle at={b(4.5) + 4} color={C.accentForeground} kind="arrow" rotate={145} width={170} x={865} y={313} />

      <Cursor
        clicks={[CLICK]}
        path={[
          [b(2.25), 1500, 1150],
          [b(2.85), BUTTON_AT.x, BUTTON_AT.y],
          [b(3.4), BUTTON_AT.x, BUTTON_AT.y],
          [b(4.2), 1190, 930],
          [b(6), 1520, 1180],
        ]}
      />
    </Scene>
  )
}

function Caret() {
  return (
    <span style={{ display: 'inline-block', width: 5, height: '0.9em', marginLeft: 4, background: C.warningForeground, verticalAlign: '-0.1em' }} />
  )
}
