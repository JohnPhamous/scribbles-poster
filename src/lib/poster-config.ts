import type { PosterConfig } from "./types";

const posterWidthIn = 24;
const posterHeightIn = 36;
const titleHeightIn = 2;
const targetCellSizeIn = 2;
const gridPaddingIn = 0.5;
const gridLayout = getBestGridLayout({
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  targetCellSizeIn,
  gridPaddingIn,
});

export const posterConfig: PosterConfig = {
  title: `${gridLayout.columns * gridLayout.rows} scribbles by friends`,
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  targetCellSizeIn,
  cellSizeIn: gridLayout.cellSizeIn,
  gridWidthIn: gridLayout.gridWidthIn,
  gridHeightIn: gridLayout.gridHeightIn,
  gridOffsetXIn: gridLayout.gridOffsetXIn,
  gridOffsetYIn: gridLayout.gridOffsetYIn,
  gridPaddingIn,
  columns: gridLayout.columns,
  rows: gridLayout.rows,
  canvasSize: 1024,
  strokeWidth: 14,
  maxReplayMs: 45_000,
  sequentialReplayCellMs: 2_200,
  exportDpi: 150,
  palette: ["#FFC82D", "#0364BA", "#41A9AC", "#DC2625", "#000000"],
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
  gridPaddingIn: number;
};

function getBestGridLayout({
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  targetCellSizeIn,
  gridPaddingIn,
}: GridLayoutInput) {
  const drawableWidthIn = posterWidthIn - gridPaddingIn * 2;
  const drawableHeightIn = posterHeightIn - titleHeightIn - gridPaddingIn * 2;
  const minCellSizeIn = targetCellSizeIn * 0.9;
  const maxCellSizeIn = targetCellSizeIn * 1.15;
  const maxColumns = Math.max(1, Math.floor(drawableWidthIn / minCellSizeIn));
  const maxRows = Math.max(1, Math.floor(drawableHeightIn / minCellSizeIn));
  let best = {
    columns: 1,
    rows: 1,
    cellSizeIn: Math.min(drawableWidthIn, drawableHeightIn),
    usedAreaIn: 0,
  };

  for (let columns = 1; columns <= maxColumns; columns += 1) {
    for (let rows = 1; rows <= maxRows; rows += 1) {
      const cellSizeIn = Math.min(drawableWidthIn / columns, drawableHeightIn / rows);
      if (cellSizeIn < minCellSizeIn) continue;
      if (cellSizeIn > maxCellSizeIn) continue;

      const usedAreaIn = columns * rows * cellSizeIn * cellSizeIn;
      const count = columns * rows;
      const bestCount = best.columns * best.rows;
      const isBetter =
        usedAreaIn > best.usedAreaIn ||
        (usedAreaIn === best.usedAreaIn && count > bestCount) ||
        (usedAreaIn === best.usedAreaIn && count === bestCount && Math.abs(cellSizeIn - targetCellSizeIn) < Math.abs(best.cellSizeIn - targetCellSizeIn));

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
    gridOffsetXIn: gridPaddingIn + (drawableWidthIn - gridWidthIn) / 2,
    gridOffsetYIn: gridPaddingIn + (drawableHeightIn - gridHeightIn) / 2,
  };
}
