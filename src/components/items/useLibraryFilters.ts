import { useCallback, useEffect, useMemo, useState } from 'react'

import { listCollections, type Collection } from '../../data/collections'
import { onCollectionAccessChanged } from '../../data/events'
import type { ItemFilter, ItemKind } from '../../data/items'
import { listTags, type Tag } from '../../data/tags'
import { useVaultChanged } from '../../lib/useVaultChanged'
import type { FilterMenuProps } from './FilterMenu'

export type LibraryFilters = {
  filter: ItemFilter
  menuProps: FilterMenuProps
  hasActiveFilters: boolean
  refreshVersion: number
  reload: () => void
}

export function useLibraryFilters(kind: ItemKind, query = ''): LibraryFilters {
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [optionsState, setOptionsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [optionsAttempt, setOptionsAttempt] = useState(0)

  const reload = useCallback(() => setRefreshVersion((value) => value + 1), [])
  const retryOptions = useCallback(() => setOptionsAttempt((value) => value + 1), [])
  const clearFilters = useCallback(() => {
    setCollectionId(null)
    setTag(null)
    setFavoritesOnly(false)
  }, [])

  useVaultChanged(reload)
  useEffect(() => onCollectionAccessChanged(reload), [reload])

  useEffect(() => {
    let active = true
    setOptionsState('loading')

    Promise.all([listCollections(), listTags()])
      .then(([loadedCollections, loadedTags]) => {
        if (!active) return
        setCollections(loadedCollections)
        setTags(loadedTags)
        setCollectionId((current) =>
          current && loadedCollections.some((entry) => entry.id === current) ? current : null,
        )
        setTag((current) =>
          current && loadedTags.some((entry) => entry.name === current) ? current : null,
        )
        setOptionsState('ready')
      })
      .catch(() => {
        if (active) setOptionsState('error')
      })

    return () => {
      active = false
    }
  }, [refreshVersion, optionsAttempt])

  const trimmedQuery = query.trim()
  const filter = useMemo<ItemFilter>(() => ({
    kind,
    ...(collectionId ? { collectionId } : {}),
    ...(tag ? { tag } : {}),
    ...(favoritesOnly ? { favorite: true } : {}),
    ...(trimmedQuery ? { query: trimmedQuery } : {}),
  }), [kind, collectionId, tag, favoritesOnly, trimmedQuery])

  return {
    filter,
    hasActiveFilters: collectionId !== null || tag !== null || favoritesOnly,
    refreshVersion,
    reload,
    menuProps: {
      kind,
      collectionId,
      tag,
      favoritesOnly,
      collections,
      tags,
      optionsState,
      onCollectionChange: setCollectionId,
      onTagChange: setTag,
      onFavoritesChange: setFavoritesOnly,
      onClear: clearFilters,
      onRetryOptions: retryOptions,
    },
  }
}
