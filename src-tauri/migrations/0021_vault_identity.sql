-- Each vault database carries its own identity, so the vault list can name
-- it and a backup can only be restored into the vault it came from.
CREATE TABLE vault_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  uid TEXT NOT NULL
);

INSERT INTO vault_identity (id, uid) VALUES (1, lower(hex(randomblob(16))));
