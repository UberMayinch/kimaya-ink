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
       "by": "optional, your name"
     }
   ]
   ```
   `file` and `date` are required. `date` is `YYYY-MM-DD` and becomes the orange stamp. Watch for trailing commas, JSON hates them.
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
photos.json     list of photos
photos/         the images
CNAME           custom domain
```

## changing css/js

GitHub Pages caches files for ~10 minutes. When you change `style.css`, `script.js`, `clips.js`, `booth.js` or `camera.js`, bump the `?v=` number on its tag in `index.html` so visitors don't get new HTML with old styles.

## guestbook backend

`worker/` is a Cloudflare Worker (`kimaya-guestbook`) with a D1 database. Visitors post a selfie (or a 3-second movie clip) and a short note from the booth (`booth.js`). Every post waits in a queue until it's approved on `/admin.html`.

```sh
cd worker
npx wrangler d1 execute kimaya-guestbook --local --file schema.sql   # once
npx wrangler dev --port 8787                                          # local API, uses .dev.vars
npx wrangler deploy                                                   # ship
```

### migrations

`schema.sql` is always the full current schema, for fresh databases. Databases made before a change need its file in `worker/migrations/`, once, before deploying the worker that uses it:

```sh
cd worker
# 0002: movie clips (clip, clip_type columns)
npx wrangler d1 execute kimaya-guestbook --local  --file migrations/0002_clips.sql
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0002_clips.sql
npx wrangler deploy
```

Order matters: migrate remote, then `wrangler deploy`, then merge the site. The new worker reads the `clip` column, so it errors on an unmigrated database, and the old worker rejects movie posts as too big. Running a migration twice fails with "duplicate column name", which is harmless.

`worker/.dev.vars` (gitignored) holds local test values:

```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ADMIN_TOKEN=local-test-admin-token-0123456789
IP_SALT=local-test-salt
```

When the site runs on `localhost`, it talks to `localhost:8787` automatically.
