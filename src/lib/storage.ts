import { del, get, list, put } from "@vercel/blob";
import { posterConfig } from "./poster-config";
import type { CellDrawing, CellHold } from "./types";

const cellPrefix = "cells/";
const holdPrefix = "holds/";
const lockPrefix = "locks/";
const blobAccess = "private";
const drawOrderLockPath = `${lockPrefix}draw-order.json`;
const drawOrderLockTtlMs = 8_000;
const drawOrderLockWaitMs = 6_000;
const drawOrderLockRetryMs = 120;
const hasBlobToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const memoryCells = new Map<string, CellDrawing>();
const memoryHolds = new Map<string, CellHold>();
const listCacheMs = 1_200;

let cellsCache: { expiresAt: number; value: CellDrawing[] } | null = null;
let holdsCache: { expiresAt: number; value: CellHold[] } | null = null;

type BlobLock = {
  token: string;
  expiresAt: string;
};

export async function listCells(): Promise<CellDrawing[]> {
  if (!hasBlobToken) {
    return Array.from(memoryCells.values());
  }

  if (cellsCache && cellsCache.expiresAt > Date.now()) {
    return cellsCache.value;
  }

  const blobs = await list({ prefix: cellPrefix, limit: 1000 });
  const drawings = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellDrawing>(blob.pathname)),
  );

  const value = drawings.filter(isPresent);
  cellsCache = { expiresAt: Date.now() + listCacheMs, value };
  return value;
}

export async function getCell(id: string, options?: { retry?: boolean }): Promise<CellDrawing | null> {
  if (!hasBlobToken) return memoryCells.get(id) ?? null;
  const attempts = options?.retry ? 6 : 1;
  for (let index = 0; index < attempts; index += 1) {
    const cells = await listCells();
    const cell = cells.find((item) => item.id === id);
    if (cell) return cell;
    if (index < attempts - 1) await sleep(500);
  }
  return null;
}

export async function getCellFast(id: string): Promise<CellDrawing | null> {
  if (!hasBlobToken) return memoryCells.get(id) ?? null;
  return readJson<CellDrawing>(`${cellPrefix}${id}.json`);
}

export async function saveCell(drawing: CellDrawing): Promise<CellDrawing | "occupied"> {
  if (!hasBlobToken) {
    const existing = await getCell(drawing.id);
    if (existing) return "occupied";
    const nextDrawing = {
      ...drawing,
      drawOrder: await getNextDrawOrder(),
    };
    memoryCells.set(drawing.id, nextDrawing);
    memoryHolds.delete(drawing.id);
    invalidateCellsCache();
    invalidateHoldsCache();
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
    await deleteHold(drawing.id);
    return nextDrawing;
  });
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
    await del(drawOrderLockPath);
  } catch {
    // A concurrent request may have already cleared it.
  }
}

