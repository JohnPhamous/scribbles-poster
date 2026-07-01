import { del, get, list, put } from "@vercel/blob";
import { posterConfig } from "./poster-config";
import { renderCellDrawing } from "./rendered-drawing";
import type { CellDrawing, PosterSnapshot } from "./types";

const cellPrefix = "cells/";
const lockPrefix = "locks/";
const compactSnapshotPath = "snapshots/poster-compact.json";
const blobAccess = "private";
const drawOrderLockPath = `${lockPrefix}draw-order.json`;
const drawOrderLockTtlMs = 8_000;
const drawOrderLockWaitMs = 6_000;
const drawOrderLockRetryMs = 120;

type BlobAuthOptions = {
  oidcToken?: string;
  storeId?: string;
  token?: string;
};

type MemoryStore = {
  cells: Map<string, CellDrawing>;
};

const memoryStore = ((globalThis as typeof globalThis & { __scribblePosterMemory?: MemoryStore }).__scribblePosterMemory ??= {
  cells: new Map<string, CellDrawing>(),
});
const memoryCells = memoryStore.cells;
const cellsListCacheMs = 1_200;

export const hasPersistentStorage = hasBlobCredentials();

let cellsCache: { expiresAt: number; value: CellDrawing[] } | null = null;

type BlobLock = {
  token: string;
  expiresAt: string;
};

export async function listCells(options?: { bypassCache?: boolean }): Promise<CellDrawing[]> {
  const blobAuth = getBlobAuthOptions();
  if (!blobAuth) {
    return Array.from(memoryCells.values());
  }

  if (!options?.bypassCache && cellsCache && cellsCache.expiresAt > Date.now()) {
    return cellsCache.value;
  }

  const blobs = await list({ ...blobAuth, prefix: cellPrefix, limit: 1000 });
  const drawings = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellDrawing>(blob.pathname)),
  );

  const value = drawings.filter(isPresent);
  cellsCache = { expiresAt: Date.now() + cellsListCacheMs, value };
  return value;
}

export async function getCompactPosterSnapshot(): Promise<PosterSnapshot | null> {
  const blobAuth = getBlobAuthOptions();
  if (!blobAuth) return null;

  const snapshot = await readJson<PosterSnapshot>(compactSnapshotPath);
  if (!isValidPosterSnapshot(snapshot)) return null;
  return withFreshSnapshotEnvelope(snapshot);
}

export async function rebuildCompactPosterSnapshot(options?: {
  write?: boolean;
}): Promise<PosterSnapshot> {
  const cells = await listCells({ bypassCache: true });
  const snapshot = makeCompactPosterSnapshot(cells);

  if (options?.write && hasBlobCredentials()) {
    await put(compactSnapshotPath, JSON.stringify(snapshot), {
      ...getRequiredBlobAuthOptions(),
      access: blobAccess,
      contentType: "application/json",
      allowOverwrite: true,
    });
  }

  return snapshot;
}

export async function getCell(id: string, options?: { retry?: boolean }): Promise<CellDrawing | null> {
  if (!hasBlobCredentials()) return memoryCells.get(id) ?? null;
  const attempts = options?.retry ? 6 : 1;
  for (let index = 0; index < attempts; index += 1) {
    const cell = await getCellFast(id);
    if (cell) return cell;
    if (index < attempts - 1) await sleep(500);
  }
  return null;
}

export async function getCellFast(id: string): Promise<CellDrawing | null> {
  if (!hasBlobCredentials()) return memoryCells.get(id) ?? null;
  return readJson<CellDrawing>(`${cellPrefix}${id}.json`);
}

export async function saveCell(drawing: CellDrawing): Promise<CellDrawing | "occupied"> {
  if (!hasBlobCredentials()) {
    const existing = await getCell(drawing.id);
    if (existing) return "occupied";
    const nextDrawing = {
      ...drawing,
      drawOrder: await getNextDrawOrder(),
    };
    memoryCells.set(drawing.id, nextDrawing);
    invalidateCellsCache();
    return nextDrawing;
  }

  return withDrawOrderLock(async () => {
    const existing = await getCell(drawing.id);
    if (existing) return "occupied";
    const nextDrawing = {
      ...drawing,
      drawOrder: await getNextDrawOrder(),
    };

    try {
      await put(`${cellPrefix}${drawing.id}.json`, JSON.stringify(nextDrawing), {
        ...getRequiredBlobAuthOptions(),
        access: blobAccess,
        contentType: "application/json",
        allowOverwrite: false,
      });
    } catch (error) {
      if (isBlobConflictError(error)) {
        return "occupied";
      }
      throw error;
    }
    invalidateCellsCache();
    await refreshCompactPosterSnapshotAfterSave(nextDrawing);
    return nextDrawing;
  });
}

async function refreshCompactPosterSnapshotAfterSave(savedDrawing: CellDrawing) {
  try {
    const existingSnapshot = await readJson<PosterSnapshot>(compactSnapshotPath);
    const baseSnapshot = isValidPosterSnapshot(existingSnapshot)
      ? existingSnapshot
      : await rebuildCompactPosterSnapshot();
    const snapshot = upsertCompactSnapshotDrawing(baseSnapshot, savedDrawing);

    await put(compactSnapshotPath, JSON.stringify(snapshot), {
      ...getRequiredBlobAuthOptions(),
      access: blobAccess,
      contentType: "application/json",
      allowOverwrite: true,
    });
  } catch (error) {
    console.error("[scribble-poster] compact snapshot refresh failed", {
      savedCellId: savedDrawing.id,
      error: serializeError(error),
    });
    try {
      await del(compactSnapshotPath, getRequiredBlobAuthOptions());
    } catch (deleteError) {
      console.error("[scribble-poster] compact snapshot stale-delete failed", {
        savedCellId: savedDrawing.id,
        error: serializeError(deleteError),
      });
    }
  }
}

