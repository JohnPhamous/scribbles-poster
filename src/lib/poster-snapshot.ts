import { posterConfig } from "./poster-config";
import { renderCellDrawing } from "./rendered-drawing";
import {
  getCompactPosterSnapshot,
  listCells,
  rebuildCompactPosterSnapshot,
} from "./storage";
import type { PosterSnapshot } from "./types";

export async function getPosterSnapshot(options?: {
  includeFullStrokes?: boolean;
  preferCompact?: boolean;
}): Promise<PosterSnapshot> {
  if (!options?.includeFullStrokes && options?.preferCompact) {
    const compactSnapshot = await getCompactPosterSnapshot();
    if (compactSnapshot) return compactSnapshot;

    return rebuildCompactPosterSnapshot({
      write: process.env.NODE_ENV === "development",
    });
  }

  const cells = await listCells();
  const snapshotCells = options?.includeFullStrokes
    ? cells
    : cells.map(renderCellDrawing);

  return {
    config: posterConfig,
    cells: snapshotCells,
    now: new Date().toISOString(),
  };
}
