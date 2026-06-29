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

The default is 24in x 36in portrait, 4in title, 4in cells, yielding a 6 x 8 grid.

## Admin Print

Print/export controls are hidden unless the URL includes:

```text
?print=1
```
