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

## add a letter or a voice note

The camera's memory card holds more than photos. Two more entry types go in `photos.json`:

```json
{ "type": "letter", "date": "2026-11-02", "title": "for your birthday", "by": "your name",
  "text": "dear kimaya,\n\nparagraphs are split on blank lines.\n\n— me" }
```

```json
{ "type": "audio", "file": "photos/note-from-me.m4a", "date": "2026-11-02",
  "caption": "a voice note", "by": "your name", "cover": "photos/IMG_1234.jpg" }
```

- `text` is the letter itself, inline. `\n\n` starts a new paragraph. `title` is optional.
- audio files: `m4a`, `mp3`, `ogg` or `wav` in `photos/`, under 3MB. Strip metadata and keep it short:
  ```sh
  ffmpeg -i note.m4a -map_metadata -1 -ac 1 -b:a 64k photos/note-from-me.m4a
  ```
- `cover` is an optional photo shown behind a letter or a voice note on the LCD.

Letters don't need `file`. Everything else does. CI checks all of it.

## add a movie clip

Prints can loop a short clip, like a 2000s digicam's movie mode. Make it tiny: 320x240, about 8 seconds, sound optional (drop `-c:a aac -b:a 48k` and add `-an` for silent), no metadata (phone video carries GPS too).

```sh
# needs ffmpeg (macOS: brew install ffmpeg). -ss = where to start, -t = how long
ffmpeg -ss 0 -t 8 -i IMG_1234.MOV -map_metadata -1 \
  -vf "scale=320:240:force_original_aspect_ratio=increase,crop=320:240,fps=15" \
  -c:v libx264 -profile:v baseline -crf 30 -pix_fmt yuv420p -c:a aac -b:a 48k -ac 1 -movflags +faststart \
  photos/IMG_1234.mp4
```

That comes out around 300-500KB. Clips loop silently on the LCD and on the page; a tap (OK on the camera) turns the sound on. Then add `"clip"` to the photo's entry. `file` is still required, it's the poster shown before the clip loads:

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

## preview the hero

The hero (`journey.js`) is one continuous zoom: her photograph, into her eye, the camera, its lens, the photograph again. Scroll (or pinch) to move through it, tap her eye or the lens to fly, drag to tilt the photo or turn the camera, Escape to go back. A few query params help while working on it:

| param | what it does |
|---|---|
| `?p=0.47` | freezes the journey at that point (0 photo · 0.3–0.52 her eye · 0.62–0.8 the camera · 0.8–1 the lens) |
| `?demo=1` | fills the memory card with placeholder photos, a letter and a voice note |
| `?calm=1` / `?calm=0` | forces reduced motion on / off (explicit NEXT / BACK buttons appear under calm) |
| `?dead=1` | forces the no-WebGL fallback: the still photo with the plain page under it |
| `?api=http://127.0.0.1:8788/api` | on localhost only: talk to a different local worker (e.g. one started from a worktree on another port). works on `/admin.html` too |

Serve with a `Cache-Control: no-store` server while editing `experience/*.js`, or bump `?v=` (below). Port 8000 is often taken; any port works.

## layout

```
index.html      page
style.css       the digicam look
script.js       renders photos.json
clips.js        movie mode: records + plays the little clips
songs.js        song chips + preview player (window.KimayaSongs)
songs.css       song chip look
dev/            test pages, e.g. dev/songs-demo.html
journey.js      the hero: her photograph -> her eye -> the camera -> its LCD (gallery + booth) -> its lens -> the photograph
experience/     the hero's parts: portrait (2.5D photo), camera-world (the digicam), archive (the LCD), archive-data (what's on the card), post (optics), input
assets/         kimaya.jpg (the photograph), kimaya-depth.png (its depth + layer map), sticker.png (on the camera, and the page's icon)
guestbook-api.js  posting/listing for the guestbook (shared)
uploads.js      prepares uploaded photos/videos (resize, strip metadata, stamp)
drop.js         the share sheet: several photos/videos at once (window event kimaya:drop)
photos.json     list of photos
photos/         the images
CNAME           custom domain
```

## changing css/js

