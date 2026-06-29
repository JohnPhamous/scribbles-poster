import type { PosterConfig } from "./types";

const posterWidthIn = 24;
const posterHeightIn = 36;
const titleHeightIn = 4;
const cellSizeIn = 4;

export const posterConfig: PosterConfig = {
  title: "POSTER TITLE",
  posterWidthIn,
  posterHeightIn,
  titleHeightIn,
  cellSizeIn,
  columns: Math.floor(posterWidthIn / cellSizeIn),
  rows: Math.floor((posterHeightIn - titleHeightIn) / cellSizeIn),
  canvasSize: 1024,
  strokeWidth: 14,
  maxReplayMs: 45_000,
  holdMs: 10 * 60 * 1000,
  exportDpi: 150,
  palette: ["#E63946", "#F4A261", "#2A9D8F", "#457B9D", "#8338EC"],
};

export function getCellIds() {
  return Array.from({ length: posterConfig.rows * posterConfig.columns }, (_, index) => {
    const row = Math.floor(index / posterConfig.columns);
    const col = index % posterConfig.columns;
    return `r${row + 1}c${col + 1}`;
  });
}

export function isValidCellId(id: string) {
  return getCellIds().includes(id);
}
