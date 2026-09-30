import { useId } from 'react'

export type HeartState = 'checking' | 'healthy' | 'problems' | 'damaged'

/** How full the heart is and its colour for each state of the check. */
const LOOK: Record<HeartState, { level: number; tone: string; label: string }> = {
  checking: { level: 0.45, tone: 'text-accent', label: 'Checking your vault' },
  healthy: { level: 0.86, tone: 'text-success', label: 'Your vault is healthy' },
  problems: { level: 0.5, tone: 'text-warning', label: 'Your vault needs attention' },
  damaged: { level: 0.2, tone: 'text-danger', label: 'Your vault database is damaged' },
}

const HEART =
  'M60 104 C57 101 10 70 10 38 C10 20 23 8 38 8 C48 8 56 14 60 22 C64 14 72 8 82 8 C97 8 110 20 110 38 C110 70 63 101 60 104 Z'

// A periodic wave twice as wide as the heart, so sliding it by one period loops seamlessly.
const WAVE = 'M0 8 Q15 0 30 8 T60 8 T90 8 T120 8 T150 8 T180 8 T210 8 T240 8 V140 H0 Z'

/**
 * A heart filled with animated liquid. The fill rises when the vault is
 * healthy and drops when there are problems. Motion stops for people who ask
 * for reduced motion; the level and colour still tell the state.
 */
export function HealthHeart({ state }: { state: HeartState }) {
  const clipId = useId()
  const look = LOOK[state]
  // The heart spans y 8 to 104. The wave crest sits at the fill line.
  const top = 104 - look.level * 96 - 8

  return (
    <svg
      aria-label={look.label}
      className={`kivo-heart ${look.tone} ${state === 'healthy' ? 'kivo-heart--beat' : ''} h-28 w-32`}
      role="img"
      viewBox="0 0 120 112"
    >
      <defs>
        <clipPath id={clipId}>
          <path d={HEART} />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        <rect fill="currentColor" height="112" opacity="0.08" width="120" />
        <g className="kivo-heart__level" style={{ transform: `translateY(${top}px)` }}>
          <path className="kivo-heart__wave kivo-heart__wave--back" d={WAVE} fill="currentColor" opacity="0.35" />
          <path className="kivo-heart__wave" d={WAVE} fill="currentColor" opacity="0.8" />
        </g>
        {state === 'healthy' ? (
          <g fill="white" opacity="0.55">
            <circle className="kivo-heart__bubble" cx="42" cy="96" r="2.5" />
            <circle className="kivo-heart__bubble kivo-heart__bubble--late" cx="70" cy="98" r="2" />
            <circle className="kivo-heart__bubble kivo-heart__bubble--later" cx="58" cy="100" r="1.5" />
          </g>
        ) : null}
      </g>

      <path d={HEART} fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="3" />
    </svg>
  )
}

export default HealthHeart
