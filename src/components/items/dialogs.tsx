import { useEffect, useState } from 'react'
import {
  Button,
  Checkbox,
  CheckboxGroup,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Skeleton,
  TextField,
  Typography,
} from '@heroui/react'

import { Delete02Icon, InformationCircleIcon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'

import { DialogHeader } from '../DialogHeader'
import { listCollections, type Collection } from '../../data/collections'
import { listTags, type Tag } from '../../data/tags'
import { TagSuggestions } from './TagSuggestions'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  tone?: 'danger' | 'default'
  /** Defaults to a bin for danger and an info mark otherwise. */
  icon?: IconSvgElement
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'default',
  icon,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel()
      }}
    >
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <DialogHeader
              description={description}
              icon={icon ?? (tone === 'danger' ? Delete02Icon : InformationCircleIcon)}
              title={title}
              tone={tone}
            />
            <Modal.Footer>
              <Button variant="secondary" onPress={onCancel}>
                Cancel
              </Button>
              <Button variant={tone === 'danger' ? 'danger' : 'primary'} onPress={onConfirm}>
                {confirmLabel}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

type TagPickerProps = {
  value: string[]
  onChange: (next: string[]) => void
  label?: string
  itemId?: string
}

export function TagPicker({ value, onChange, label, itemId }: TagPickerProps) {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let active = true

    listTags()
      .then((loaded) => {
        if (active) setTags(loaded)
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  const options = Array.from(new Set([...tags.map((tag) => tag.name), ...value]))
  const optionList = options.length ? (
    <div className="grid gap-1">
      {options.map((name) => (
        <Checkbox key={name} value={name}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span className="font-semibold">{name}</span>
          </Checkbox.Content>
        </Checkbox>
      ))}
    </div>
  ) : null

  function addTag() {
    const name = draft.trim()
    if (!name) return

    setDraft('')
    if (value.includes(name)) return

    onChange([...value, name])
  }

  return (
    <div className="grid gap-3">
      <CheckboxGroup value={value} onChange={onChange}>
        <Label className={label ? undefined : 'sr-only'}>{label ?? 'Tags'}</Label>
        {loading ? (
          <>
            {optionList}
            <div aria-label="Loading tags" className="grid gap-1" role="status">
              <span className="sr-only">Loading tags</span>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} aria-hidden="true" className="flex items-center gap-2 px-2 py-1">
                  <Skeleton className="size-4 shrink-0 rounded-sm" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </>
        ) : optionList}
      </CheckboxGroup>

      {!loading && options.length === 0 ? (
        <Typography color="muted" type="body-xs">
          No tags yet.
        </Typography>
      ) : null}

      {itemId ? <TagSuggestions itemId={itemId} value={value} onChange={onChange} /> : null}

      <div className="flex flex-wrap items-end gap-2">
        <TextField className="min-w-40 flex-1" value={draft} onChange={setDraft}>
          <Label>New tag</Label>
          <Input fullWidth placeholder="Add a tag" variant="secondary" />
        </TextField>
        <Button variant="secondary" onPress={addTag}>
          Add tag
        </Button>
      </div>
    </div>
  )
}

type CollectionSelectProps = {
  value: string | null
  onChange: (next: string | null) => void
  label?: string
}

const NO_COLLECTION = 'kivo-no-collection'

export function CollectionSelect({ value, onChange, label }: CollectionSelectProps) {
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    listCollections()
      .then((loaded) => {
        if (active) setCollections(loaded)
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <>
      <Select
        aria-label={label ? undefined : 'Collection'}
        selectedKey={value ?? NO_COLLECTION}
        variant="secondary"
        onSelectionChange={(key) =>
          onChange(key === null || key === NO_COLLECTION ? null : String(key))
        }
      >
        {label ? <Label>{label}</Label> : null}
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id={NO_COLLECTION} textValue="No collection">
              No collection
            </ListBox.Item>
            {loading ? (
              <ListBox.Item
                id="kivo-loading-collections"
                isDisabled
                textValue="Loading collections"
              >
                <span className="sr-only">Loading collections</span>
                <div aria-hidden="true" className="grid gap-2 py-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </ListBox.Item>
            ) : (
              collections.map((collection) => (
                <ListBox.Item key={collection.id} id={collection.id} textValue={collection.name}>
                  {collection.name}
                </ListBox.Item>
              ))
            )}
          </ListBox>
        </Select.Popover>
      </Select>
      {loading ? (
        <span aria-label="Loading collections" className="sr-only" role="status">
          Loading collections
        </span>
      ) : null}
    </>
  )
}
