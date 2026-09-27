/*
 * Magic UI Bento Grid.
 * https://magicui.design/docs/components/bento-grid
 *
 * Adapted to this project: the call to action uses HeroUI's button styles and
 * a Hugeicons arrow instead of the shadcn Button and Radix icon, and colors
 * come from HeroUI's theme tokens so both themes work without a `dark:` variant.
 */
import { type ComponentPropsWithoutRef, type ElementType, type MouseEvent, type ReactNode } from "react"
import { buttonVariants } from "@heroui/react"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { cn } from "@/lib/utils"

interface BentoGridProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode
  className?: string
}

interface BentoCardProps extends ComponentPropsWithoutRef<"div"> {
  name: string
  className: string
  background: ReactNode
  Icon: ElementType
  description: string
  href: string
  cta: string
  onCta?: (event: MouseEvent<HTMLAnchorElement>) => void
}

const BentoGrid = ({ children, className, ...props }: BentoGridProps) => {
  return (
    <div
      className={cn("grid w-full auto-rows-[22rem] grid-cols-3 gap-4", className)}
      {...props}
    >
      {children}
    </div>
  )
}

function BentoCta({ href, cta, onCta }: Pick<BentoCardProps, "href" | "cta" | "onCta">) {
  return (
    <a
      className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "pointer-events-auto -ml-3")}
      href={href}
      onClick={onCta}
    >
      {cta}
      <HugeiconsIcon aria-hidden="true" className="rtl:rotate-180" icon={ArrowRight01Icon} size={16} />
    </a>
  )
}

const BentoCard = ({
  name,
  className,
  background,
  Icon,
  description,
  href,
  cta,
  onCta,
  ...props
}: BentoCardProps) => (
  <div
    key={name}
    className={cn(
      "group relative col-span-3 flex flex-col justify-between overflow-hidden rounded-2xl",
      "transform-gpu border border-separator bg-surface shadow-[0_2px_4px_rgb(0_0_0/0.05),0_12px_24px_rgb(0_0_0/0.06)]",
      className
    )}
    {...props}
  >
    <div>{background}</div>
    <div className="p-5">
      <div className="pointer-events-none z-10 flex transform-gpu flex-col gap-1 transition-all duration-300 lg:group-focus-within:-translate-y-10 lg:group-hover:-translate-y-10">
        <Icon className="h-6 w-6 origin-left transform-gpu text-foreground transition-all duration-300 ease-in-out group-hover:scale-75" />
        <h3 className="text-base font-semibold text-foreground">{name}</h3>
        <p className="max-w-lg text-sm text-muted">{description}</p>
      </div>

      <div className="pointer-events-none flex w-full translate-y-0 transform-gpu flex-row items-center pt-2 transition-all duration-300 lg:hidden">
        <BentoCta cta={cta} href={href} onCta={onCta} />
      </div>
    </div>

    <div className="pointer-events-none absolute bottom-0 hidden w-full translate-y-10 transform-gpu flex-row items-center p-5 opacity-0 transition-all duration-300 group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 lg:flex">
      <BentoCta cta={cta} href={href} onCta={onCta} />
    </div>

    <div className="pointer-events-none absolute inset-0 transform-gpu transition-all duration-300 group-hover:bg-foreground/[0.03]" />
  </div>
)

export { BentoCard, BentoGrid }
