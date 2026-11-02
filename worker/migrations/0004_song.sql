-- the song that goes with a post, as json {"title","artist","itunesId"?}, null if none.
-- only for databases made before this change; new databases get the column from schema.sql.
ALTER TABLE posts ADD COLUMN song TEXT;
