# Scribbles Poster

Collaborative printable poster app for a public URL.

## Local

```bash
npm install
npm run dev
```

Without Blob credentials, the app uses in-memory storage for local testing.

## Vercel Blob

Production uses the existing production Blob token:

```bash
BLOB_READ_WRITE_TOKEN=...
```

Development uses the dev Blob store first:

```bash
BLOB_DEV_STORE_ID=store_ypzhkEGcHaKxGdfj
VERCEL_OIDC_TOKEN=...
```

Run this to refresh local env values from Vercel:

```bash
vercel env pull .env.local --environment development --scope phamous-labs2 --yes
```

If the dev store has a read-write token enabled later, `BLOB_DEV_READ_WRITE_TOKEN` also works and takes precedence over OIDC locally.

The app stores:

- `cells/{cellId}.json` full drawing data
- `locks/draw-order.json` transient lock for sequential draw order

## Config

Poster settings live in `src/lib/poster-config.ts`.

The default is 24in x 36in portrait, 4in title, and a 2in target cell size, yielding a 12 x 16 grid.
If the poster dimensions do not divide evenly, the app computes the best integer grid that keeps cells at least the target size, then centers the fitted square grid.

## Admin Print

Print/export controls are hidden unless the URL includes:

```text
?print=1
```
