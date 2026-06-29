import { NextRequest, NextResponse } from "next/server";
import { isValidCellId } from "@/lib/poster-config";
import { deleteHold, getCell, getSessionHold, saveCell } from "@/lib/storage";
import { validateDrawing } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "edge";
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

  const body = (await request.json()) as { sessionId?: string; drawing?: unknown };
  if (!body.sessionId) {
    return NextResponse.json({ error: "Missing session" }, { status: 400 });
  }

  const existing = await getCell(id);
  if (existing) {
    return NextResponse.json({ error: "Cell is already occupied" }, { status: 409 });
  }

  const hold = await getSessionHold(id, body.sessionId);
  const holdActive = hold && new Date(hold.expiresAt).getTime() > Date.now();
  if (!holdActive) {
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

  await deleteHold(id, body.sessionId);
  return NextResponse.json(savedDrawing);
}
