import { NextResponse } from "next/server";
import { posterConfig } from "@/lib/poster-config";
import { listActiveHolds, listCells } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";

export async function GET() {
  const [cells, holds] = await Promise.all([listCells(), listActiveHolds()]);
  return NextResponse.json({
    config: posterConfig,
    cells,
    holds,
    now: new Date().toISOString(),
  });
}
