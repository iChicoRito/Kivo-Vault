-- Each credential is stored as one encrypted blob holding every field. The old
-- readable columns stay for SQLite compatibility but are left blank. Rows from
-- older versions are converted the next time the vault is unlocked, because
-- only then is the key available.
ALTER TABLE credentials ADD COLUMN data_nonce BLOB;
ALTER TABLE credentials ADD COLUMN data_ciphertext BLOB;
