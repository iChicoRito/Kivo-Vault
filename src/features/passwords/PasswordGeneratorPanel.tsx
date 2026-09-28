import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  InputGroup,
  Label,
  NumberField,
  ScrollShadow,
  Slider,
  Switch,
  Tabs,
  TextField,
  Typography,
} from '@heroui/react'
import {
  Copy01Icon,
  MinusSignIcon,
  PlusSignIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { copySecret } from '../../lib/clipboard'
import { notifyError, notifySuccess } from '../../lib/feedback'
import {
  DEFAULT_PASSWORD_OPTIONS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  generatePassphrase,
  generatePassword,
  type PasswordOptions,
} from './generate'

type GeneratorMode = 'password' | 'passphrase'

export type PasswordGeneratorPanelProps = {
  /** When set, the panel shows a "Use password" button that returns the value. */
  onUsePassword?: (password: string) => void
}

const DEFAULT_WORD_COUNT = 5
const MIN_WORDS = 3
const MAX_WORDS = 8

type ToggleOptionKey = 'uppercase' | 'lowercase' | 'numbers' | 'symbols' | 'excludeSimilar'

const TOGGLES: Array<{ key: ToggleOptionKey; label: string }> = [
  { key: 'uppercase', label: 'Uppercase (A - Z)' },
  { key: 'lowercase', label: 'Lowercase (a - z)' },
  { key: 'numbers', label: 'Numbers (0 - 9)' },
  { key: 'symbols', label: 'Symbols (!@#$%)' },
  { key: 'excludeSimilar', label: 'Exclude similar' },
]

export function PasswordGeneratorPanel({ onUsePassword }: PasswordGeneratorPanelProps) {
  const [mode, setMode] = useState<GeneratorMode>('password')
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS)
  const [wordCount, setWordCount] = useState(DEFAULT_WORD_COUNT)
  const [value, setValue] = useState(() => generatePassword(DEFAULT_PASSWORD_OPTIONS))

  const regenerate = useCallback(() => {
    setValue(
      mode === 'passphrase' ? generatePassphrase(wordCount) : generatePassword(options),
    )
  }, [mode, options, wordCount])

  // Every option change, mode switch, and the first mount produce a fresh value.
  useEffect(() => {
    regenerate()
  }, [regenerate])

  function setOption<Key extends ToggleOptionKey>(key: Key, next: boolean) {
    setOptions((current) => ({ ...current, [key]: next }) as PasswordOptions)
  }

  async function handleCopy() {
    try {
      await copySecret(value)
      notifySuccess('Password copied')
    } catch {
      notifyError('Kivo could not copy the password. Try again.')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {/* Full-width rows sit flush with the scrollport, so the padding keeps
          the focused row's ring inside the cut edge. */}
      <ScrollShadow className="-mx-1 -my-1 grid min-h-0 flex-1 gap-6 px-1 py-1 overscroll-contain">
        <Tabs
          className="w-full"
          selectedKey={mode}
          onSelectionChange={(key) => {
            if (key === 'password' || key === 'passphrase') setMode(key)
          }}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="Generator mode">
              <Tabs.Tab className="h-8 flex-1 font-semibold" id="password">
                Password
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="h-8 flex-1 font-semibold" id="passphrase">
                Passphrase
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <TextField isReadOnly value={value}>
          <Label>Password</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input className="min-w-0 font-mono" />
            <InputGroup.Suffix className="px-1.5">
              <Button
                isIconOnly
                aria-label="Regenerate password"
                size="sm"
                variant="tertiary"
                onPress={regenerate}
              >
                <HugeiconsIcon aria-hidden="true" icon={RefreshIcon} size={18} />
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>

        {mode === 'password' ? (
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <Typography color="muted" type="body-sm">
                Password Length
              </Typography>
              <span className="rounded-full bg-default px-3 py-1 text-sm font-semibold tabular-nums">
                {options.length}
              </span>
            </div>
            <Slider
              aria-label="Password length"
              maxValue={MAX_PASSWORD_LENGTH}
              minValue={MIN_PASSWORD_LENGTH}
              step={1}
              value={options.length}
              onChange={(next) => {
                const length = Array.isArray(next) ? next[0] : next
                setOptions((current) => ({ ...current, length }))
              }}
            >
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
          </div>
        ) : (
          <div className="grid gap-2">
            <Typography color="muted" type="body-sm">
              Words
            </Typography>
            <NumberField
              fullWidth
              maxValue={MAX_WORDS}
              minValue={MIN_WORDS}
              step={1}
              value={wordCount}
              variant="secondary"
              onChange={(next) => {
                if (Number.isFinite(next)) setWordCount(Math.round(next))
              }}
            >
              <NumberField.Group className="grid-cols-[auto_1fr_auto]">
                <Button
                  slot="decrement"
                  isIconOnly
                  aria-label="Remove a word"
                  className="ms-1.5"
                  size="sm"
                  variant="tertiary"
                >
                  <HugeiconsIcon aria-hidden="true" icon={MinusSignIcon} size={16} />
                </Button>
                <NumberField.Input aria-label="Number of words" className="text-center" />
                <Button
                  slot="increment"
                  isIconOnly
                  aria-label="Add a word"
                  className="me-1.5"
                  size="sm"
                  variant="tertiary"
                >
                  <HugeiconsIcon aria-hidden="true" icon={PlusSignIcon} size={16} />
                </Button>
              </NumberField.Group>
            </NumberField>
          </div>
        )}

        {mode === 'password' ? (
          <div className="grid gap-3">
            {TOGGLES.map((toggle) => (
              <Switch
                key={toggle.key}
                isSelected={options[toggle.key]}
                onChange={(next) => setOption(toggle.key, next)}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  {toggle.label}
                </Switch.Content>
              </Switch>
            ))}
          </div>
        ) : null}
      </ScrollShadow>

      <div className="grid gap-2">
        <Button className="w-full" onPress={() => void handleCopy()}>
          <HugeiconsIcon aria-hidden="true" icon={Copy01Icon} size={18} />
          Copy Password
        </Button>
        {onUsePassword ? (
          <Button className="w-full" variant="secondary" onPress={() => onUsePassword(value)}>
            Use password
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default PasswordGeneratorPanel
