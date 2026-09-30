import type { ReactNode } from 'react'
import { Modal } from '@heroui/react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

export type DialogTone = 'default' | 'warning' | 'danger'

const TONE_CLASS: Record<DialogTone, string> = {
  default: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
}

export type DialogHeaderProps = {
  icon: IconSvgElement
  title: ReactNode
  description?: ReactNode
  tone?: DialogTone
  className?: string
  titleClassName?: string
}

/** The shared top of every dialog: an icon for what it is about, the title, and one line on it. */
export function DialogHeader({
  icon,
  title,
  description,
  tone = 'default',
  className,
  titleClassName,
}: DialogHeaderProps) {
  return (
    <Modal.Header className={className}>
      <Modal.Icon aria-hidden="true" className={TONE_CLASS[tone]}>
        <HugeiconsIcon icon={icon} size={20} />
      </Modal.Icon>
      <div className="grid gap-1">
        <Modal.Heading className={titleClassName}>{title}</Modal.Heading>
        {description ? <p className="m-0 text-sm text-muted">{description}</p> : null}
      </div>
    </Modal.Header>
  )
}

export default DialogHeader
