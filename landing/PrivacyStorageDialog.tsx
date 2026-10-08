import { Button, Link, Modal } from '@heroui/react'

const SECTIONS = [
  {
    title: 'Stored on your computer',
    body: 'Your desktop vault uses a local database and a folder for imported files. Kivo does not require an account or sync your vault to a cloud service.',
  },
  {
    title: 'Password protection and encryption',
    body: 'The password vault encrypts saved credentials. App lock and vault encryption are separate settings: locking the app does not, by itself, encrypt your notes and files.',
  },
  {
    title: 'When Kivo connects to websites',
    body: 'Fetching link details or website icons makes requests to those websites. Local storage does not mean every feature stays offline. The websites receiving those requests can see your IP address.',
  },
  {
    title: 'Backups and deleted items',
    body: 'You choose where to save backups. Keep backup copies somewhere you trust. Deleted items stay in Trash until permanently removed; existing backups may still contain earlier copies.',
  },
  {
    title: 'This website and demo',
    body: 'The demo keeps changes in browser memory and resets when reloaded. It does not access your desktop vault. This website saves your theme preference in your browser.',
  },
]

export default function PrivacyStorageDialog() {
  return (
    <Modal>
      <Link className="w-fit text-sm font-normal text-muted no-underline transition-colors hover:text-foreground">
        Privacy and storage
      </Link>
      <Modal.Backdrop>
        <Modal.Container scroll="inside" size="lg">
          <Modal.Dialog className="max-w-[600px]">
            {({ close }) => (
              <>
                <Modal.CloseTrigger aria-label="Close privacy details" className="min-h-11 min-w-11" />
                <Modal.Header className="pr-12">
                  <Modal.Heading>Privacy and storage</Modal.Heading>
                  <p className="text-sm leading-relaxed text-muted">
                    How Kivo stores your data, protects it, and uses network connections.
                  </p>
                </Modal.Header>
                <Modal.Body className="grid gap-6 py-4">
                  {SECTIONS.map((section) => (
                    <section key={section.title} className="grid gap-2">
                      <h3 className="text-sm font-semibold">{section.title}</h3>
                      <p className="text-sm leading-relaxed text-muted">{section.body}</p>
                    </section>
                  ))}
                </Modal.Body>
                <Modal.Footer>
                  <Button className="min-h-11" variant="secondary" onPress={close}>
                    Close
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
