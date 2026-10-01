-- Each encrypted vault (content, passwords) gets its own identity and a
-- random data key. The data key is never stored; only wrapped copies of it
-- ("slots"), one per unlock method. Existing vaults keep their older format
-- until their next successful unlock, because an unauthenticated schema
-- upgrade cannot read their keys.
CREATE TABLE vault_keys (
  scope TEXT PRIMARY KEY CHECK (scope IN ('content', 'passwords')),
  vault_id TEXT NOT NULL UNIQUE,
  key_generation TEXT NOT NULL,
  format INTEGER NOT NULL CHECK (format = 1),
  key_check BLOB NOT NULL
);

CREATE TABLE vault_key_slots (
  scope TEXT NOT NULL REFERENCES vault_keys(scope) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('password', 'recovery')),
  slot_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (scope, method)
);
