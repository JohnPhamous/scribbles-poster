import { PosterApp } from "@/components/poster-app";
import { getPosterSnapshot } from "@/lib/poster-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sfo1";

export default async function Home() {
  const initialSnapshot = await getPosterSnapshot();
  return <PosterApp initialSnapshot={initialSnapshot} />;
}
