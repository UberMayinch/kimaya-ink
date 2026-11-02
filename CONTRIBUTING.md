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
photos.json     list of photos
photos/         the images
CNAME           custom domain
```

## changing css/js

GitHub Pages caches files for ~10 minutes. When you change `style.css`, `script.js` or `camera.js`, bump the `?v=` number on its tag in `index.html` so visitors don't get new HTML with old styles.
