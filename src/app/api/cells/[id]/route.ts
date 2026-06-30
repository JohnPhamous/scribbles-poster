import { NextRequest, NextResponse } from "next/server";
import { isValidCellId } from "@/lib/poster-config";
import { getCell, saveCell } from "@/lib/storage";
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

  let body: { drawing?: unknown };
  try {
    body = (await request.json()) as { drawing?: unknown };
  } catch (error) {
    logSaveFailure("invalid-json", id, null, error);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const drawing = validateDrawing(body.drawing, id);
  if (!drawing) {
    logSaveFailure("invalid-drawing", id, body.drawing, null);
    return NextResponse.json({ error: "Invalid drawing" }, { status: 400 });
  }

  try {
    const savedDrawing = await saveCell(drawing);
    if (savedDrawing === "occupied") {
      logSaveFailure("occupied", id, drawing, null);
      return NextResponse.json({ error: "Cell is already occupied" }, { status: 409 });
    }

    return NextResponse.json(savedDrawing);
  } catch (error) {
    logSaveFailure("save-exception", id, drawing, error);
    return NextResponse.json({ error: "Could not save drawing" }, { status: 500 });
  }
}

function logSaveFailure(
  reason: string,
  cellId: string,
  drawing: unknown,
  error: unknown
) {
  const errorDetails =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;
  console.error("[scribble-poster] cell save failed", {
    reason,
    cellId,
    error: errorDetails,
  });

  if (drawing === null || drawing === undefined) return;
  logLargePayload("[scribble-poster] failed cell save payload", {
    reason,
    cellId,
    drawing,
  });
}

function logLargePayload(label: string, payload: unknown) {
  const serialized = JSON.stringify(payload);
  const chunkSize = 24_000;
  const chunkCount = Math.ceil(serialized.length / chunkSize);
  for (let index = 0; index < chunkCount; index += 1) {
    console.error(
      `${label} chunk ${index + 1}/${chunkCount}`,
      serialized.slice(index * chunkSize, (index + 1) * chunkSize)
    );
  }
}
