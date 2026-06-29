"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { drawStrokes, getStrokeDuration } from "@/lib/drawing";
import { getCellIds } from "@/lib/poster-config";
import type { CellDrawing, CellHold, Point, PosterConfig, PosterSnapshot, Stroke } from "@/lib/types";

type Selection =
  | { kind: "edit"; cellId: string; hold: CellHold; camera: CameraFrame }
  | { kind: "view"; cellId: string; drawing: CellDrawing; camera: CameraFrame };

type ZoomRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CameraFrame = {
  cell: ZoomRect;
  poster: ZoomRect;
};

const cellIds = getCellIds();

export function PosterApp() {
  const [snapshot, setSnapshot] = useState<PosterSnapshot | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [message, setMessage] = useState("");
  const [showPrintTools, setShowPrintTools] = useState(false);
  const [replayStartedAt, setReplayStartedAt] = useState<number | null>(null);
  const [replayElapsed, setReplayElapsed] = useState(0);
  const [isSaving, setIsSaving] = useState(false);

  const selectedRef = useRef<Selection | null>(null);
  selectedRef.current = selection;

  const config = snapshot?.config;
  const drawingsById = useMemo(() => {
    const map = new Map<string, CellDrawing>();
    for (const cell of snapshot?.cells ?? []) map.set(cell.id, cell);
    return map;
  }, [snapshot]);

  const holdsById = useMemo(() => {
    const map = new Map<string, CellHold>();
    const now = Date.now();
    for (const hold of snapshot?.holds ?? []) {
      if (new Date(hold.expiresAt).getTime() > now) map.set(hold.cellId, hold);
    }
    return map;
  }, [snapshot]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/poster", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load poster");
    const next = (await response.json()) as PosterSnapshot;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    let existing = window.localStorage.getItem("scribbles-session-id");
    if (!existing) {
      existing = crypto.randomUUID();
      window.localStorage.setItem("scribbles-session-id", existing);
    }
    setSessionId(existing);
    setShowPrintTools(new URLSearchParams(window.location.search).get("print") === "1");
    refresh().catch(() => setMessage("Could not load poster."));
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selection || selection.kind !== "edit") return;
    const timer = window.setInterval(() => {
      const msLeft = new Date(selection.hold.expiresAt).getTime() - Date.now();
      if (msLeft <= 0) {
        setSelection(null);
        setMessage("Your 10 minute cell hold expired. Pick another open cell.");
        refresh().catch(() => undefined);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [selection, refresh]);

  useEffect(() => {
    if (!selection || selection.kind !== "edit") return;
    const timer = window.setInterval(() => {
      fetch(`/api/cells/${selection.cellId}/hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "heartbeat", sessionId }),
      }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [selection, sessionId]);

  useEffect(() => {
    if (replayStartedAt === null || !config) return;
    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - replayStartedAt;
      setReplayElapsed(Math.min(elapsed, config.maxReplayMs));
      if (elapsed < config.maxReplayMs) frame = requestAnimationFrame(tick);
      else setReplayStartedAt(null);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [config, replayStartedAt]);

  useEffect(() => {
    const release = () => {
      const current = selectedRef.current;
      if (current?.kind !== "edit") return;
      navigator.sendBeacon?.(
        `/api/cells/${current.cellId}/hold`,
        new Blob([JSON.stringify({ action: "release", sessionId })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [sessionId]);

  async function openCell(cellId: string, camera: CameraFrame) {
    if (!snapshot || !sessionId) return;
    setMessage("");

    const drawing = drawingsById.get(cellId);
    if (drawing) {
      setSelection({ kind: "view", cellId, drawing, camera });
      return;
    }

    const hold = holdsById.get(cellId);
    if (hold && hold.sessionId !== sessionId) {
      setMessage("That cell is currently held by someone else.");
      return;
    }

    const response = await fetch(`/api/cells/${cellId}/hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "acquire", sessionId }),
    });
    const result = (await response.json()) as { ok: boolean; reason?: string; hold?: CellHold };

    if (!response.ok || !result.ok || !result.hold) {
      setMessage(result.reason === "held" ? "That cell was just claimed." : "Could not claim that cell.");
      await refresh().catch(() => undefined);
      return;
    }

    setSelection({ kind: "edit", cellId, hold: result.hold, camera });
    await refresh().catch(() => undefined);
  }

  async function closeSelection() {
    if (selection?.kind === "edit") {
      await fetch(`/api/cells/${selection.cellId}/hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", sessionId }),
      }).catch(() => undefined);
    }
    setSelection(null);
    await refresh().catch(() => undefined);
  }

  async function saveDrawing(drawing: CellDrawing) {
    setIsSaving(true);
    const response = await fetch(`/api/cells/${drawing.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, drawing }),
    });
    setIsSaving(false);

    if (!response.ok) {
      setMessage(response.status === 409 ? "That cell was already saved." : "Could not save. Your hold may have expired.");
      setSelection(null);
      await refresh().catch(() => undefined);
      return;
    }

    setSelection(null);
    setMessage("Saved.");
    await refresh().catch(() => undefined);
  }

  function startReplay() {
    setReplayElapsed(0);
    setReplayStartedAt(performance.now());
  }

  function stopReplay() {
    setReplayStartedAt(null);
    setReplayElapsed(0);
  }

  function exportPng() {
    if (!config) return;
    const scale = config.exportDpi;
    const canvas = document.createElement("canvas");
    canvas.width = config.posterWidthIn * scale;
    canvas.height = config.posterHeightIn * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(0.9 * scale)}px Arial, sans-serif`;
    ctx.fillText(config.title, canvas.width / 2, (config.titleHeightIn * scale) / 2);

    const cellPx = config.cellSizeIn * scale;
    const yStart = config.titleHeightIn * scale;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = Math.max(1, Math.round(scale / 96));
    for (const id of cellIds) {
      const index = cellIds.indexOf(id);
      const col = index % config.columns;
      const row = Math.floor(index / config.columns);
      const x = col * cellPx;
      const y = yStart + row * cellPx;
      ctx.strokeRect(x, y, cellPx, cellPx);
      const drawing = drawingsById.get(id);
      if (!drawing) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(cellPx / config.canvasSize, cellPx / config.canvasSize);
      drawStrokes(ctx, drawing.strokes, config.canvasSize);
      ctx.restore();
      ctx.fillStyle = "#9a9a9a";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = `${Math.round(0.18 * scale)}px Arial, sans-serif`;
      ctx.fillText(drawing.name, x + 0.12 * scale, y + cellPx - 0.12 * scale, cellPx - 0.24 * scale);
    }

    const link = document.createElement("a");
    link.download = "scribbles-poster.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  if (!snapshot || !config) {
    return <main className="app appLoading">Loading poster...</main>;
  }

  const replayActive = replayStartedAt !== null || replayElapsed > 0;
  const cameraStyle = selection ? getCameraStyle(selection.camera) : undefined;

  return (
    <main className={`app ${selection ? "zoomActive" : ""}`}>
      <section className="stage" aria-label="Collaborative poster">
        <div
          className="poster"
          style={
            {
              "--poster-width": config.posterWidthIn,
              "--poster-height": config.posterHeightIn,
              "--title-height": config.titleHeightIn,
              "--columns": config.columns,
              "--rows": config.rows,
              ...cameraStyle?.poster,
            } as CSSProperties
          }
        >
          <header className="posterTitle">{config.title}</header>
          <div className="posterGrid">
            {cellIds.map((cellId) => (
              <PosterCell
                key={cellId}
                cellId={cellId}
                config={config}
                drawing={drawingsById.get(cellId)}
                hold={holdsById.get(cellId)}
                ownSessionId={sessionId}
                replayElapsed={replayActive ? replayElapsed : null}
                onOpen={(camera) => openCell(cellId, camera)}
              />
            ))}
          </div>
        </div>
      </section>

      <div className="toolbar noPrint">
        <button className="iconButton" type="button" onClick={replayActive ? stopReplay : startReplay} title={replayActive ? "Stop replay" : "Play replay"}>
          {replayActive ? "Stop" : "Play"}
        </button>
        {showPrintTools ? (
          <>
            <button className="iconButton" type="button" onClick={() => window.print()} title="Print poster">
              Print
            </button>
            <button className="iconButton" type="button" onClick={exportPng} title="Export PNG">
              PNG
            </button>
          </>
        ) : null}
        {message ? <p className="status">{message}</p> : null}
      </div>

      {selection ? (
        <CellOverlay
          selection={selection}
          config={config}
          sessionId={sessionId}
          isSaving={isSaving}
          style={cameraStyle?.target}
          onClose={closeSelection}
          onSave={saveDrawing}
        />
      ) : null}
    </main>
  );
}

function PosterCell({
  cellId,
  config,
  drawing,
  hold,
  ownSessionId,
  replayElapsed,
  onOpen,
}: {
  cellId: string;
  config: PosterConfig;
  drawing?: CellDrawing;
  hold?: CellHold;
  ownSessionId: string;
  replayElapsed: number | null;
  onOpen: (camera: CameraFrame) => void;
}) {
  const heldByOther = Boolean(hold && hold.sessionId !== ownSessionId);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const poster = event.currentTarget.closest(".poster")?.getBoundingClientRect();
    if (!poster) return;
    onOpen({
      cell: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      poster: {
        x: poster.left,
        y: poster.top,
        width: poster.width,
        height: poster.height,
      },
    });
  }

  return (
    <button
      className={`cell ${drawing ? "occupied" : ""} ${heldByOther ? "held" : ""}`}
      type="button"
      onClick={handleClick}
      aria-label={`${cellId}${drawing ? ` by ${drawing.name}` : heldByOther ? " held" : " empty"}`}
    >
      <DrawingCanvas drawing={drawing} config={config} replayElapsed={replayElapsed} />
      {drawing ? <span className="cellName">{drawing.name}</span> : null}
      {heldByOther ? <span className="cellHeld">Held</span> : null}
    </button>
  );
}

function DrawingCanvas({
  drawing,
  config,
  replayElapsed,
}: {
  drawing?: CellDrawing;
  config: PosterConfig;
  replayElapsed: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(canvas.width / config.canvasSize, 0, 0, canvas.height / config.canvasSize, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, config.canvasSize, config.canvasSize);
    if (!drawing) return;

    if (replayElapsed === null) {
      drawStrokes(ctx, drawing.strokes, config.canvasSize);
      return;
    }

    const sourceDuration = getStrokeDuration(drawing.strokes);
    const untilMs =
      sourceDuration > config.maxReplayMs
        ? Math.min(sourceDuration, (replayElapsed / config.maxReplayMs) * sourceDuration)
        : Math.min(sourceDuration, replayElapsed);
    drawStrokes(ctx, drawing.strokes, config.canvasSize, { untilMs });
  }, [config, drawing, replayElapsed]);

  return <canvas ref={canvasRef} className="drawingCanvas" />;
}

function CellOverlay({
  selection,
  config,
  sessionId,
  isSaving,
  style,
  onClose,
  onSave,
}: {
  selection: Selection;
  config: PosterConfig;
  sessionId: string;
  isSaving: boolean;
  style?: CSSProperties;
  onClose: () => void;
  onSave: (drawing: CellDrawing) => void;
}) {
  return (
    <div className="overlay noPrint">
      <div className="zoomPanel" style={style}>
        {selection.kind === "view" ? (
          <ReadOnlyCell drawing={selection.drawing} config={config} onClose={onClose} />
        ) : (
          <Editor cellId={selection.cellId} hold={selection.hold} config={config} sessionId={sessionId} isSaving={isSaving} onClose={onClose} onSave={onSave} />
        )}
      </div>
    </div>
  );
}

function getCameraStyle(camera: CameraFrame): { poster: CSSProperties; target: CSSProperties } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const targetSize = Math.min(viewportWidth * 0.92, viewportHeight * 0.78);
  const targetLeft = Math.max(12, (viewportWidth - targetSize) / 2);
  const targetTop = Math.max(16, (viewportHeight - targetSize - 96) / 2);
  const scale = targetSize / camera.cell.width;
  const cellOffsetX = camera.cell.x - camera.poster.x;
  const cellOffsetY = camera.cell.y - camera.poster.y;

  return {
    poster: {
      "--camera-poster-x": `${camera.poster.x}px`,
      "--camera-poster-y": `${camera.poster.y}px`,
      "--camera-poster-width": `${camera.poster.width}px`,
      "--camera-poster-height": `${camera.poster.height}px`,
      "--camera-dx": `${targetLeft - camera.poster.x - cellOffsetX * scale}px`,
      "--camera-dy": `${targetTop - camera.poster.y - cellOffsetY * scale}px`,
      "--camera-scale": scale,
    } as CSSProperties,
    target: {
      "--zoom-to-x": `${targetLeft}px`,
      "--zoom-to-y": `${targetTop}px`,
      "--zoom-to-size": `${targetSize}px`,
    } as CSSProperties,
  };
}

function ReadOnlyCell({ drawing, config, onClose }: { drawing: CellDrawing; config: PosterConfig; onClose: () => void }) {
  return (
    <>
      <div className="editorCanvasWrap readOnly">
        <DrawingCanvas drawing={drawing} config={config} replayElapsed={null} />
        <span className="detailName">{drawing.name}</span>
      </div>
      <div className="editorControls">
        <p className="status">Read-only saved cell.</p>
        <button type="button" onClick={onClose}>
          Back
        </button>
      </div>
    </>
  );
}

function Editor({
  cellId,
  hold,
  config,
  sessionId,
  isSaving,
  onClose,
  onSave,
}: {
  cellId: string;
  hold: CellHold;
  config: PosterConfig;
  sessionId: string;
  isSaving: boolean;
  onClose: () => void;
  onSave: (drawing: CellDrawing) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const strokeStartedAtRef = useRef(0);
  const [strokesVersion, setStrokesVersion] = useState(0);
  const [color, setColor] = useState(config.palette[0]);
  const [name, setName] = useState("");
  const [msLeft, setMsLeft] = useState(() => new Date(hold.expiresAt).getTime() - Date.now());

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(canvas.width / config.canvasSize, 0, 0, canvas.height / config.canvasSize, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, config.canvasSize, config.canvasSize);
    drawStrokes(ctx, [...strokesRef.current, ...(currentStrokeRef.current ? [currentStrokeRef.current] : [])], config.canvasSize);
  }, [config.canvasSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      redraw();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [redraw]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMsLeft(new Date(hold.expiresAt).getTime() - Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [hold.expiresAt]);

  function getPoint(event: PointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * config.canvasSize;
    const y = ((event.clientY - rect.top) / rect.height) * config.canvasSize;
    return {
      x: Math.max(0, Math.min(config.canvasSize, x)),
      y: Math.max(0, Math.min(config.canvasSize, y)),
      t: Math.max(0, performance.now() - strokeStartedAtRef.current),
    };
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    strokeStartedAtRef.current = performance.now();
    currentStrokeRef.current = {
      id: crypto.randomUUID(),
      color,
      width: config.strokeWidth,
      points: [getPoint(event)],
    };
    redraw();
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!currentStrokeRef.current) return;
    const points = currentStrokeRef.current.points;
    const next = getPoint(event);
    const previous = points[points.length - 1];
    if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < 2) return;
    points.push(next);
    redraw();
  }

  function finishStroke() {
    if (!currentStrokeRef.current) return;
    strokesRef.current = [...strokesRef.current, currentStrokeRef.current];
    currentStrokeRef.current = null;
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function undo() {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function clear() {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function save() {
    const now = new Date().toISOString();
    onSave({
      id: cellId,
      name: name.trim() || "Anonymous",
      strokes: strokesRef.current,
      createdAt: now,
      updatedAt: now,
    });
  }

  const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000));

  return (
    <>
      <div className="editorCanvasWrap">
        <canvas
          ref={canvasRef}
          className="editorCanvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        />
      </div>
      <div className="editorControls">
        <div className="palette" aria-label="Drawing colors">
          {config.palette.map((item) => (
            <button
              key={item}
              type="button"
              className={`swatch ${item === color ? "active" : ""}`}
              style={{ backgroundColor: item }}
              onClick={() => setColor(item)}
              aria-label={`Use ${item}`}
            />
          ))}
        </div>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" />
        <span className="timer">{formatTime(secondsLeft)}</span>
        <button type="button" onClick={undo} disabled={strokesRef.current.length === 0 || isSaving}>
          Undo
        </button>
        <button type="button" onClick={clear} disabled={strokesRef.current.length === 0 || isSaving}>
          Clear
        </button>
        <button type="button" onClick={onClose} disabled={isSaving}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={isSaving || strokesRef.current.length === 0} data-primary>
          {isSaving ? "Saving" : "Save"}
        </button>
        <span className="srOnly">{strokesVersion}</span>
      </div>
    </>
  );
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
