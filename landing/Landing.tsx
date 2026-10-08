import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { buttonVariants, Kbd, Toast } from '@heroui/react'
import Windows11 from '@thesvg/react/windows11'

import { AnimatedThemeToggler } from '@/components/ui/animated-theme-toggler'
import DotField from '@/components/ui/DotField'
import { GradualBlur } from '@/components/ui/GradualBlur'
import KivoMark from '@/components/ui/KivoMark'
import SplitText from '@/components/ui/SplitText'
import KivoDemo from './demo/KivoDemo'
import { INSTALLER } from './download'
import PrivacyStorageDialog from './PrivacyStorageDialog'
import { applyTheme, currentTheme, type Theme } from './theme'
import { useInView } from './useInView'

const FACTS = [
  {
    title: 'One database, on your disk',
    body: 'Notes, links and file records live in a local SQLite database. There is no sign-up and no cloud sync.',
  },
  {
    title: 'Passwords under a master key',
    body: 'The password vault is encrypted with AES-256-GCM. Your master password is hashed with Argon2id and never stored.',
  },
  {
    title: 'Nothing gone by accident',
    body: 'Deleted items wait in Trash, and Undo is one click away. Restore puts them back where they were.',
  },
  {
    title: 'Backups you hold',
    body: 'Write a backup file whenever you like and restore it on this PC or a new one.',
  },
]

// Same settings as the app's page headers (`src/app/PageHeader.tsx`).
// The feature grid reuses the app's components and demo data, which is most of
// the page's JavaScript. Loading it separately lets the hero appear first.
const Features = lazy(() => import('./Features'))

const TITLE_MOTION = { delay: 30, duration: 0.55, splitType: 'chars' } as const
const TEXT_MOTION = { delay: 25, duration: 0.5, splitType: 'words' } as const

