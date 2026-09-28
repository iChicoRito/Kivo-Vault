import {
  CheckmarkCircle02Icon,
  Copy01Icon,
  GithubIcon,
  LockIcon,
  Mail01Icon,
  RouterIcon,
  SquareUnlock02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useCurrentFrame } from 'remotion'

import {
  AppWindow,
  C,
  Cursor,
  Doodle,
  Icon,
  Scene,
  Sfx,
  Slam,
  Sparkles,
  Sticker,
  TITLE_BAR,
  alpha,
  b,
  fadeForExit,
  glide,
  lerp,
  pop,
  snap,
} from '../kit'

// The demo vault's logins (landing/demo/backend.ts). Avatars are neutral circles with an icon or
// initial, like the app's CredentialAvatar.
const LOGINS = [
  { service: 'GitHub', user: 'alex-reyes', icon: GithubIcon },
  { service: 'Proton Mail', user: 'alex@proton.me', icon: Mail01Icon },
  { service: 'Netflix', user: 'alex@proton.me' },
  { service: 'Home router', user: 'admin', icon: RouterIcon },
]

const WINDOW = { x: -60, y: 400, width: 1000, height: 640 }
const VAULT = { x: WINDOW.x + 350, y: 600, width: 620, height: 480 }
const UNLOCK = { x: VAULT.x, y: VAULT.y + 145 }
const PAD = 26
const HEADER = 70
const ROW = { height: 100, gap: 10 }
// GitHub's copy button, and the app icon in the title bar that the exit zooms into.
const COPY = {
  x: WINDOW.x + WINDOW.width - 2 - PAD - 18 - 30,
  y: WINDOW.y + 2 + TITLE_BAR + PAD + HEADER + ROW.height / 2,
}
const APP_ICON = { x: WINDOW.x + 2 + 22 + 17, y: WINDOW.y + 2 + TITLE_BAR / 2 }

// Master password dots: how many, and frames per dot.
const DOT_COUNT = 8
const DOT_RATE = 1.5
const DOTS = b(1.25)
const CLICK_UNLOCK = b(2)
const FLIP = CLICK_UNLOCK + 2
const FLIP_FRAMES = 7
const CLICK_COPY = b(4)

