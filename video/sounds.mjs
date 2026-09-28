// Makes the promo's sounds: a drum loop and the effects the scenes trigger.
// Plain math, no packages. The noise is seeded, so every run writes the same files.
import { mkdirSync, writeFileSync } from 'node:fs'

const RATE = 48000
const BPM = 110 // BPM in video/kit.tsx
const BEATS = 40 // the composition's length (24 s)
const OUT = new URL('./public/sfx/', import.meta.url)

// White noise from a seeded generator (mulberry32), -1 to 1.
let seed = 7
function noise() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
}

const track = (seconds) => new Float32Array(Math.round(seconds * RATE))

/** A sound `seconds` long, built sample by sample from the time in seconds. */
function make(seconds, sample) {
  const out = track(seconds)
  for (let i = 0; i < out.length; i++) out[i] = sample(i / RATE)
  return out
}

/** Adds `sound` into `into`, starting `at` seconds in. */
function mix(into, sound, at, gain = 1) {
  const start = Math.round(at * RATE)
  for (let i = 0; i < sound.length && start + i < into.length; i++) into[start + i] += sound[i] * gain
}

function lowpass(sound, hz) {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / RATE)
  let y = 0
  return sound.map((x) => (y += a * (x - y)))
}

function highpass(sound, hz) {
  const low = lowpass(sound, hz)
  return sound.map((x, i) => x - low[i])
}

/** Band-pass whose center glides from `from` to `to` Hz (state-variable filter). */
function sweep(sound, from, to) {
  let low = 0
  let band = 0
  return sound.map((x, i) => {
    const f = 2 * Math.sin((Math.PI * from * Math.pow(to / from, i / sound.length)) / RATE)
    low += f * band
    band += f * (x - low - 0.6 * band)
    return band
  })
}

// Drum and synth voices.

function kick() {
  let phase = 0
  return make(0.5, (t) => {
    phase += (2 * Math.PI * (45 + 110 * Math.exp(-t / 0.035))) / RATE
    return Math.tanh(1.6 * (Math.sin(phase) * Math.exp(-t / 0.16) + noise() * Math.exp(-t / 0.002) * 0.25))
  })
}

function clap() {
  const raw = make(0.35, (t) => {
    const bursts = [0, 0.011, 0.023].reduce((sum, start) => sum + (t >= start ? Math.exp(-(t - start) / 0.004) : 0), 0)
    return noise() * (bursts + (t >= 0.03 ? 0.6 * Math.exp(-(t - 0.03) / 0.09) : 0))
  })
  return lowpass(highpass(raw, 900), 5000)
}

const hat = (decay) => highpass(highpass(make(decay * 6, (t) => noise() * Math.exp(-t / decay)), 7000), 7000)

function bass(hz) {
  const length = 0.3
  return make(length, (t) => {
    const x = Math.sin(2 * Math.PI * hz * t) + 0.45 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t)
    return Math.tanh(1.5 * x) * Math.min(1, t / 0.004, (length - t) / 0.01) * Math.exp(-t / 0.09)
  })
}

/** A soft saw pad: two slightly detuned voices per note, five harmonics each. */
function chord(notes, length) {
  return make(length, (t) => {
    let x = 0
    for (const hz of notes) {
      for (const detune of [0.996, 1.004]) {
        for (let k = 1; k <= 5; k++) x += Math.sin(2 * Math.PI * hz * detune * k * t) / k
      }
    }
    return (x / 10) * Math.min(1, t / 0.02, (length - t) / 0.05)
  })
}

// The loop: Am, F, C, G, one bar each. Bass root on the offbeats, pad pumping against the kick.
const CHORDS = [
  [55.0, [220.0, 261.63, 329.63]],
  [43.65, [174.61, 220.0, 261.63]],
  [65.41, [196.0, 261.63, 329.63]],
  [49.0, [196.0, 246.94, 293.66]],
]

const BEAT = 60 / BPM
const loop = track(BEATS * BEAT)
const pad = track(BEATS * BEAT)

for (let n = 0; n < BEATS; n++) {
  const t = n * BEAT
  const [root, notes] = CHORDS[Math.floor(n / 4) % CHORDS.length]
  mix(loop, kick(), t)
  if (n % 2 === 1) mix(loop, clap(), t, 0.5)
  mix(loop, hat(0.025), t, 0.12)
  mix(loop, hat(0.015), t + BEAT / 4, 0.07)
  mix(loop, hat(0.12), t + BEAT / 2, 0.16)
  mix(loop, hat(0.015), t + (3 * BEAT) / 4, 0.07)
  mix(loop, bass(root), t + BEAT / 2, 0.45)
  if (n % 4 === 0) mix(pad, chord(notes, 4 * BEAT), t, 0.14)
}

