import React, { useRef, type PropsWithChildren } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  motion,
  MotionValue,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react"
import type { MotionProps } from "motion/react"

import { cn } from "@/lib/utils"

export interface DockProps extends VariantProps<typeof dockVariants> {
  className?: string
  iconSize?: number
  iconMagnification?: number
  disableMagnification?: boolean
  iconDistance?: number
  direction?: "top" | "middle" | "bottom"
  children: React.ReactNode
}

const DEFAULT_SIZE = 40
const DEFAULT_MAGNIFICATION = 60
const DEFAULT_DISTANCE = 140
const DEFAULT_DISABLEMAGNIFICATION = false

const dockVariants = cva(
  "group relative mx-auto mt-8 flex h-[58px] w-max items-stretch justify-center"
)

const Dock = React.forwardRef<HTMLDivElement, DockProps>(
  (
    {
      className,
      children,
      iconSize = DEFAULT_SIZE,
      iconMagnification = DEFAULT_MAGNIFICATION,
      disableMagnification = DEFAULT_DISABLEMAGNIFICATION,
      iconDistance = DEFAULT_DISTANCE,
      direction = "middle",
      ...props
    },
    ref
  ) => {
    const mouseX = useMotionValue(Infinity)

    const renderChildren = () => {
      return React.Children.map(children, (child) => {
        if (
          React.isValidElement<DockIconProps>(child) &&
          child.type === DockIcon
        ) {
          return React.cloneElement(child, {
            ...child.props,
            mouseX: mouseX,
            size: iconSize,
            magnification: iconMagnification,
            disableMagnification: disableMagnification,
            distance: iconDistance,
          })
        }
        return child
      })
    }

    return (
      <motion.div
        ref={ref}
        onMouseMove={(e) => mouseX.set(e.pageX)}
        onMouseLeave={() => mouseX.set(Infinity)}
        {...props}
        className={cn(dockVariants({ className }))}
      >
        {/* The glass bar hugs the icons. Hovering widens the gaps between the
            icons; names show in tooltips, so the bar keeps its height. */}
        {/* One fixed blur; only the tint changes on hover, so the blur is never animated. */}
        <div className="absolute inset-x-0 bottom-0 h-[58px] rounded-2xl border backdrop-blur-md transition-colors duration-300 ease-out supports-backdrop-blur:bg-white/10 supports-backdrop-blur:dark:bg-black/10 supports-backdrop-blur:group-hover:bg-white/20 supports-backdrop-blur:dark:group-hover:bg-black/20 supports-backdrop-blur:group-has-[:focus-visible]:bg-white/20 supports-backdrop-blur:dark:group-has-[:focus-visible]:bg-black/20" />
        <div
          className={cn(
            "relative flex justify-center gap-4 p-2 transition-[gap] duration-300 ease-out group-hover:gap-8",
            {
              "items-start": direction === "top",
              "items-center": direction === "middle",
              "items-end": direction === "bottom",
            }
          )}
        >
          {renderChildren()}
        </div>
      </motion.div>
    )
  }
)

Dock.displayName = "Dock"

export interface DockIconProps extends Omit<
  MotionProps & React.HTMLAttributes<HTMLDivElement>,
  "children"
> {
  size?: number
  magnification?: number
  disableMagnification?: boolean
  distance?: number
  mouseX?: MotionValue<number>
  className?: string
  children?: React.ReactNode
  props?: PropsWithChildren
}

const DockIcon = ({
  size = DEFAULT_SIZE,
  magnification = DEFAULT_MAGNIFICATION,
  disableMagnification,
  distance = DEFAULT_DISTANCE,
  mouseX,
  className,
  children,
  ...props
}: DockIconProps) => {
  const ref = useRef<HTMLDivElement>(null)
  const defaultMouseX = useMotionValue(Infinity)

  const distanceCalc = useTransform(mouseX ?? defaultMouseX, (val: number) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 }
    return val - bounds.x - bounds.width / 2
  })

  const targetSize = disableMagnification ? size : magnification

  const sizeTransform = useTransform(
    distanceCalc,
    [-distance, 0, distance],
    [size, targetSize, size]
  )

  const scaleSize = useSpring(sizeTransform, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  })

  // The motion box only reserves space; scaling the content is what makes the
  // item nearest the cursor read larger than its neighbours.
  const contentScale = useTransform(scaleSize, (value: number) => value / size)

  return (
    <div className="flex flex-col items-center justify-end gap-1 self-stretch">
      <motion.div
        ref={ref}
        style={{ width: scaleSize, height: scaleSize }}
        className={cn(
          "flex aspect-square shrink-0 cursor-pointer items-center justify-center rounded-full",
          disableMagnification && "hover:bg-muted-foreground transition-colors",
          className
        )}
        {...props}
      >
        <motion.div className="flex items-center justify-center" style={{ scale: contentScale }}>
          {children}
        </motion.div>
      </motion.div>
    </div>
  )
}

DockIcon.displayName = "DockIcon"

export { Dock, DockIcon, dockVariants }