export function Passwords({ beats }: { beats: number }) {
  const frame = useCurrentFrame()
  const vault = pop(frame, b(1))
  const flipOut = glide(frame, FLIP, FLIP_FRAMES)
  const flipIn = snap(frame, FLIP + FLIP_FRAMES)
  const unlocked = frame >= CLICK_UNLOCK
  const copied = frame >= CLICK_COPY
  const press = (at: number) => (frame >= at && frame <= at + 8 ? 1 - 0.12 * Math.sin(((frame - at) / 8) * Math.PI) : 1)
  const fade = fadeForExit(frame, beats)
  const dots = Math.max(0, Math.min(DOT_COUNT, Math.floor((frame - DOTS) / DOT_RATE)))

  return (
    <Scene beats={beats} bg={C.danger} dots={alpha(C.dangerForeground, 16)} exit={{ x: APP_ICON.x, y: APP_ICON.y, r: 15 }}>
      <Slam at={0} center color={C.dangerForeground} size={140} x={1245} y={150}>
        LOCKED
      </Slam>
      <Slam at={b(0.5)} block={C.foreground} center color={C.background} size={140} tilt={2} x={1245} y={300}>
        TIGHT.
      </Slam>

      <Sfx at={b(1)} name="pop" />
      {frame >= b(1) && flipOut < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: VAULT.x - VAULT.width / 2,
            top: VAULT.y - VAULT.height / 2,
            width: VAULT.width,
            height: VAULT.height,
            padding: 36,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderRadius: 32,
            background: C.surface,
            border: `4px solid ${C.background}`,
            boxShadow: `12px 14px 0 ${C.background}`,
            color: C.foreground,
            transform: `perspective(1600px) rotateY(${flipOut * 90}deg) rotate(${lerp(-18, 0, vault)}deg) scale(${vault})`,
          }}
        >
          <div
            style={{
              width: 104,
              height: 104,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: unlocked ? C.success : C.default,
              color: unlocked ? C.successForeground : C.foreground,
              transform: `rotate(${unlocked ? lerp(-25, 0, pop(frame, CLICK_UNLOCK)) : 0}deg)`,
            }}
          >
            <Icon icon={unlocked ? SquareUnlock02Icon : LockIcon} size={54} stroke={2} />
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, marginTop: 20, letterSpacing: '-0.02em' }}>Password vault</div>
          <div style={{ fontSize: 22, color: C.muted, marginTop: 6 }}>Enter your master password</div>
          <div
            style={{
              alignSelf: 'stretch',
              height: 72,
              marginTop: 24,
              padding: '0 24px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderRadius: 18,
              background: C.default,
            }}
          >
            {Array.from({ length: dots }, (_, i) => (
              <span key={i} style={{ width: 16, height: 16, borderRadius: '50%', background: C.foreground }} />
            ))}
          </div>
          <div
            style={{
              alignSelf: 'stretch',
              height: 64,
              marginTop: 16,
              borderRadius: 18,
              display: 'grid',
              placeItems: 'center',
              background: C.accent,
              color: C.accentForeground,
              fontSize: 26,
              fontWeight: 700,
              transform: `scale(${press(CLICK_UNLOCK)})`,
            }}
          >
            Unlock
          </div>
        </div>
      ) : null}
      <Sfx at={DOTS} frames={Math.ceil(DOT_COUNT * DOT_RATE)} name="typing" />
      <Sfx at={CLICK_UNLOCK + 1} name="pop" />
      <Sfx at={FLIP} name="whoosh" />

      {frame >= FLIP + FLIP_FRAMES ? (
        <AppWindow
          glyph={fade}
          height={WINDOW.height}
          style={{
            left: WINDOW.x,
            top: WINDOW.y,
            transform: `perspective(1600px) rotateY(${lerp(-90, 0, flipIn)}deg)`,
          }}
          title="Password Manager"
          width={WINDOW.width}
        >
          <div style={{ padding: PAD }}>
            <div style={{ height: HEADER, display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.03em' }}>Passwords</div>
              <div style={{ fontSize: 22, color: C.muted, marginTop: 10 }}>4 logins</div>
            </div>
            <div style={{ display: 'grid', gap: ROW.gap }}>
              {LOGINS.map((login, i) => {
                const at = b(2.5 + i / 4)
                const p = snap(frame, at)
                const side = i % 2 ? 1 : -1
                const done = i === 0 && copied
                return (
                  <div
                    key={login.service}
                    style={{
                      height: ROW.height,
                      padding: '0 18px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 20,
                      borderRadius: 22,
                      background: C.surface,
                      opacity: frame >= at ? 1 : 0,
                      transform: `translateX(${lerp(side * 700, 0, p)}px) rotate(${lerp(side * 8, 0, p)}deg)`,
                    }}
                  >
                    <div
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: '50%',
                        display: 'grid',
                        placeItems: 'center',
                        background: C.default,
                        color: C.foreground,
                        fontSize: 30,
                        fontWeight: 700,
                      }}
                    >
                      {login.icon ? <Icon icon={login.icon} size={32} /> : login.service.charAt(0)}
                    </div>
                    <div>
                      <div style={{ fontSize: 30, fontWeight: 700 }}>{login.service}</div>
                      <div style={{ fontSize: 22, color: C.muted, marginTop: 4 }}>{login.user}</div>
                    </div>
                    <div style={{ marginLeft: 'auto', fontSize: 30, letterSpacing: '0.12em', color: C.muted }}>••••••••••</div>
                    <div
                      style={{
                        width: 60,
                        height: 60,
                        borderRadius: 18,
                        display: 'grid',
                        placeItems: 'center',
                        background: done ? C.success : C.default,
                        color: done ? C.successForeground : C.foreground,
                        transform: i === 0 ? `scale(${press(CLICK_COPY)})` : undefined,
                      }}
                    >
                      <Icon icon={done ? Tick02Icon : Copy01Icon} size={30} stroke={done ? 2.6 : 1.8} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </AppWindow>
      ) : null}
      {LOGINS.map((login, i) => (
        <Sfx key={login.service} at={b(2.5 + i / 4)} name="pop" />
      ))}
      <Sparkles at={CLICK_COPY + 2} colors={[C.success, C.foreground, C.warning]} x={COPY.x} y={COPY.y} />

      <Sfx at={b(4.25)} name="pop" />
      {frame >= b(4.25) ? (
        <div
          style={{
            position: 'absolute',
            left: WINDOW.x + WINDOW.width / 2,
            top: WINDOW.y + WINDOW.height - 60,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '16px 28px',
            borderRadius: 999,
            background: C.surface,
            border: `4px solid ${C.background}`,
            boxShadow: `8px 10px 0 ${C.background}`,
            color: C.foreground,
            fontSize: 28,
            fontWeight: 700,
            whiteSpace: 'nowrap',
            transform: `translate(-50%, -50%) translateY(${lerp(80, 0, pop(frame, b(4.25)))}px) scale(${snap(frame, b(4.25))})`,
          }}
        >
          <Icon color={C.success} icon={CheckmarkCircle02Icon} size={36} stroke={2.2} />
          Password copied
        </div>
      ) : null}

      <Sticker at={b(4.5)} rotate={8} size={42} x={1400} y={560}>
        <Icon icon={LockIcon} size={42} stroke={2.4} />
        AES-256
      </Sticker>
      <Sparkles at={b(4.5) + 3} colors={[C.warning, C.foreground, C.accent]} radius={170} x={1400} y={560} />
      <Doodle at={b(5)} color={C.foreground} kind="loop" rotate={-4} width={390} x={1195} y={462} />
      <Sticker at={b(5.5)} bg={C.warning} color={C.warningForeground} rotate={-6} size={36} x={1380} y={775}>
        Only on your PC
      </Sticker>

      <Cursor
        clicks={[CLICK_UNLOCK, CLICK_COPY]}
        fade={fade}
        path={[
          [b(1.25), 1500, 1150],
          [CLICK_UNLOCK - 2, UNLOCK.x + 40, UNLOCK.y + 8],
          [CLICK_UNLOCK + 3, UNLOCK.x + 40, UNLOCK.y + 8],
          [b(3), 1000, 880],
          [CLICK_COPY - 2, COPY.x, COPY.y],
          [b(5.5), COPY.x, COPY.y],
          [b(6.3), 1520, 1180],
        ]}
      />
    </Scene>
  )
}
