import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getTauriInvoke } from './setup'
import type { Credential, CredentialInput, CredentialSummary } from '../data/passwords'

const clipboardMock = vi.hoisted(() => ({ copyText: vi.fn(), copySecret: vi.fn() }))

const feedbackMock = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  trashWithUndo: vi.fn(),
}))

vi.mock('../lib/clipboard', () => clipboardMock)
vi.mock('../lib/feedback', () => feedbackMock)

import { VaultProvider } from '../app/vault'
import PasswordsPage from '../features/passwords/PasswordsPage'

const invoke = getTauriInvoke()

type Handlers = Record<string, (args: Record<string, unknown>) => unknown>

let handlers: Handlers

function stub(command: string, handler: (args: Record<string, unknown>) => unknown) {
  handlers[command] = handler
}

function summary(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: 'cred-1',
    service: 'GitHub',
    username: 'ada@example.com',
    url: 'https://github.com',
    category: 'Development',
    tags: ['dev'],
    isFavorite: false,
    deletedAt: null,
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-02T10:00:00Z',
    ...overrides,
  }
}

function fullCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    ...summary(),
    notes: '',
    password: 's3cret-value',
    ...overrides,
  }
}

function unlockedPage(configured = true, unlocked = true) {
  stub('vault_status', () => ({ configured, unlocked }))
}

function renderPasswords() {
  return render(
    <VaultProvider>
      <MemoryRouter initialEntries={['/passwords']}>
        <PasswordsPage />
      </MemoryRouter>
    </VaultProvider>,
  )
}

// Rows open their action menu on a right click. A service can repeat, so pick
// the first match that sits inside a credential card.
function openRowMenu(service: string) {
  const titleElement = screen
    .getAllByText(service)
    .find((element) => element.closest('.kivo-item-card') !== null)

  if (!titleElement) throw new Error(`The row for "${service}" is missing.`)

  fireEvent.contextMenu(titleElement)
}

function closeConfirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
}

beforeEach(() => {
  handlers = {}
  clipboardMock.copyText.mockReset()
  clipboardMock.copyText.mockResolvedValue(undefined)
  clipboardMock.copySecret.mockReset()
  clipboardMock.copySecret.mockResolvedValue(undefined)
  invoke.mockReset()
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    const handler = handlers[command]

    if (!handler) return Promise.reject(new Error(`Unexpected command: ${command}`))

    try {
      return Promise.resolve(handler(args ?? {}))
    } catch (error) {
      return Promise.reject(error)
    }
  })

  unlockedPage()
  stub('list_credentials', () => [])
  stub('list_tags', () => [])
})

describe('PasswordsPage vault gate', () => {
  it('asks for the master password in a modal when the vault is locked', async () => {
    unlockedPage(true, false)

    renderPasswords()

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Unlock passwords')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Enter your master password to open the vault.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Master Password')).toBeInTheDocument()
  })

  it('shows the unlock failure and keeps the typed password', async () => {
    unlockedPage(true, false)
    stub('unlock_vault', () => {
      throw new Error('Could not unlock the vault')
    })

    renderPasswords()

    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByLabelText('Master Password')
    fireEvent.change(field, { target: { value: 'wrong-password' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByText('Could not unlock the vault')).toBeInTheDocument()
    expect(field).toHaveValue('wrong-password')
  })

  it('unlocks the vault from the modal', async () => {
    unlockedPage(true, false)
    stub('unlock_vault', () => ({ configured: true, unlocked: true }))

    renderPasswords()

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Master Password'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('unlock_vault', {
        masterPassword: 'correct horse battery',
      }),
    )
    expect(await screen.findByLabelText('Search collection')).toBeInTheDocument()
  })

  it('asks for a new master password when the vault is not configured', async () => {
    unlockedPage(false, false)

    renderPasswords()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Create a master password' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('This password encrypts your saved logins. Kivo cannot recover it.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm master password')).toBeInTheDocument()
  })

  it('rejects mismatched passwords without calling the backend', async () => {
    unlockedPage(false, false)

    renderPasswords()

    const password = await screen.findByLabelText('Master password')
    fireEvent.change(password, { target: { value: 'password-one' } })
    fireEvent.change(screen.getByLabelText('Confirm master password'), {
      target: { value: 'password-two' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create and unlock' }))

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('setup_vault', expect.anything())
  })

  it('creates the vault with the typed master password', async () => {
    unlockedPage(false, false)
    stub('setup_vault', () => ({ configured: true, unlocked: true }))

    renderPasswords()

    const password = await screen.findByLabelText('Master password')
    fireEvent.change(password, { target: { value: 'correct horse battery' } })
    fireEvent.change(screen.getByLabelText('Confirm master password'), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create and unlock' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('setup_vault', {
        masterPassword: 'correct horse battery',
      }),
    )
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Password Manager' }),
    ).toBeInTheDocument()
  })
})

