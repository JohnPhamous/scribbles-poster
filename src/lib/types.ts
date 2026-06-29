export type Point = {
  x: number;
  y: number;
  t: number;
};

export type Stroke = {
  id: string;
  order: number;
  startedAt: number;
  color: string;
  width: number;
  points: Point[];
};

export type CellDrawing = {
  id: string;
  drawOrder: number;
  name: string;
  strokes: Stroke[];
  createdAt: string;
  updatedAt: string;
};

export type CellSummary = {
  id: string;
  name: string;
  updatedAt: string;
};

export type PosterConfig = {
  title: string;
  posterWidthIn: number;
  posterHeightIn: number;
  titleHeightIn: number;
  targetCellSizeIn: number;
  cellSizeIn: number;
  gridWidthIn: number;
  gridHeightIn: number;
  gridOffsetXIn: number;
  gridOffsetYIn: number;
  gridPaddingIn: number;
  columns: number;
  rows: number;
  canvasSize: number;
  strokeWidth: number;
  maxReplayMs: number;
  sequentialReplayCellMs: number;
  exportDpi: number;
  palette: string[];
};

export type PosterSnapshot = {
  config: PosterConfig;
  cells: CellDrawing[];
  now: string;
};