GitHub Pages caches files for ~10 minutes. When you change any css/js file, bump the `?v=` number on its tag in `index.html` so visitors don't get new HTML with old styles. For the hero (`journey.js`, `experience/*.js`, `style.css`) run `tools/bump-version.sh <number>`, which keeps every import in step (CI checks that they agree).

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
npx wrangler d1 execute kimaya-guestbook --local --file migrations/0004_song.sql
npx wrangler d1 execute kimaya-guestbook --local --file migrations/0005_text.sql
# live
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0002_clips.sql
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0003_taken_on.sql
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0004_song.sql
npx wrangler d1 execute kimaya-guestbook --remote --file migrations/0005_text.sql
npx wrangler deploy
```

Each one is an `ALTER TABLE ... ADD COLUMN`, so running it twice fails with `duplicate column name`, which is harmless. Don't run migrations on a database you just made from `schema.sql`; use `d1 execute --file`, not `d1 migrations apply`.

### uploads

Besides the camera, the booth has **⇪ UPLOAD** for an existing photo or short video, and `/admin.html` has **ADD TO GALLERY** for posting many at once. Owner uploads skip the queue and go live immediately. All of it goes through `uploads.js` (`window.KimayaUploads`), in the browser, before anything is sent:

- photos (jpeg, png, webp, heic where the browser can decode it): turned upright, shrunk to 1280px on the long edge, stamped with the date and re-encoded as a JPEG under 200KB. The date comes from the EXIF "date taken", or today if there isn't one; on the admin page you can change it per photo.
- videos: the first 8 seconds are re-recorded at 320x240, 15fps, with their sound (routed through Web Audio, so still nothing of the original file is sent), plus a 640x480 still for the poster. Each clip stays under 800KB. The booth's own video mode records 8 seconds from the camera and the mic (if the mic is refused, the video is silent).

### several at once (the drop)

Visitors can share up to 12 photos and videos in one go from **⇪ SHARE PHOTOS & VIDEOS** on the black below the hero, from **⇪ SHARE PHOTOS** in the fallback guestbook, or by picking more than one file behind the camera's **⇪ FROM MY PHONE**. That's `drop.js`: one name and one note for all of them (each can carry its own caption instead), prepared by `uploads.js` one after another (a video plays through once to make its clip), then sent together with `KimayaGuestbook.postMany` as one `POST /api/posts` with indexed fields (`photo.0`, `clip.0`, `taken_on.0`, `message.0`, …), one Turnstile check, all inserted or none. They queue for approval like any post. The per-ip limit counts posts, 30 an hour, so a drop of 12 and a couple of selfies fit. Against a worker from before drops the client falls back to posting them one at a time.

### notes (letters) from visitors

A note is one more kind of memory, next to a photo and a video: **✎ A NOTE** on the camera's "leave yours" screen (the LCD lays the words out as the letter they'll be, while they're typed) and in the fallback booth. It posts as `name` + `text` (up to 1200 characters, line breaks kept, `message` is an optional title) with no photo; the worker keeps an empty blob in the photo column (`migrations/0005_text.sql` adds `text`). On the LCD it's the same `letter` type as one in `photos.json`: a card in the index, pages in view. On the fallback wall it prints as paper with the words on it, and the admin card shows and edits the words.

### songs on posts

The booth's note form (and the admin uploader) has an optional song title + artist. It is stored on the post and shown as a `♪` chip on the fallback page's prints (the site looks the 30-second preview up on Apple when the chip is pressed, nothing is hosted here). Inside the camera there is no chip: the song's name is written on the LCD, and looking at a memory makes its song the page's song (`KimayaSound.setSong`), crossfading the bed from Pink + White. It stays that way until the next memory with a song.

### editing

On `/admin.html` every card is a form: name, note, date and song can be changed and saved (`PATCH /api/admin/posts/:id`). **APPROVE** puts a queued post on the site, **UNAPPROVE** takes a live one back into the queue, **DELETE** removes it for good. Curated things in `photos.json` are still edited in git.

**Privacy:** every upload is redrawn on a canvas and encoded again, so nothing from the original file reaches the server: no EXIF, no GPS location, no camera details, no original filename. Phone photos carry the exact place they were taken, and these are photos of a real person, so never add a code path that posts the original `File`.

`worker/.dev.vars` (gitignored) holds local test values:

```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ADMIN_TOKEN=local-test-admin-token-0123456789
IP_SALT=local-test-salt
```

When the site runs on `localhost`, it talks to `localhost:8787` automatically.
