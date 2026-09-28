import { AbsoluteFill, Composition, Html5Audio, Series, interpolate, staticFile, useCurrentFrame } from 'remotion'

import { C, CLAMP, EXIT, FPS, HEIGHT, Sfx, WIDTH, b, fontFamily, pulse } from './kit'
import { Hook } from './scenes/Hook'
import { Notes } from './scenes/Notes'
import { Search } from './scenes/Search'
import { Collections } from './scenes/Collections'
import { Passwords } from './scenes/Passwords'
import { Outro } from './scenes/Outro'

// The scenes in order, with their length in beats. The video is their sum.
const SCENES = [
  [Hook, 5],
  [Notes, 7],
  [Search, 7],
  [Collections, 7],
  [Passwords, 7],
  [Outro, 7],
] as const

const LENGTHS = SCENES.map(([, beats]) => b(beats))
const TOTAL = LENGTHS.reduce((sum, length) => sum + length, 0)
// The frame of each cut between two scenes.
let end = 0
const CUTS = LENGTHS.slice(0, -1).map((length) => (end += length))

function Promo() {
  const frame = useCurrentFrame()

  // `data-theme="dark"` makes the component color tokens resolve to the app's dark theme.
  return (
    <AbsoluteFill data-theme="dark" style={{ fontFamily, background: C.background }}>
      {/* The whole picture bumps on every beat, in time with the kick. */}
      <AbsoluteFill style={{ transform: `scale(${1 + 0.012 * pulse(frame)})` }}>
        <Series>
          {SCENES.map(([Scene, beats], i) => (
            <Series.Sequence key={i} durationInFrames={b(beats)}>
              <Scene beats={beats} />
            </Series.Sequence>
          ))}
        </Series>
      </AbsoluteFill>
      <Html5Audio src={staticFile('sfx/beat.wav')} volume={(f) => interpolate(f, [TOTAL - b(0.5), TOTAL], [0.75, 0], CLAMP)} />
      <Sfx at={0} name="impact" />
      {/* Whooshes live here, not in the scenes, so the cut does not chop them off. */}
      {CUTS.map((cut) => (
        <Sfx key={cut} at={cut - EXIT} name="whoosh" />
      ))}
    </AbsoluteFill>
  )
}

export function Root() {
  return <Composition component={Promo} durationInFrames={TOTAL} fps={FPS} height={HEIGHT} id="KivoPromo" width={WIDTH} />
}
