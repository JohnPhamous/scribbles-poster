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

type BlobLock = {
  token: string;
  expiresAt: string;
};

export async function listCells(): Promise<CellDrawing[]> {
  if (!hasBlobToken) {
    return Array.from(memoryCells.values());
  }

  const blobs = await list({ prefix: cellPrefix, limit: 1000 });
  const drawings = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellDrawing>(blob.pathname)),
  );

  return drawings.filter(isPresent);
}

export async function getCell(id: string): Promise<CellDrawing | null> {
  if (!hasBlobToken) return memoryCells.get(id) ?? null;
  return readBlobByPath<CellDrawing>(`${cellPrefix}${id}.json`);
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
  const lock = await readBlobByPath<BlobLock>(drawOrderLockPath);
  if (!lock || new Date(lock.expiresAt).getTime() > Date.now()) return;
  try {
    await del(drawOrderLockPath);
  } catch {
    // A concurrent request may have already cleared it.
  }
}

async function releaseDrawOrderLock(token: string) {
  const lock = await readBlobByPath<BlobLock>(drawOrderLockPath);
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
        await deleteHold(hold.cellId);
        return;
      }
      active.push(hold);
    }),
  );

  return active;
}

export async function getHold(cellId: string): Promise<CellHold | null> {
  if (!hasBlobToken) return memoryHolds.get(cellId) ?? null;
  return readBlobByPath<CellHold>(`${holdPrefix}${cellId}.json`);
}

export async function upsertHold(cellId: string, sessionId: string, name?: string) {
  const now = new Date();
  const hold: CellHold = {
    cellId,
    sessionId,
    name: name?.trim() || undefined,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + posterConfig.holdMs).toISOString(),
  };

  if (!hasBlobToken) {
    memoryHolds.set(cellId, hold);
    return hold;
  }

  await put(`${holdPrefix}${cellId}.json`, JSON.stringify(hold), {
    access: blobAccess,
    contentType: "application/json",
    allowOverwrite: true,
  });
  return hold;
}

export async function deleteHold(cellId: string) {
  if (!hasBlobToken) {
    memoryHolds.delete(cellId);
    return;
  }

  try {
    await del(`${holdPrefix}${cellId}.json`);
  } catch {
    // Missing hold is fine.
  }
}

async function listHolds() {
  if (!hasBlobToken) return Array.from(memoryHolds.values());

  const blobs = await list({ prefix: holdPrefix, limit: 1000 });
  const holds = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellHold>(blob.pathname)),
  );

  return holds.filter(isPresent);
}

async function readBlobByPath<T>(path: string): Promise<T | null> {
  return readJson<T>(path);
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

async function getNextDrawOrder() {
  const cells = await listCells();
  return cells.reduce((max, cell) => Math.max(max, cell.drawOrder ?? 0), 0) + 1;
}
