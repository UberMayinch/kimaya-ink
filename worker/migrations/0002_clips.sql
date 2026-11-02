-- movie mode: optional short clip per post. run once on databases made before clips existed.
-- fresh installs get these columns from schema.sql, so don't run this on them.
ALTER TABLE posts ADD COLUMN clip BLOB;
ALTER TABLE posts ADD COLUMN clip_type TEXT;