describe('PasswordsPage list', () => {
  it('lists services, usernames and monogram avatars', async () => {
    stub('list_credentials', () => [
      summary(),
      summary({ id: 'cred-2', service: 'Bank', username: 'ada', category: 'Banking' }),
    ])

    renderPasswords()

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByText('Bank')).toBeInTheDocument()
    expect(screen.getByText('Development')).toBeInTheDocument()
    expect(screen.getByText('G')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'All passwords' })).toBeInTheDocument()
  })

  it('shows the site icon when the credential has a URL', async () => {
    const icon = 'data:image/png;base64,AAAA'

    stub('list_credentials', () => [summary({ service: 'GitLab', url: 'https://gitlab.com' })])
    stub('credential_icon', (args) => (args.host === 'gitlab.com' ? icon : null))

    renderPasswords()

    await waitFor(() =>
      expect(document.querySelector(`img[src="${icon}"]`)).not.toBeNull(),
    )
    expect(invoke).toHaveBeenCalledWith('credential_icon', { host: 'gitlab.com' })
  })

  it('falls back to the letter when there is no URL', async () => {
    stub('list_credentials', () => [summary({ service: 'Bank', url: '' })])

    renderPasswords()

    expect(await screen.findByText('B')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('credential_icon', expect.anything())
  })

  it('falls back to the letter when no icon is found', async () => {
    stub('list_credentials', () => [summary({ service: 'Netflix', url: 'netflix.com' })])
    stub('credential_icon', () => null)

    renderPasswords()

    expect(await screen.findByText('N')).toBeInTheDocument()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('credential_icon', { host: 'netflix.com' }),
    )
  })

  it('shows the Figma empty state with a create button', async () => {
    renderPasswords()

    expect(await screen.findByText('No Passwords Yet')).toBeInTheDocument()
    expect(
      screen.getByText(
        "You haven't created any password yet. Get started by creating your first password.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Password' })).toBeInTheDocument()
  })

  it('reloads with the query filter as the search term changes', async () => {
    stub('list_credentials', () => [summary()])

    renderPasswords()
    await screen.findByText('GitHub')

    fireEvent.change(screen.getByLabelText('Search collection'), {
      target: { value: 'git' },
    })

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('list_credentials', {
        filter: { trashed: false, query: 'git' },
      }),
    )
  })

  it('shows every saved password without pagination', async () => {
    stub('list_credentials', () =>
      Array.from({ length: 12 }, (_, index) =>
        summary({
          id: `page-${index + 1}`,
          service: `Service ${String(index + 1).padStart(2, '0')}`,
        }),
      ),
    )

    renderPasswords()

    expect(await screen.findByText('Service 01')).toBeInTheDocument()
    expect(screen.getByText('Service 12')).toBeInTheDocument()
    expect(screen.queryByText(/Showing 1 to/)).not.toBeInTheDocument()
  })

  it('shows an error alert with the locked-vault message', async () => {
    stub('list_credentials', () => {
      throw new Error('The password vault is locked')
    })

    renderPasswords()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The password vault is locked')
  })
})

