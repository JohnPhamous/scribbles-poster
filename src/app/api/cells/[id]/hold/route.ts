import { NextRequest, NextResponse } from "next/server";
import { isValidCellId } from "@/lib/poster-config";
import { acquireHold, deleteHold, getCellFast, getSessionHold } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "edge";
export const preferredRegion = "sfo1";

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
    holdStartedAt?: string;
    name?: string;
  };

  if (!body.sessionId || !body.action) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  if (body.action === "release") {
    await deleteHold(id, body.sessionId, body.holdStartedAt);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "heartbeat") {
    const hold = await getSessionHold(id, body.sessionId);
    const active = hold && new Date(hold.expiresAt).getTime() > Date.now();
    if (active) return NextResponse.json({ ok: true, hold });
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 410 });
  }

  const cell = await getCellFast(id);
  if (cell) {
    return NextResponse.json({ ok: false, reason: "occupied" }, { status: 409 });
  }

  const acquireResult = await acquireHold(id, body.sessionId, body.name);
  if (!acquireResult.ok) {
    return NextResponse.json({ ok: false, reason: acquireResult.reason, hold: acquireResult.hold }, { status: 423 });
  }

  return NextResponse.json({ ok: true, hold: acquireResult.hold });
}
