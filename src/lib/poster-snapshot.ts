import { unstable_cache } from "next/cache";
import { posterConfig } from "./poster-config";
import { listActiveHolds, listCells } from "./storage";
import type { PosterSnapshot } from "./types";

export const posterCellsCacheTag = "poster-cells";

const getCachedCells = unstable_cache(
  async () => listCells({ bypassCache: true }),
  ["poster-cells-v1"],
  {
    revalidate: 60 * 60,
    tags: [posterCellsCacheTag],
  },
);

export async function getPosterSnapshot(): Promise<PosterSnapshot> {
  const [cells, holds] = await Promise.all([getCachedCells(), listActiveHolds()]);

  return {
    config: posterConfig,
    cells,
    holds,
    now: new Date().toISOString(),
  };
}