describe('PasswordsPage row actions', () => {
  it('opens the edit dialog when the row is clicked', async () => {
    stub('list_credentials', () => [summary()])
    stub('load_credential', () => fullCredential({ password: 's3cret-value' }))

    renderPasswords()
    await screen.findByText('GitHub')

    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }))

    expect(await screen.findByRole('heading', { name: 'Edit password' })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('load_credential', { id: 'cred-1' })
  })

  it('copies the password from the row menu', async () => {
    stub('list_credentials', () => [summary()])
    stub('load_credential', () => fullCredential({ password: 's3cret-value' }))

    renderPasswords()
    await screen.findByText('GitHub')

    openRowMenu('GitHub')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy password' }))

    await waitFor(() => expect(clipboardMock.copySecret).toHaveBeenCalledWith('s3cret-value'))
  })

  it('shows earlier versions from the row menu and restores one after confirming', async () => {
    stub('list_credentials', () => [summary()])
    stub('list_credential_versions', () => [
      {
        id: 'version-1',
        createdAt: '2026-01-01T10:00:00Z',
        service: 'GitHub',
        username: 'ada@example.com',
        url: 'https://github.com',
        password: 'old-secret',
      },
    ])
    stub('restore_credential_version', () => fullCredential({ password: 'old-secret' }))

    renderPasswords()
    await screen.findByText('GitHub')

    openRowMenu('GitHub')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'History' }))

    const dialog = await screen.findByRole('dialog', { name: 'History: GitHub' })
    expect(within(dialog).queryByText('old-secret')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show' }))
    expect(within(dialog).getByText('old-secret')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this version' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('restore_credential_version', { versionId: 'version-1' }),
    )
  })

  it('imports a password export after review, leaving already saved logins unticked', async () => {
    stub('list_credentials', () => [summary()])
    stub('pick_password_csv', () => 'C:/export.csv')
    stub('preview_password_import', () => ({
      rows: [
        { service: 'github.com', url: 'https://github.com', username: 'ada@example.com', password: 'new', notes: '', duplicateOf: 'cred-1' },
        { service: 'Forum', url: 'https://forum.example', username: 'ada', password: 'forum-pass', notes: '', duplicateOf: null },
      ],
      skipped: 1,
    }))
    stub('import_credentials', () => ({ imported: 1, replaced: 0, failed: [] }))

    renderPasswords()
    await screen.findByText('GitHub')

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import passwords' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file...' }))

    expect(await within(dialog).findByText(/2 logins found, 1 already saved/)).toBeInTheDocument()
    expect(within(dialog).getByText('Already saved')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 login' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('import_credentials', {
        choices: [
          { service: 'Forum', url: 'https://forum.example', username: 'ada', password: 'forum-pass', notes: '', replaceId: null },
        ],
      }),
    )
    expect(await within(dialog).findByText('Delete the exported file now')).toBeInTheDocument()
  })

  it('copies the username from the row menu', async () => {
    stub('list_credentials', () => [summary()])

    renderPasswords()
    await screen.findByText('GitHub')

    openRowMenu('GitHub')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy username' }))

    await waitFor(() => expect(clipboardMock.copyText).toHaveBeenCalledWith('ada@example.com'))
  })

  it('toggles the favorite from the row menu', async () => {
    stub('list_credentials', () => [summary()])

    renderPasswords()
    await screen.findByText('GitHub')

    openRowMenu('GitHub')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to favorites' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_credentials_favorite', {
        ids: ['cred-1'],
        favorite: true,
      }),
    )
  })

  it('removes the favorite from the row menu when the row is already a favorite', async () => {
    stub('list_credentials', () => [summary({ isFavorite: true })])

    renderPasswords()
    await screen.findByText('GitHub')

    openRowMenu('GitHub')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove favorite' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_credentials_favorite', {
        ids: ['cred-1'],
        favorite: false,
      }),
    )
  })

  it('moves a credential to Trash after the confirmation', async () => {
    stub('list_credentials', () => [summary()])
    stub('trash_credentials', () => undefined)

    renderPasswords()
    await screen.findByText('GitHub')

    openRowMenu('GitHub')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to trash' }))

    const heading = await screen.findByRole('heading', { name: 'Move this credential to Trash?' })
    expect(invoke).not.toHaveBeenCalledWith('trash_credentials', expect.anything())

    const dialog = heading.closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move to trash' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('trash_credentials', { ids: ['cred-1'] }),
    )
  })
})

