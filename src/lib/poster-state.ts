import type { CellDrawing, PosterSnapshot } from "./types";

export function applyOptimisticDrawings(
  snapshot: PosterSnapshot,
  optimisticDrawings: Map<string, CellDrawing>,
): PosterSnapshot {
  if (optimisticDrawings.size === 0) return snapshot;

  return {
    ...snapshot,
    cells: [
      ...snapshot.cells.filter((cell) => !optimisticDrawings.has(cell.id)),
      ...optimisticDrawings.values(),
    ],
  };
}

export function upsertDrawing(snapshot: PosterSnapshot, drawing: CellDrawing): PosterSnapshot {
  return {
    ...snapshot,
    cells: [...snapshot.cells.filter((cell) => cell.id !== drawing.id), drawing],
  };
}

export function rollbackOptimisticDrawing(
  snapshot: PosterSnapshot,
  optimisticDrawing: CellDrawing,
): PosterSnapshot {
  return {
    ...snapshot,
    cells: snapshot.cells.filter((cell) => {
      if (cell.id !== optimisticDrawing.id) return true;
      return !isOptimisticCellVersion(cell, optimisticDrawing);
    }),
  };
}

function isOptimisticCellVersion(cell: CellDrawing, optimisticDrawing: CellDrawing) {
  return (
    cell.drawOrder === optimisticDrawing.drawOrder &&
    cell.createdAt === optimisticDrawing.createdAt &&
    cell.updatedAt === optimisticDrawing.updatedAt
  );
}
