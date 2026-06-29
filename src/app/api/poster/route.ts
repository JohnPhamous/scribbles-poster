import { NextResponse } from "next/server";
import { getPosterSnapshot } from "@/lib/poster-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sfo1";

export async function GET() {
  return NextResponse.json(await getPosterSnapshot(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