describe('PasswordsPage trash view', () => {
  const trashed = summary({ id: 'cred-9', service: 'Old service', deletedAt: '2026-02-01T10:00:00Z' })

  async function openTrash(service: string) {
    openRowMenu(service)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View Trash' }))
  }

  it('opens the Trash list from the row menu', async () => {
    stub('list_credentials', (args) => {
      const filter = (args.filter ?? {}) as { trashed?: boolean }
      return filter.trashed ? [trashed] : [summary()]
    })

    renderPasswords()
    await screen.findByText('GitHub')

    await openTrash('GitHub')

    expect(await screen.findByText('Old service')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('list_credentials', { filter: { trashed: true } })
    expect(screen.getByRole('list', { name: 'Trashed passwords' })).toBeInTheDocument()
  })

  it('shows the trash empty state with a way back', async () => {
    stub('list_credentials', (args) => {
      const filter = (args.filter ?? {}) as { trashed?: boolean }
      return filter.trashed ? [] : [summary()]
    })

    renderPasswords()
    await screen.findByText('GitHub')

    await openTrash('GitHub')

    expect(await screen.findByText('Trash is Empty')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Passwords' }))

    expect(await screen.findByText('GitHub')).toBeInTheDocument()
  })

  it('restores a trashed credential', async () => {
    stub('list_credentials', () => [trashed])
    stub('restore_credentials', () => undefined)

    renderPasswords()
    await screen.findByText('Old service')
    await openTrash('Old service')

    openRowMenu('Old service')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('restore_credentials', { ids: ['cred-9'] }),
    )
  })

  it('deletes a trashed credential forever only after the confirmation', async () => {
    stub('list_credentials', () => [trashed])
    stub('delete_credentials_permanently', () => undefined)

    renderPasswords()
    await screen.findByText('Old service')
    await openTrash('Old service')

    openRowMenu('Old service')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete forever' }))

    const heading = await screen.findByRole('heading', {
      name: 'Delete this credential forever?',
    })
    expect(invoke).not.toHaveBeenCalledWith('delete_credentials_permanently', expect.anything())

    const dialog = heading.closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('delete_credentials_permanently', { ids: ['cred-9'] }),
    )
  })

  it('cancels a permanent delete without calling the backend', async () => {
    stub('list_credentials', () => [trashed])

    renderPasswords()
    await screen.findByText('Old service')
    await openTrash('Old service')

    openRowMenu('Old service')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete forever' }))
    await screen.findByRole('heading', { name: 'Delete this credential forever?' })

    closeConfirm()

    expect(invoke).not.toHaveBeenCalledWith('delete_credentials_permanently', expect.anything())
  })

  it('returns to the password list from the Trash menu', async () => {
    stub('list_credentials', (args) => {
      const filter = (args.filter ?? {}) as { trashed?: boolean }
      return filter.trashed ? [trashed] : [summary()]
    })

    renderPasswords()
    await screen.findByText('GitHub')
    await openTrash('GitHub')
    await screen.findByText('Old service')

    openRowMenu('Old service')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Back to Passwords' }))

    expect(await screen.findByRole('list', { name: 'All passwords' })).toBeInTheDocument()
  })
})

