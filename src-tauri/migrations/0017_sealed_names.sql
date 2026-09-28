-- While content encryption is on, collection names and note version titles are
-- stored encrypted here and the readable columns are blanked.
ALTER TABLE collections ADD COLUMN name_secret BLOB;
ALTER TABLE item_versions ADD COLUMN title_secret BLOB;
