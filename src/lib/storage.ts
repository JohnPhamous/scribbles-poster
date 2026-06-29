import { del, list, put } from "@vercel/blob";
import { posterConfig } from "./poster-config";
import type { CellDrawing, CellHold } from "./types";

const cellPrefix = "cells/";
const holdPrefix = "holds/";
const hasBlobToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const memoryCells = new Map<string, CellDrawing>();
const memoryHolds = new Map<string, CellHold>();

export async function listCells(): Promise<CellDrawing[]> {
  if (!hasBlobToken) {
    return Array.from(memoryCells.values());
  }

  const blobs = await list({ prefix: cellPrefix, limit: 1000 });
  const drawings = await Promise.all(
    blobs.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map(async (blob) => readJson<CellDrawing>(blob.url)),
  );

  return drawings.filter(isPresent);
}

export async function getCell(id: string): Promise<CellDrawing | null> {
  if (!hasBlobToken) return memoryCells.get(id) ?? null;
  return readBlobByPath<CellDrawing>(`${cellPrefix}${id}.json`);
}

export async function saveCell(drawing: CellDrawing): Promise<"saved" | "occupied"> {
  const existing = await getCell(drawing.id);
  if (existing) return "occupied";
  const nextDrawing = {
    ...drawing,
    drawOrder: await getNextDrawOrder(),
  };

  if (!hasBlobToken) {
    memoryCells.set(drawing.id, nextDrawing);
    memoryHolds.delete(drawing.id);
    return "saved";
  }

  try {
    await put(`${cellPrefix}${drawing.id}.json`, JSON.stringify(nextDrawing), {
      access: "public",
      contentType: "application/json",
      allowOverwrite: false,
    });
  } catch (error) {
    if (error instanceof Error && /already exists|overwrite|conflict/i.test(error.message)) {
      return "occupied";
    }
    throw error;
  }
  await deleteHold(drawing.id);
  return "saved";
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
    access: "public",
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
      .map(async (blob) => readJson<CellHold>(blob.url)),
  );

  return holds.filter(isPresent);
}

async function readBlobByPath<T>(path: string): Promise<T | null> {
  const blobs = await list({ prefix: path, limit: 1 });
  const blob = blobs.blobs.find((item) => item.pathname === path);
  if (!blob) return null;
  return readJson<T>(blob.url);
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
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