describe('CredentialDialog', () => {
  async function openDialog() {
    renderPasswords()
    await screen.findByRole('heading', { level: 1, name: 'Password Manager' })

    fireEvent.click(screen.getByRole('button', { name: 'New Password' }))

    return screen.findByRole('heading', { name: 'Add password' })
  }

  it('does not save when the service and password are empty', async () => {
    stub('list_credentials', () => [])

    await openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('A service name is required.')).toBeInTheDocument()
    expect(screen.getByText('A password is required.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('save_credential', expect.anything())
  })

  it('saves a filled credential with the expected input', async () => {
    stub('list_credentials', () => [])
    stub('save_credential', (args) => {
      const input = args.input as CredentialInput
      return fullCredential({ id: 'created-1', ...input })
    })

    await openDialog()

    fireEvent.change(screen.getByLabelText('Service or website'), {
      target: { value: 'GitLab' },
    })
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'ada' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'p@ssw0rd!' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_credential', {
        input: expect.objectContaining({
          service: 'GitLab',
          username: 'ada',
          password: 'p@ssw0rd!',
          category: 'Uncategorized',
          tags: [],
          isFavorite: false,
        }),
      }),
    )
  })

  it('fills the password field from the generator popover', async () => {
    stub('list_credentials', () => [])

    await openDialog()

    // The HeroUI popover trigger wraps the real button in a role="button" div.
    const generate = screen
      .getAllByRole('button', { name: 'Generate password' })
      .find((element) => element.tagName === 'BUTTON')
    if (!generate) throw new Error('The Generate trigger is missing')

    fireEvent.click(generate)
    fireEvent.click(await screen.findByRole('button', { name: 'Use password' }))

    const field = screen.getByLabelText('Password') as HTMLInputElement
    expect(field.value.length).toBeGreaterThan(0)
  })

  it('keeps the reveal and generator controls in the password field group and drops tags', async () => {
    stub('list_credentials', () => [])

    await openDialog()

    const group = document.querySelector('[data-slot="input-group"]')
    expect(group).not.toBeNull()
    expect(group?.querySelector('button[aria-label="Show password"]')).not.toBeNull()
    expect(group?.querySelector('button[aria-label="Generate password"]')).not.toBeNull()
    expect(screen.queryByText('Tags')).not.toBeInTheDocument()
    expect(screen.queryByText('New tag')).not.toBeInTheDocument()
  })
})

describe('Password section tabs', () => {
  it('marks the selected section and draws its underline indicator', async () => {
    renderPasswords()

    const selected = await screen.findByRole('tab', { name: 'Password Vault', selected: true })

    expect(selected.querySelector('[data-slot="tabs-indicator"]')).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Password Generator' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })
})

describe('Password Generator tab', () => {
  async function openGeneratorTab() {
    renderPasswords()

    fireEvent.click(await screen.findByRole('tab', { name: 'Password Generator' }))

    return screen.findByRole('button', { name: 'Copy Password' })
  }

  it('copies the value, regenerates it, and copies the new value', async () => {
    await openGeneratorTab()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Password' }))
    await waitFor(() => expect(clipboardMock.copySecret).toHaveBeenCalledTimes(1))
    const first = clipboardMock.copySecret.mock.calls[0][0] as string
    expect(first.length).toBeGreaterThanOrEqual(8)

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate password' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy Password' }))

    await waitFor(() => expect(clipboardMock.copySecret).toHaveBeenCalledTimes(2))
    const second = clipboardMock.copySecret.mock.calls[1][0] as string
    expect(second).not.toBe(first)
  })

  it('shows Password Length and the option labels', async () => {
    await openGeneratorTab()

    expect(screen.getByText('Password Length')).toBeInTheDocument()
    expect(screen.getByText('Uppercase (A - Z)')).toBeInTheDocument()
    expect(screen.getByText('Lowercase (a - z)')).toBeInTheDocument()
    expect(screen.getByText('Numbers (0 - 9)')).toBeInTheDocument()
    expect(screen.getByText('Symbols (!@#$%)')).toBeInTheDocument()
    expect(screen.getByText('Exclude similar')).toBeInTheDocument()
  })

  it('switches to passphrase mode with a word count control', async () => {
    await openGeneratorTab()

    fireEvent.click(screen.getByRole('tab', { name: 'Passphrase' }))

    expect(await screen.findByText('Words')).toBeInTheDocument()
    expect(screen.getByLabelText('Number of words')).toBeInTheDocument()
  })
})
