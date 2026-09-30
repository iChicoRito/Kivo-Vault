import { useState } from 'react'
import { Card, Description, Label, Radio, RadioGroup, Separator, Switch, Typography } from '@heroui/react'

import { usePreferences } from '../../app/preferences'

const CLEAR_SECONDS = [0, 30, 60, 120]
const CLEAR_LABELS: Record<number, string> = { 0: 'Never', 30: '30 sec', 60: '1 min', 120: '2 min' }
const CLEAR_HINTS: Record<number, string> = {
  0: 'Stays until you copy something else',
  30: 'Enough time to paste it once',
  60: 'For slower sign-in pages',
  120: 'For sign-ins that take a while',
}

const SAVE_ERROR = 'Could not save this setting. Try again.'

export default function ClipboardSettings() {
  const { preferences, updatePreferences } = usePreferences()
  const [error, setError] = useState<string | null>(null)

  function save(patch: Parameters<typeof updatePreferences>[0]) {
    setError(null)
    void updatePreferences(patch).catch(() => setError(SAVE_ERROR))
  }

  return (
    <Card aria-labelledby="clipboard-title">
      <Card.Content className="grid gap-4">
        <div className="grid gap-1">
          <Typography className="text-lg font-semibold" id="clipboard-title" type="h2">
            Copied passwords
          </Typography>
          <Typography color="muted" type="body-sm">
            Choose what happens to a password after you copy it.
          </Typography>
        </div>

        <RadioGroup
          className="grid gap-3"
          name="clipboard-clear"
          variant="secondary"
          value={String(preferences.clipboardClearSeconds)}
          onChange={(value) => save({ clipboardClearSeconds: Number(value) })}
        >
          <div className="grid gap-0.5">
            <Label className="text-base font-medium">Clear from the clipboard</Label>
            <Description className="text-sm">
              Kivo only clears it if the password is still on the clipboard.
            </Description>
          </div>
          {/* Same card choices as the auto-lock setting in App lock. */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {CLEAR_SECONDS.map((seconds) => (
              <Radio
                key={seconds}
                value={String(seconds)}
                className="relative mt-0! flex min-h-11 cursor-pointer flex-col gap-1 rounded-2xl border border-default bg-surface p-3 transition-colors duration-200 ease-out hover:bg-surface-hover data-[selected=true]:border-accent data-[selected=true]:bg-accent/5 data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-offset-2 data-[focus-visible=true]:outline-focus"
              >
                {/* The overlay stretches the click area over the whole card. */}
                <Radio.Content className="static after:absolute after:inset-0 after:rounded-2xl">
                  <Radio.Control>
                    <Radio.Indicator />
                  </Radio.Control>
                  <span className="font-semibold">{CLEAR_LABELS[seconds]}</span>
                </Radio.Content>
                <Description className="text-xs">{CLEAR_HINTS[seconds]}</Description>
              </Radio>
            ))}
          </div>
        </RadioGroup>

        <Separator />

        <div className="grid gap-1">
          <Switch
            aria-describedby="clipboard-history-hint"
            className="w-full"
            isSelected={preferences.clipboardExcludeHistory}
            onChange={(enabled) => save({ clipboardExcludeHistory: enabled })}
          >
            <Switch.Content className="w-full justify-between">
              <span className="font-medium">Keep copied passwords out of clipboard history</span>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
          <Typography color="muted" id="clipboard-history-hint" type="body-sm">
            Windows only. Copied passwords will not show in Win+V or sync to your other devices.
          </Typography>
        </div>

        {error ? (
          <Typography role="alert" className="text-danger" type="body-sm">
            {error}
          </Typography>
        ) : null}
      </Card.Content>
    </Card>
  )
}
