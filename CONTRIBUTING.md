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
songs.js        song chips + preview player (window.KimayaSongs)
songs.css       song chip look
dev/            test pages, e.g. dev/songs-demo.html
photos.json     list of photos
photos/         the images
CNAME           custom domain
```

## changing css/js

GitHub Pages caches files for ~10 minutes. When you change `style.css`, `script.js`, `camera.js`, `songs.js` or `songs.css`, bump the `?v=` number on its tag in `index.html` so visitors don't get new HTML with old styles.

## guestbook backend

`worker/` is a Cloudflare Worker (`kimaya-guestbook`) with a D1 database. Visitors post a selfie and a short note from the booth (`booth.js`). Every post waits in a queue until it's approved on `/admin.html`.

```sh
cd worker
npx wrangler d1 execute kimaya-guestbook --local --file schema.sql   # once
npx wrangler dev --port 8787                                          # local API, uses .dev.vars
npx wrangler deploy                                                   # ship
```

`worker/.dev.vars` (gitignored) holds local test values:

```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ADMIN_TOKEN=local-test-admin-token-0123456789
IP_SALT=local-test-salt
```

When the site runs on `localhost`, it talks to `localhost:8787` automatically.
