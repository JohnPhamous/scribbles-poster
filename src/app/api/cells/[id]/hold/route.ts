import { NextRequest, NextResponse } from "next/server";
import { isValidCellId } from "@/lib/poster-config";
import { deleteHold, getCell, getHold, upsertHold } from "@/lib/storage";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!isValidCellId(id)) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 404 });
  }

  const body = (await request.json()) as {
    action?: "acquire" | "release" | "heartbeat";
    sessionId?: string;
    name?: string;
  };

  if (!body.sessionId || !body.action) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  if (body.action === "release") {
    const hold = await getHold(id);
    if (hold?.sessionId === body.sessionId) {
      await deleteHold(id, body.sessionId);
    }
    return NextResponse.json({ ok: true });
  }

  const cell = await getCell(id);
  if (cell) {
    return NextResponse.json({ ok: false, reason: "occupied" }, { status: 409 });
  }

  const existing = await getHold(id);
  const active = existing && new Date(existing.expiresAt).getTime() > Date.now();

  if (active && existing.sessionId === body.sessionId) {
    return NextResponse.json({ ok: true, hold: existing });
  }

  if (active && existing.sessionId !== body.sessionId) {
    return NextResponse.json({ ok: false, reason: "held", hold: existing }, { status: 423 });
  }

  if (body.action === "heartbeat") {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 410 });
  }

  const hold = await upsertHold(id, body.sessionId, body.name);
  return NextResponse.json({ ok: true, hold });
}
