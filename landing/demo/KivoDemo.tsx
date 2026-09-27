import { useEffect, useRef, useState } from 'react'
import { Chip } from '@heroui/react'

import KivoMark from '@/components/ui/KivoMark'
import { currentTheme } from '../theme'
import { useInView } from '../useInView'

// The desktop window's default size (`app.windows` in src-tauri/tauri.conf.json).
const APP_WIDTH = 1180
const APP_HEIGHT = 760

/** Scrolls to the demo and opens one of the app's pages in it. */
export function openInDemo(route: string) {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Kivo demo"]')
  frame?.contentWindow?.postMessage({ kivoNavigate: route }, location.origin)
  document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/**
 * The real Kivo app, running in `demo.html` against an in-memory backend. The
 * frame keeps the app's fixed dock, dialogs and toasts inside the window, and
 * it is drawn at the desktop size and scaled down to fit the column.
 */
export default function KivoDemo() {
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [scale, setScale] = useState(1)
  const [initialTheme] = useState(currentTheme)
  // The embedded app keeps drawing (its dot field, dock, charts) even off screen.
  // Hiding the frame there stops its rendering; its state stays as it was.
  const inView = useInView(bodyRef)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    const observer = new ResizeObserver(([entry]) => {
      setScale(Math.min(1, entry.contentRect.width / APP_WIDTH))
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  // Keep the app's theme in step with the page's theme button.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      frameRef.current?.contentWindow?.postMessage({ kivoTheme: currentTheme() }, location.origin)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return (
    <section
      aria-label="Kivo demo"
      className="kivo-demo-window overflow-hidden rounded-2xl border border-separator bg-background shadow-[0_24px_60px_-24px_rgb(0_0_0/0.45)]"
    >
      <header className="flex items-center gap-3 border-b border-separator bg-surface px-4 py-2.5">
        <KivoMark className="h-4 w-auto text-foreground" />
        <span className="text-sm font-semibold">Kivo</span>
        <Chip className="ml-auto" size="sm" variant="soft">
          Demo · nothing is saved
        </Chip>
      </header>

      <div ref={bodyRef} className="relative overflow-hidden" style={{ height: APP_HEIGHT * scale }}>
        <iframe
          ref={frameRef}
          className="absolute top-0 left-0 origin-top-left border-0"
          loading="lazy"
          src={`demo.html?theme=${initialTheme}`}
          style={{
            width: APP_WIDTH,
            height: APP_HEIGHT,
            transform: `scale(${scale})`,
            display: inView ? undefined : 'none',
          }}
          title="Kivo demo"
        />
      </div>
    </section>
  )
}
