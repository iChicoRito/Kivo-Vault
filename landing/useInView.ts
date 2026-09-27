import { useEffect, useState, type RefObject } from 'react'

/**
 * True while the element is on screen (with a margin, so work resumes just
 * before it scrolls in). Lets heavy animation stop when nobody can see it.
 */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px') {
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, rootMargin])

  return inView
}
