-- SHA-256 of a managed file's plaintext bytes, used to spot the same file
-- imported twice. Stored as 32 raw bytes while content encryption is off and
-- as AES-GCM ciphertext while it is on. Older rows stay NULL until a duplicate
-- check fills them in.
ALTER TABLE files ADD COLUMN content_digest BLOB;

-- Whether pasting a link into a source fetches the page title and description.
ALTER TABLE preferences ADD COLUMN link_details INTEGER NOT NULL DEFAULT 1 CHECK (link_details IN (0, 1));
