# Scribbles Poster

Collaborative printable poster app for a public URL.

## Local

```bash
npm install
npm run dev
```

Without `BLOB_READ_WRITE_TOKEN`, the app uses in-memory storage for local testing.

## Vercel Blob

Set this env var in Vercel:

```bash
BLOB_READ_WRITE_TOKEN=...
```

The app stores:

- `cells/{cellId}.json` full drawing data
- `holds/{cellId}.json` active 10-minute cell holds

## Config

Poster settings live in `src/lib/poster-config.ts`.

The default is 24in x 36in portrait, 4in title, and a 2in target cell size, yielding a 12 x 16 grid.
If the poster dimensions do not divide evenly, the app computes the best integer grid that keeps cells at least the target size, then centers the fitted square grid.

## Admin Print

Print/export controls are hidden unless the URL includes:

```text
?print=1
```
