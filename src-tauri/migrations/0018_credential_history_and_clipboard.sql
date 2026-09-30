-- Earlier versions of a credential, sealed with the password vault key like
-- the credential itself. Removed together with the credential.
CREATE TABLE credential_versions (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  data_nonce BLOB NOT NULL,
  data_ciphertext BLOB NOT NULL
);

CREATE INDEX credential_versions_by_credential
  ON credential_versions(credential_id, created_at);

-- Clipboard handling for copied passwords. Both are off by default, so copied
-- passwords stay on the clipboard and show in Win+V until the user opts in.
ALTER TABLE preferences ADD COLUMN clipboard_clear_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preferences ADD COLUMN clipboard_exclude_history INTEGER NOT NULL DEFAULT 0;
