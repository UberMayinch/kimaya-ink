# contributing

Everything goes through a pull request. Only @UberMayinch merges to `main`, and merging deploys to https://kimaya.ink.

## add a photo

1. Shrink it and strip its metadata (long edge ~2000px, under 2MB). Phone photos are huge and carry GPS location in their EXIF data, so never commit one straight off a phone.
   ```sh
   # needs imagemagick (macOS: brew install imagemagick)
   magick IMG_1234.jpg -auto-orient -strip -resize 2000x2000\> -quality 85 photos/IMG_1234.jpg
   ```
2. Add an entry to `photos.json`:
   ```json
   [
     {
       "file": "photos/IMG_1234.jpg",
       "date": "2026-11-02",
       "caption": "optional, shows under the print",
       "by": "optional, your name",
       "song": { "title": "Pink + White", "artist": "Frank Ocean" }
     }
   ]
   ```
   `file` and `date` are required. `date` is `YYYY-MM-DD` and becomes the orange stamp. Watch for trailing commas, JSON hates them.

   `song` is optional: the song that goes with the photo. It shows as a little `♪ title — artist` chip on the print and in the viewer, and plays Apple's 30-second preview with a link to the full track in Apple Music. Write `title` and `artist` the way Apple Music does. If it picks the wrong version (a cover, a live take), pin it with `"itunesId": 1146195714`, the number after `?i=` in the Apple Music song link. Never commit audio files; the preview streams from Apple.
3. Open a PR. CI checks the JSON and that every file exists.

## add a movie clip

Prints can loop a short silent clip, like a 2000s digicam's movie mode. Make it tiny: 320x240, about 3 seconds, no sound, no metadata (phone video carries GPS too).

```sh
# needs ffmpeg (macOS: brew install ffmpeg). -ss = where to start, -t = how long
ffmpeg -ss 0 -t 3 -i IMG_1234.MOV -an -map_metadata -1 \
  -vf "scale=320:240:force_original_aspect_ratio=increase,crop=320:240,fps=15" \
  -c:v libx264 -profile:v baseline -crf 30 -pix_fmt yuv420p -movflags +faststart \
  photos/IMG_1234.mp4
```

That comes out around 100-300KB. Then add `"clip"` to the photo's entry. `file` is still required, it's the poster shown before the clip loads:

```json
{ "file": "photos/IMG_1234.jpg", "clip": "photos/IMG_1234.mp4", "date": "2026-11-02" }
```

CI fails if the clip is missing, isn't an `.mp4` in `photos/`, or is 3MB or more.

## preview locally

`fetch` doesn't work from `file://`, so serve the folder:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## layout

```
index.html      page
style.css       the digicam look
script.js       renders photos.json
clips.js        movie mode: records + plays the little clips
songs.js        song chips + preview player (window.KimayaSongs)
songs.css       song chip look
dev/            test pages, e.g. dev/songs-demo.html
journey.js      the scroll journey + the camera (its LCD is the gallery and the booth)
guestbook-api.js  posting/listing for the guestbook (shared)
uploads.js      prepares uploaded photos/videos (resize, strip metadata, stamp)
photos.json     list of photos
photos/         the images
CNAME           custom domain
```

## changing css/js

GitHub Pages caches files for ~10 minutes. When you change any css/js file, bump the `?v=` number on its tag in `index.html` so visitors don't get new HTML with old styles.

## guestbook backend

`worker/` is a Cloudflare Worker (`kimaya-guestbook`) with a D1 database. Visitors post a selfie (or a 3-second movie clip) and a short note from the booth (`booth.js`). Every post waits in a queue until it's approved on `/admin.html`.

```sh
cd worker
npx wrangler d1 execute kimaya-guestbook --local --file schema.sql   # once, on a new database
npx wrangler dev --port 8787                                          # local API, uses .dev.vars
npx wrangler deploy                                                   # ship
```

### migrations

`schema.sql` is the whole current schema, for a brand-new database only. A database that already exists (the live one, or a local one made earlier) gets each change from `worker/migrations/`, in number order, once. Run them **before** `wrangler deploy`, since the new worker reads the new columns:

```sh
cd worker
# local
npx wrangler d1 execute kimaya-guestbook --local --file migrations/0002_clips.sql
npx wrangler d1 execute kimaya-guestbook --local --file migrations/0003_taken_on.sql
# live
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0002_clips.sql
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0003_taken_on.sql
npx wrangler deploy
```

Each one is an `ALTER TABLE ... ADD COLUMN`, so running it twice fails with `duplicate column name`, which is harmless. Don't run migrations on a database you just made from `schema.sql`; use `d1 execute --file`, not `d1 migrations apply`.

### uploads

Besides the camera, the booth has **⇪ UPLOAD** for an existing photo or short video, and `/admin.html` has **ADD TO GALLERY** for posting many at once. Owner uploads skip the queue and go live immediately. All of it goes through `uploads.js` (`window.KimayaUploads`), in the browser, before anything is sent:

- photos (jpeg, png, webp, heic where the browser can decode it): turned upright, shrunk to 1280px on the long edge, stamped with the date and re-encoded as a JPEG under 200KB. The date comes from the EXIF "date taken", or today if there isn't one; on the admin page you can change it per photo.
- videos: the first 5 seconds are re-recorded at 320x240, 15fps, with no sound, plus a 640x480 still for the poster. Each clip stays under 800KB.

**Privacy:** every upload is redrawn on a canvas and encoded again, so nothing from the original file reaches the server: no EXIF, no GPS location, no camera details, no original filename. Phone photos carry the exact place they were taken, and these are photos of a real person, so never add a code path that posts the original `File`.

`worker/.dev.vars` (gitignored) holds local test values:

```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ADMIN_TOKEN=local-test-admin-token-0123456789
IP_SALT=local-test-salt
```

When the site runs on `localhost`, it talks to `localhost:8787` automatically.
