import { useState } from 'react'
import { Button, Card, Typography } from '@heroui/react'
import { invoke } from '../../data/runtime'
import { exportVaultJson, importJson, importMarkdown, pickFolderDestination, type ImportReport } from '../../data/portability'

export default function PortabilitySettings() {
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [skippedLocked, setSkippedLocked] = useState(0)
  async function run(action: () => Promise<ImportReport | void>) {
    setBusy(true); setError(null); setSkippedLocked(0)
    try { const result = await action(); if (result) setReport(result) }
    catch { setError('Could not finish. Check the file you picked and try again.') }
    finally { setBusy(false) }
  }
  return <Card aria-labelledby="portability-title"><Card.Content className="grid gap-4">
    <div className="grid gap-1">
      <Typography className="text-lg font-semibold" id="portability-title" type="h2">Import and export</Typography>
      <Typography color="muted" type="body-sm">Bring in notes from Markdown files or a Kivo export, or export everything to a folder. Importing only adds items; it never deletes anything.</Typography>
    </div>
    <ul className="grid list-disc gap-1 pl-5 text-sm text-muted">
      <li>Exported files are not encrypted. Keep them somewhere private.</li>
      <li>Items in Trash are not exported.</li>
      <li>Markdown keeps your text but not attached files, formatting, or exact dates.</li>
    </ul>
    <div className="flex flex-wrap gap-3">
      <Button isDisabled={busy} variant="secondary" onPress={() => void run(async () => { const paths = await invoke<string[] | null>('pick_files'); return paths?.length ? importMarkdown(paths) : undefined })}>Import Markdown files</Button>
      <Button isDisabled={busy} variant="secondary" onPress={() => void run(async () => { const path = await invoke<string | null>('pick_file'); return path ? importJson(path) : undefined })}>Import Kivo export</Button>
      <Button isDisabled={busy} onPress={() => void run(async () => { const path = await pickFolderDestination(); if (path) setSkippedLocked((await exportVaultJson(path)) ?? 0) })}>Export everything</Button>
    </div>
    {busy ? <Typography role="status" type="body-sm">Working...</Typography> : null}
    {skippedLocked > 0 ? <Typography role="status" type="body-sm">Left out {skippedLocked} {skippedLocked === 1 ? 'item' : 'items'} in locked collections. Unlock them and export again to include them.</Typography> : null}
    {report ? <div className="grid gap-1 rounded-xl bg-(--default) px-4 py-3" role="status"><Typography type="body-sm" weight="medium">Imported {report.imported} items.</Typography>{report.skipped.map((entry, index) => <Typography key={`${entry.title}-${index}`} type="body-sm">Skipped {entry.title}: {entry.reason}</Typography>)}{report.losses.map((loss) => <Typography key={loss} color="muted" type="body-xs">{loss}</Typography>)}</div> : null}
    {error ? <Typography className="text-danger" role="alert" type="body-sm">{error}</Typography> : null}
  </Card.Content></Card>
}
