-- a letter: the words of a post that has no picture (its photo blob is empty).
-- only for databases made before this change; new databases get the column from schema.sql.
ALTER TABLE posts ADD COLUMN text TEXT;
