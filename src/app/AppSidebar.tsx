import { Fragment, useEffect, useRef, useState, type Key } from 'react'

import {
  Avatar,
  Button,
  buttonVariants,
  Dropdown,
  Label,
  Link,
  RouterProvider,
  ScrollShadow,
  Separator,
  Surface,
  Tooltip,
  Typography,
} from '@heroui/react'
import { LockIcon, Logout01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { matchPath, useHref, useLocation, useNavigate } from 'react-router-dom'

import { loadProfile, type Profile } from '../data/settings'
import { hasAppLock } from '../data/security'
import { notifyError } from '../lib/feedback'
import { cn } from '../lib/utils'
import { useScrollDrag } from './AppDock'
import { useLock } from './lock'
import { navigationGroups } from './navigation'

function initials(name: string) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')
  return letters || 'K'
}

// Footer of the sidebar: who owns this vault, with a menu to lock Kivo or
// quit the app. The profile is re-read on navigation so a name saved in
// Settings shows up here without a restart.
function SidebarProfile({ pathname }: { pathname: string }) {
  const appLock = useLock()
  const [profile, setProfile] = useState<Profile | null>(null)
  // Lock Kivo only makes sense with an app lock (Master Password) to unlock with.
  const [hasLock, setHasLock] = useState(false)

  useEffect(() => {
    let active = true
    void loadProfile()
      .then((loaded) => {
        if (active) setProfile(loaded)
      })
      .catch(() => {})
    void hasAppLock()
      .then((value) => {
        if (active) setHasLock(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [pathname])

  const ownerName = profile?.ownerName || 'Kivo'

  function handleAction(key: Key) {
    if (key === 'lock') {
      void appLock?.lock()
    } else if (key === 'quit') {
      // Closing the only window ends the app.
      void getCurrentWindow()
        .close()
        .catch(() => notifyError('Kivo could not quit. Close the window instead.'))
    }
  }

  return (
    <div className="p-3">
      <Dropdown>
        <Button
          aria-label={`Profile menu for ${ownerName}`}
          className="h-auto justify-start gap-3 px-2 py-2 max-[52.5rem]:justify-center max-[52.5rem]:px-0"
          fullWidth
          variant="ghost"
        >
          <Avatar color="accent" size="sm" variant="soft">
            <Avatar.Fallback>{initials(ownerName)}</Avatar.Fallback>
          </Avatar>
          <span className="grid min-w-0 text-left max-[52.5rem]:sr-only">
            <span className="truncate text-sm font-semibold text-foreground">{ownerName}</span>
            {profile?.vaultName ? (
              <span className="truncate text-xs font-normal text-muted">{profile.vaultName}</span>
            ) : null}
          </span>
        </Button>
        <Dropdown.Popover className="min-w-48" placement="top start">
          <Dropdown.Menu onAction={handleAction}>
            {appLock && hasLock ? (
              <Dropdown.Item id="lock" textValue="Lock Kivo">
                <HugeiconsIcon aria-hidden="true" icon={LockIcon} size={16} />
                <Label>Lock Kivo</Label>
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item id="quit" textValue="Quit Kivo" variant="danger">
              <HugeiconsIcon aria-hidden="true" className="text-danger" icon={Logout01Icon} size={16} />
              <Label>Quit Kivo</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  )
}

// The sidebar is the other navigation style, picked in Settings > Appearance.
// It shares `navigationGroups` with the dock and is built from HeroUI parts:
// HeroUI has no sidebar component. The router provider lets HeroUI links
// navigate inside the app instead of reloading the page.
export default function AppSidebar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const navRef = useRef<HTMLElement>(null)
  useScrollDrag(navRef)

  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      <nav
        ref={navRef}
        aria-label="Primary navigation"
        className="h-full w-63 shrink-0 py-3 pl-3 max-[52.5rem]:w-21"
        id="kivo-sidebar"
      >
        {/* Floating panel: inset from the window edges with rounded corners
            and the HeroUI surface shadow. Dark mode has no surface shadow,
            so the border keeps the panel's edge visible there. */}
        <Surface className="flex h-full flex-col overflow-hidden rounded-3xl border border-separator shadow-surface">
          <ScrollShadow hideScrollBar className="min-h-0 flex-1 px-3 py-4">
            {navigationGroups.map((group, index) => (
              <Fragment key={group.label}>
                {index > 0 ? <Separator className="my-3" /> : null}
                <div className="grid gap-1">
                  {/* Group names read as section labels on wide windows; the
                    narrow icon rail keeps them for screen readers only. The
                    first group (KIVO) goes unlabelled: it is the app itself. */}
                  {index > 0 ? (
                    <Typography
                      className="px-3 pb-1 max-[52.5rem]:sr-only"
                      color="muted"
                      type="body-xs"
                      weight="bold"
                    >
                      {group.label}
                    </Typography>
                  ) : null}
                  {group.links.map((link) => {
                    const isActive = matchPath({ path: link.to, end: true }, pathname) !== null

                    return (
                      <Tooltip.Root key={link.to} delay={300}>
                        <Link
                          aria-current={isActive ? 'page' : undefined}
                          className={cn(
                            buttonVariants({
                              fullWidth: true,
                              variant: isActive ? 'primary' : 'ghost',
                            }),
                            'justify-start gap-3 no-underline hover:no-underline max-[52.5rem]:justify-center max-[52.5rem]:px-0',
                            !isActive && 'text-foreground',
                          )}
                          href={link.to}
                        >
                          <HugeiconsIcon
                            aria-hidden="true"
                            icon={link.icon}
                            size={20}
                            strokeWidth={1.75}
                          />
                          <span className="truncate max-[52.5rem]:sr-only">{link.label}</span>
                        </Link>
                        {/* Labels are visible on wide windows, so the tooltip only
                          shows on the icon rail. */}
                        <Tooltip.Content className="min-[52.5rem]:hidden" placement="right">
                          {link.label}
                        </Tooltip.Content>
                      </Tooltip.Root>
                    )
                  })}
                </div>
              </Fragment>
            ))}
          </ScrollShadow>
          <Separator />
          <SidebarProfile pathname={pathname} />
        </Surface>
      </nav>
    </RouterProvider>
  )
}
