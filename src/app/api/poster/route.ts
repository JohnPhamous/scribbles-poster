import { NextResponse } from "next/server";
import { getPosterSnapshot } from "@/lib/poster-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sfo1";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeFullStrokes = url.searchParams.get("full") === "1";

  return NextResponse.json(await getPosterSnapshot({ includeFullStrokes }), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