/** The app's theme button: the new palette wipes in as a circle from the button. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  return (
    <AnimatedThemeToggler
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className={`${buttonVariants({ isIconOnly: true, size: 'sm', variant: 'ghost' })} [&_svg]:size-4`}
      theme={theme}
      onThemeChange={(next) => {
        applyTheme(next)
        setTheme(next)
      }}
    />
  )
}

// Canvas cannot read CSS variables, so the muted text color is resolved from the theme.
function readMuted() {
  return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#71717a'
}

/** The app's dot field, behind the hero and demo, fading out toward the bottom. */
function HeroDots() {
  const ref = useRef<HTMLDivElement>(null)
  // The dot field redraws every frame, so it only runs while it is on screen.
  const inView = useInView(ref, '0px')
  const [color, setColor] = useState(readMuted)

  useEffect(() => {
    const observer = new MutationObserver(() => setColor(readMuted()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} aria-hidden="true" className="kivo-hero-dots pointer-events-none absolute inset-x-0 top-0 -z-10 h-[64rem] opacity-20">
      {inView ? (
        <DotField
          bulgeStrength={67}
          dotRadius={1.5}
          dotSpacing={14}
          glowRadius={0}
          gradientFrom={color}
          gradientTo={color}
        />
      ) : null}
    </div>
  )
}

export default function Landing() {
  return (
    <>
      <div className="sticky top-0 z-20">
        {/* Progressive blur over the scrolling page, as in the app navbar. */}
        <GradualBlur curve="bezier" divCount={6} exponential height="100%" position="top" strength={2.5} zIndex={-1} />
        <nav aria-label="Main" className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a className="flex items-center gap-2 rounded-md font-semibold" href="#top">
            <KivoMark className="h-5 w-auto text-foreground" />
            Kivo
          </a>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </nav>
      </div>

      <main id="top" className="relative isolate">
        <HeroDots />

        <section className="mx-auto max-w-6xl px-4 pt-16 pb-16 sm:px-6 sm:pt-24 sm:pb-20">
          <KivoMark className="kivo-mark-hero h-12 w-auto overflow-visible text-foreground sm:h-14" />
          <SplitText
            {...TITLE_MOTION}
            className="mt-8 block max-w-4xl pb-[0.12em] text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance"
            tag="h1"
            text="Everything important, in one place."
          />
          <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,34rem)_auto] md:items-end md:justify-between">
            <SplitText
              {...TEXT_MOTION}
              className="block text-lg leading-relaxed text-pretty text-muted"
              text="Kivo is a personal vault for Windows. Your notes, links, files and passwords sit together in one calm app, stored on your own computer and nowhere else."
            />
            <div className="kivo-rise grid gap-2 md:justify-items-end">
              <a className={buttonVariants({ size: 'lg', variant: 'primary' })} download href={INSTALLER.href}>
                <Windows11 aria-hidden="true" className="size-4 [&_path]:fill-current" />
                Download for Windows
              </a>
              <span className="text-sm text-muted">
                Version {INSTALLER.version} · Windows 10 and 11, 64-bit
              </span>
            </div>
          </div>
        </section>

        <section id="demo" aria-labelledby="demo-heading" className="mx-auto max-w-6xl scroll-mt-16 px-4 pb-24 sm:px-6 sm:pb-36">
          <h2 id="demo-heading" className="mb-4 text-base font-semibold">
            Try it here
          </h2>
          <KivoDemo />
        </section>

        {/* Holds the grid's height while it loads, so nothing below jumps. */}
        <Suspense fallback={<div className="min-h-[82rem] lg:min-h-[76rem]" />}>
          <Features />
        </Suspense>

        <section aria-labelledby="local-heading" className="border-t border-separator bg-background">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-24 sm:px-6 sm:py-36 lg:grid-cols-[minmax(0,22rem)_1fr]">
            <SplitText
              {...TITLE_MOTION}
              className="block self-start text-3xl leading-tight font-semibold tracking-[-0.02em] text-balance"
              id="local-heading"
              tag="h2"
              text="Your vault stays on your computer."
            />
            <dl className="grid gap-x-12 gap-y-10 sm:grid-cols-2">
              {FACTS.map((fact) => (
                <div key={fact.title} className="kivo-reveal grid content-start gap-2">
                  <dt className="font-semibold">{fact.title}</dt>
                  <dd className="leading-relaxed text-muted">{fact.body}</dd>
                </div>
              ))}
              <div className="kivo-reveal grid content-start gap-2 sm:col-span-2">
                <dt className="font-semibold">Made for the keyboard</dt>
                <dd className="leading-relaxed text-muted">
                  Press <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> for the command palette, <Kbd>Ctrl</Kbd> <Kbd>N</Kbd> for a
                  new note, and <Kbd>Ctrl</Kbd> <Kbd>1</Kbd>–<Kbd>6</Kbd> to jump between pages.
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-separator bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-14 pb-10 sm:px-6 md:grid-cols-[minmax(0,2fr)_1fr]">
          <div className="grid content-start gap-3">
            <a className="flex w-fit items-center gap-2 rounded-md font-semibold" href="#top">
              <KivoMark className="h-5 w-auto text-foreground" />
              Kivo
            </a>
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              A personal vault for your notes, links, files and passwords, kept on your own computer.
            </p>
          </div>

          <nav aria-label="Footer" className="grid content-start gap-3 text-sm">
            <h2 className="font-semibold">Explore</h2>
            <a className="w-fit text-muted transition-colors hover:text-foreground" href="#demo">
              Try the demo
            </a>
            <a className="w-fit text-muted transition-colors hover:text-foreground" href="#features-heading">
              Features
            </a>
            <PrivacyStorageDialog />
          </nav>
        </div>

        <div className="border-t border-separator">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted sm:px-6">
            <span>© {new Date().getFullYear()} Kivo · Version {INSTALLER.version}</span>
            <span>The demo runs in your browser only. Nothing you type in it is saved or sent.</span>
          </div>
        </div>
      </footer>

      <Toast.Provider placement="bottom" />
    </>
  )
}
