import { Link, Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './AppShell'
import PageHeader, { textLinkClass } from './PageHeader'
import DashboardPage from '../features/dashboard/DashboardPage'
import SettingsPage from '../features/settings/SettingsPage'
import { ItemsPage } from '../features/items/ItemsPage'
import { NotesPage } from '../features/notes/NotesPage'
import { NoteEditor } from '../features/notes/NoteEditor'
import { SourcesPage } from '../features/sources/SourcesPage'
import { FilesPage } from '../features/files/FilesPage'
import { CollectionsPage } from '../features/collections/CollectionsPage'
import { FavoritesPage } from '../features/favorites/FavoritesPage'
import { TrashPage } from '../features/trash/TrashPage'
import PasswordsPage from '../features/passwords/PasswordsPage'
import { StorageManagerPage } from '../features/storage/StorageManagerPage'

export function NotFoundPage() {
  return (
    <section aria-labelledby="not-found-title" className="grid gap-8">
      <PageHeader
        description="This Kivo destination does not exist."
        title="Not Found"
        titleId="not-found-title"
      />
      <Link className={textLinkClass} to="/dashboard">
        Return to Dashboard
      </Link>
    </section>
  )
}

export function AppRoutes({ startTour = false }: { startTour?: boolean }) {
  return (
    <Routes>
      <Route element={<AppShell startTour={startTour} />}>
        <Route index element={<Navigate replace to="/dashboard" />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="items" element={<ItemsPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="notes/:id" element={<NoteEditor />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="favorites" element={<FavoritesPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="storage" element={<StorageManagerPage />} />
        <Route path="passwords" element={<PasswordsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default AppRoutes