async function withDrawOrderLock<T>(callback: () => Promise<T>) {
  const token = crypto.randomUUID();
  const deadline = Date.now() + drawOrderLockWaitMs;

  while (Date.now() < deadline) {
    await deleteExpiredDrawOrderLock();

    try {
      await put(
        drawOrderLockPath,
        JSON.stringify({
          token,
          expiresAt: new Date(Date.now() + drawOrderLockTtlMs).toISOString(),
        } satisfies BlobLock),
        {
          ...getRequiredBlobAuthOptions(),
          access: blobAccess,
          contentType: "application/json",
          allowOverwrite: false,
        },
      );
      try {
        return await callback();
      } finally {
        await releaseDrawOrderLock(token);
      }
    } catch (error) {
      if (!isBlobConflictError(error)) throw error;
      await sleep(drawOrderLockRetryMs + Math.random() * drawOrderLockRetryMs);
    }
  }

  throw new Error("Timed out acquiring draw order lock");
}

async function deleteExpiredDrawOrderLock() {
  const lock = await readListedBlobByPath<BlobLock>(drawOrderLockPath);
  if (!lock || new Date(lock.expiresAt).getTime() > Date.now()) return;
  try {
    await del(drawOrderLockPath, getRequiredBlobAuthOptions());
  } catch {
    // A concurrent request may have already cleared it.
  }
}

async function releaseDrawOrderLock(token: string) {
  const lock = await readListedBlobByPath<BlobLock>(drawOrderLockPath);
  if (lock?.token !== token) return;
  try {
    await del(drawOrderLockPath, getRequiredBlobAuthOptions());
  } catch {
    // The TTL cleanup path can handle a missed release.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBlobConflictError(error: unknown) {
  return error instanceof Error && /already exists|overwrite|conflict/i.test(error.message);
}

async function readListedBlobByPath<T>(path: string): Promise<T | null> {
  const prefix = path.slice(0, path.lastIndexOf("/") + 1);
  const blobs = await list({ ...getRequiredBlobAuthOptions(), prefix, limit: 1000 });
  const blob = blobs.blobs.find((item) => item.pathname === path);
  if (!blob) return null;
  return readJson<T>(blob.pathname);
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, {
    ...getRequiredBlobAuthOptions(),
    access: blobAccess,
  });
  if (!result) return null;
  if (result.statusCode !== 200) {
    throw new Error(`Failed to read blob ${pathname}: ${result.statusCode}`);
  }
  return (await new Response(result.stream).json()) as T;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function invalidateCellsCache() {
  cellsCache = null;
}

async function getNextDrawOrder() {
  const cells = await listCells({ bypassCache: true });
  return cells.reduce((max, cell) => Math.max(max, cell.drawOrder ?? 0), 0) + 1;
}

function hasBlobCredentials() {
  return getBlobAuthOptions() !== null;
}

function getRequiredBlobAuthOptions() {
  const options = getBlobAuthOptions();
  if (!options) throw new Error("Missing Blob credentials");
  return options;
}

function getBlobAuthOptions(): BlobAuthOptions | null {
  if (isProductionEnvironment()) {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      return { token: process.env.BLOB_READ_WRITE_TOKEN };
    }
    if (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID) {
      return {
        oidcToken: process.env.VERCEL_OIDC_TOKEN,
        storeId: process.env.BLOB_STORE_ID,
      };
    }
    return null;
  }

  if (process.env.BLOB_DEV_READ_WRITE_TOKEN) {
    return { token: process.env.BLOB_DEV_READ_WRITE_TOKEN };
  }
  if (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_DEV_STORE_ID) {
    return {
      oidcToken: process.env.VERCEL_OIDC_TOKEN,
      storeId: process.env.BLOB_DEV_STORE_ID,
    };
  }
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return { token: process.env.BLOB_READ_WRITE_TOKEN };
  }
  return null;
}

function isProductionEnvironment() {
  return process.env.VERCEL_ENV === "production";
}

function makeCompactPosterSnapshot(cells: CellDrawing[]): PosterSnapshot {
  return {
    config: posterConfig,
    cells: cells.map(renderCellDrawing),
    now: new Date().toISOString(),
  };
}

function withFreshSnapshotEnvelope(snapshot: PosterSnapshot): PosterSnapshot {
  return {
    config: posterConfig,
    cells: snapshot.cells,
    now: new Date().toISOString(),
  };
}

function upsertCompactSnapshotDrawing(
  snapshot: PosterSnapshot,
  drawing: CellDrawing,
): PosterSnapshot {
  const renderedDrawing = renderCellDrawing(drawing);
  return {
    config: posterConfig,
    cells: [
      ...snapshot.cells.filter((cell) => cell.id !== drawing.id),
      renderedDrawing,
    ].sort((a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0)),
    now: new Date().toISOString(),
  };
}

function isValidPosterSnapshot(value: PosterSnapshot | null): value is PosterSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray(value.cells),
  );
}

function serializeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}
