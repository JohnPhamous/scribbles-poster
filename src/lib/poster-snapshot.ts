import { posterConfig } from "./poster-config";
import { listCells } from "./storage";
import type { PosterSnapshot } from "./types";

export async function getPosterSnapshot(): Promise<PosterSnapshot> {
  const cells = await listCells();

  return {
    config: posterConfig,
    cells,
    now: new Date().toISOString(),
  };
}