lowpass(pad, 2200).forEach((x, i) => {
  const since = (i / RATE) % BEAT
  const duck = since < 0.01 ? since / 0.01 : Math.exp(-(since - 0.01) / 0.09)
  loop[i] += x * (1 - 0.8 * duck)
})

// Effects. Each one is placed in the video by the part that moves with it.

function slam() {
  let phase = 0
  const snap = lowpass(highpass(make(0.35, (t) => noise() * Math.exp(-t / 0.025)), 1200), 6000)
  return make(0.35, (t) => {
    phase += (2 * Math.PI * (40 + 90 * Math.exp(-t / 0.03))) / RATE
    return Math.sin(phase) * Math.exp(-t / 0.12)
  }).map((x, i) => Math.tanh(1.4 * (x + 0.8 * snap[i])))
}

function pop() {
  let phase = 0
  return make(0.12, (t) => {
    phase += (2 * Math.PI * (380 + 700 * (1 - Math.exp(-t / 0.012)))) / RATE
    return Math.sin(phase) * Math.min(1, t / 0.002) * Math.exp(-t / 0.035)
  })
}

const click = () =>
  make(0.06, (t) => noise() * Math.exp(-t / 0.0015) * 0.8 + Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t / 0.008) * 0.5)

/** Rises to its loudest at the end of a zoom between scenes, where the cut is. */
function whoosh() {
  const peak = 14 / 30 // EXIT frames at 30 fps (video/kit.tsx)
  return sweep(make(peak + 0.15, (t) => noise() * (t < peak ? (t / peak) ** 2 : Math.exp(-(t - peak) / 0.05))), 250, 5000)
}

function sparkle() {
  const out = track(0.5)
  const notes = [2637, 3136, 3951, 3520, 4699]
  notes.forEach((hz, i) => {
    mix(out, make(0.3, (t) => Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.07)), i * 0.035, 1 - i * 0.12)
  })
  return out
}

/** Key ticks every 2 frames; the video cuts it to the length of each typing run. */
function typing() {
  const out = track(1.2)
  for (let k = 0; k < 18; k++) {
    const hz = 3200 + (k % 3) * 300
    const tick = make(0.03, (t) => noise() * Math.exp(-t / 0.0015) + 0.4 * Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.006))
    mix(out, tick, k / 15, 0.7 + 0.15 * ((k * 7) % 3))
  }
  return out
}

function impact() {
  let phase = 0
  const crash = highpass(make(1.4, (t) => noise() * Math.exp(-t / 0.3)), 2500)
  return make(1.4, (t) => {
    phase += (2 * Math.PI * (28 + 60 * Math.exp(-t / 0.08))) / RATE
    return Math.sin(phase) * Math.exp(-t / 0.45)
  }).map((x, i) => Math.tanh(1.3 * (x + 0.35 * crash[i])))
}

/** Writes a 16-bit mono WAV, scaled so its loudest sample sits at -6 dBFS. */
function save(name, sound) {
  const peak = sound.reduce((max, x) => Math.max(max, Math.abs(x)), 0)
  const gain = peak ? 0.5 / peak : 0
  const fade = Math.min(96, sound.length)
  const file = Buffer.alloc(44 + sound.length * 2)
  file.write('RIFF', 0)
  file.writeUInt32LE(36 + sound.length * 2, 4)
  file.write('WAVEfmt ', 8)
  file.writeUInt32LE(16, 16)
  file.writeUInt16LE(1, 20) // PCM
  file.writeUInt16LE(1, 22) // mono
  file.writeUInt32LE(RATE, 24)
  file.writeUInt32LE(RATE * 2, 28)
  file.writeUInt16LE(2, 32)
  file.writeUInt16LE(16, 34)
  file.write('data', 36)
  file.writeUInt32LE(sound.length * 2, 40)
  sound.forEach((x, i) => {
    const edge = Math.min(1, (sound.length - 1 - i) / fade) // no click at the cut-off end
    file.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x * gain * edge)) * 32767), 44 + i * 2)
  })
  writeFileSync(new URL(`${name}.wav`, OUT), file)
}

mkdirSync(OUT, { recursive: true })
save('beat', loop)
for (const effect of [slam, pop, click, whoosh, sparkle, typing, impact]) save(effect.name, effect())
