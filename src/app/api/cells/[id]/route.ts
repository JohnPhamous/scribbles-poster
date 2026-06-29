import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { isValidCellId } from "@/lib/poster-config";
import { posterCellsCacheTag } from "@/lib/poster-snapshot";
import { deleteHold, getCell, getSessionHold, hasPersistentStorage, saveCell } from "@/lib/storage";
import type { CellHold } from "@/lib/types";
import { validateDrawing } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sfo1";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidCellId(id)) {
    return NextResponse.json({ error: "Invalid cell" }, { status: 404 });
  }

  const cell = await getCell(id, { retry: true });
  if (!cell) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(cell);
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidCellId(id)) {
    return NextResponse.json({ error: "Invalid cell" }, { status: 404 });
  }

  const body = (await request.json()) as { sessionId?: string; holdStartedAt?: string; hold?: unknown; drawing?: unknown };
  if (!body.sessionId || !body.holdStartedAt) {
    return NextResponse.json({ error: "Missing hold" }, { status: 400 });
  }

  const existing = await getCell(id);
  if (existing) {
    return NextResponse.json({ error: "Cell is already occupied" }, { status: 409 });
  }

  const hold = await getSessionHold(id, body.sessionId, body.holdStartedAt, { retry: true }) ?? getFallbackHold(id, body.sessionId, body.holdStartedAt, body.hold);
  if (!hold) {
    return NextResponse.json({ error: "Cell hold is missing or expired", hold }, { status: 423 });
  }

  const drawing = validateDrawing(body.drawing, id);
  if (!drawing) {
    return NextResponse.json({ error: "Invalid drawing" }, { status: 400 });
  }

  const savedDrawing = await saveCell(drawing);
  if (savedDrawing === "occupied") {
    return NextResponse.json({ error: "Cell is already occupied" }, { status: 409 });
  }

  await deleteHold(id, body.sessionId, body.holdStartedAt);
  revalidateTag(posterCellsCacheTag, { expire: 0 });
  return NextResponse.json(savedDrawing);
}

function getFallbackHold(cellId: string, sessionId: string, startedAt: string, value: unknown): CellHold | null {
  if ((hasPersistentStorage && process.env.NODE_ENV === "production") || !value || typeof value !== "object") return null;
  const hold = value as Partial<CellHold>;
  if (hold.cellId !== cellId || hold.sessionId !== sessionId || hold.startedAt !== startedAt) return null;
  if (typeof hold.expiresAt !== "string" || new Date(hold.expiresAt).getTime() <= Date.now()) return null;
  return hold as CellHold;
}
