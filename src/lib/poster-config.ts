import type { PosterConfig } from "./types";

const posterWidthIn = 24;
const posterHeightIn = 36;
const titleHeightIn = 4;
const targetCellSizeIn = 2;
const gridLayout = getBestGridLayout({
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  targetCellSizeIn,
});

export const posterConfig: PosterConfig = {
  title: "POSTER TITLE",
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  targetCellSizeIn,
  cellSizeIn: gridLayout.cellSizeIn,
  gridWidthIn: gridLayout.gridWidthIn,
  gridHeightIn: gridLayout.gridHeightIn,
  gridOffsetXIn: gridLayout.gridOffsetXIn,
  gridOffsetYIn: gridLayout.gridOffsetYIn,
  columns: gridLayout.columns,
  rows: gridLayout.rows,
  canvasSize: 1024,
  strokeWidth: 14,
  maxReplayMs: 45_000,
  sequentialReplayCellMs: 2_200,
  holdMs: 10 * 60 * 1000,
  exportDpi: 150,
  palette: ["#3d348bff", "#7678edff", "#f7b801ff", "#f18701ff", "#f35b04ff"],
};

export function getCellIds(config: Pick<PosterConfig, "rows" | "columns"> = posterConfig) {
  return Array.from({ length: config.rows * config.columns }, (_, index) => {
    const row = Math.floor(index / config.columns);
    const col = index % config.columns;
    return `r${row + 1}c${col + 1}`;
  });
}

export function isValidCellId(id: string) {
  return getCellIds().includes(id);
}

type GridLayoutInput = {
  posterWidthIn: number;
  posterHeightIn: number;
  titleHeightIn: number;
  targetCellSizeIn: number;
};

function getBestGridLayout({
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  targetCellSizeIn,
}: GridLayoutInput) {
  const drawableWidthIn = posterWidthIn;
  const drawableHeightIn = posterHeightIn - titleHeightIn;
  const maxColumns = Math.max(1, Math.floor(drawableWidthIn / targetCellSizeIn));
  const maxRows = Math.max(1, Math.floor(drawableHeightIn / targetCellSizeIn));
  let best = {
    columns: 1,
    rows: 1,
    cellSizeIn: Math.min(drawableWidthIn, drawableHeightIn),
    usedAreaIn: 0,
  };

  for (let columns = 1; columns <= maxColumns; columns += 1) {
    for (let rows = 1; rows <= maxRows; rows += 1) {
      const cellSizeIn = Math.min(drawableWidthIn / columns, drawableHeightIn / rows);
      if (cellSizeIn < targetCellSizeIn) continue;

      const usedAreaIn = columns * rows * cellSizeIn * cellSizeIn;
      const count = columns * rows;
      const bestCount = best.columns * best.rows;
      const isBetter =
        count > bestCount ||
        (count === bestCount && usedAreaIn > best.usedAreaIn) ||
        (count === bestCount && usedAreaIn === best.usedAreaIn && cellSizeIn < best.cellSizeIn);

      if (isBetter) {
        best = {
          columns,
          rows,
          cellSizeIn,
          usedAreaIn,
        };
      }
    }
  }

  const gridWidthIn = best.columns * best.cellSizeIn;
  const gridHeightIn = best.rows * best.cellSizeIn;

  return {
    columns: best.columns,
    rows: best.rows,
    cellSizeIn: best.cellSizeIn,
    gridWidthIn,
    gridHeightIn,
    gridOffsetXIn: (drawableWidthIn - gridWidthIn) / 2,
    gridOffsetYIn: (drawableHeightIn - gridHeightIn) / 2,
  };
}
