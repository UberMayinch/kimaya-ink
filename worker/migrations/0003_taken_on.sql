-- day a photo or clip was actually taken (exif or typed by the owner), "YYYY-MM-DD", null if unknown.
-- only for databases made before this change; new databases get the column from schema.sql.
ALTER TABLE posts ADD COLUMN taken_on TEXT;