async function releaseDrawOrderLock(token: string) {
  const lock = await readListedBlobByPath<BlobLock>(drawOrderLockPath);
  if (lock?.token !== token) return;
  try {
    await del(drawOrderLockPath);
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

export async function listActiveHolds(): Promise<CellHold[]> {
  const now = Date.now();
  const holds = await listHolds();
  const active: CellHold[] = [];

  await Promise.all(
    holds.map(async (hold) => {
      if (new Date(hold.expiresAt).getTime() <= now) {
        await deleteHold(hold.cellId, hold.sessionId);
        return;
      }
      active.push(hold);
    }),
  );

  return active;
}

export async function getHold(cellId: string): Promise<CellHold | null> {
  if (!hasBlobToken) return memoryHolds.get(cellId) ?? null;
  return getNewestHold(await listCellHolds(cellId));
}

export async function getSessionHold(cellId: string, sessionId: string): Promise<CellHold | null> {
  if (!hasBlobToken) {
    const hold = memoryHolds.get(cellId) ?? null;
    return hold?.sessionId === sessionId ? hold : null;
  }
  const hold = await readJson<CellHold>(getHoldPath(cellId));
  return hold?.sessionId === sessionId ? hold : null;
}

export async function acquireHold(cellId: string, sessionId: string, name?: string) {
  const hold = createHold(cellId, sessionId, name);

  if (!hasBlobToken) {
    const existing = memoryHolds.get(cellId);
    const active = existing && new Date(existing.expiresAt).getTime() > Date.now();
    if (active) return existing.sessionId === sessionId ? { ok: true as const, hold: existing } : { ok: false as const, reason: "held" as const, hold: existing };
    memoryHolds.set(cellId, hold);
    invalidateHoldsCache();
    return { ok: true as const, hold };
  }

  try {
    await putHold(hold, false);
    return { ok: true as const, hold };
  } catch (error) {
    if (!isBlobConflictError(error)) throw error;
  }

  const existing = await getHold(cellId);
  const active = existing && new Date(existing.expiresAt).getTime() > Date.now();
  if (active) {
    return existing.sessionId === sessionId ? { ok: true as const, hold: existing } : { ok: false as const, reason: "held" as const, hold: existing };
  }

  await deleteHold(cellId);
  await putHold(hold, false);
  return { ok: true as const, hold };
}

export async function upsertHold(cellId: string, sessionId: string, name?: string) {
  const hold = createHold(cellId, sessionId, name);

  if (!hasBlobToken) {
    memoryHolds.set(cellId, hold);
    invalidateHoldsCache();
    return hold;
  }

  await putHold(hold, true);
  return hold;
}

function createHold(cellId: string, sessionId: string, name?: string) {
  const now = new Date();
  return {
    cellId,
    sessionId,
    name: name?.trim() || undefined,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + posterConfig.holdMs).toISOString(),
  } satisfies CellHold;
}

async function putHold(hold: CellHold, allowOverwrite: boolean) {
  await put(getHoldPath(hold.cellId), JSON.stringify(hold), {
    access: blobAccess,
    contentType: "application/json",
    allowOverwrite,
  });
  invalidateHoldsCache();
}

export async function deleteHold(cellId: string, sessionId?: string) {
  if (!hasBlobToken) {
    const hold = memoryHolds.get(cellId);
    if (!sessionId || hold?.sessionId === sessionId) memoryHolds.delete(cellId);
    invalidateHoldsCache();
    return;
  }

  try {
    if (sessionId) {
      await del(getHoldPath(cellId));
      invalidateHoldsCache();
      return;
    }
    const blobs = await list({ prefix: `${holdPrefix}${cellId}/`, limit: 1000 });
    await Promise.all(blobs.blobs.map((blob) => del(blob.pathname)));
    invalidateHoldsCache();
  } catch {
    // Missing hold is fine.
  }
}

async function listHolds() {
  if (!hasBlobToken) return Array.from(memoryHolds.values());

  if (holdsCache && holdsCache.expiresAt > Date.now()) {
    return holdsCache.value;
  }

  const blobs = await list({ prefix: holdPrefix, limit: 1000 });
  const holds = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellHold>(blob.pathname)),
  );

  const value = holds.filter(isPresent);
  holdsCache = { expiresAt: Date.now() + listCacheMs, value };
  return value;
}

async function listCellHolds(cellId: string) {
  const blobs = await list({ prefix: `${holdPrefix}${cellId}/`, limit: 100 });
  const holds = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellHold>(blob.pathname)),
  );

  return holds.filter(isPresent);
}

async function readListedBlobByPath<T>(path: string): Promise<T | null> {
  const prefix = path.slice(0, path.lastIndexOf("/") + 1);
  const blobs = await list({ prefix, limit: 1000 });
  const blob = blobs.blobs.find((item) => item.pathname === path);
  if (!blob) return null;
  return readJson<T>(blob.pathname);
}

async function readJson<T>(pathname: string): Promise<T | null> {
  try {
    const result = await get(pathname, { access: blobAccess });
    if (!result || result.statusCode !== 200) return null;
    return (await new Response(result.stream).json()) as T;
  } catch {
    return null;
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function getHoldPath(cellId: string) {
  return `${holdPrefix}${cellId}/claim.json`;
}

function getNewestHold(holds: CellHold[]) {
  return holds.toSorted((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
}

function invalidateCellsCache() {
  cellsCache = null;
}

function invalidateHoldsCache() {
  holdsCache = null;
}

async function getNextDrawOrder() {
  const cells = await listCells();
  return cells.reduce((max, cell) => Math.max(max, cell.drawOrder ?? 0), 0) + 1;
}
