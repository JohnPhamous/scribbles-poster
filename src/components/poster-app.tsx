"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, CSSProperties, MouseEvent, PointerEvent } from "react";
import { animate, motion, useMotionValue } from "motion/react";
import { drawStrokes, getStrokeDuration } from "@/lib/drawing";
import { getDirectionalCellId } from "@/lib/grid-navigation";
import type { GridNavigationDirection } from "@/lib/grid-navigation";
import { getCellIds } from "@/lib/poster-config";
import { applyOptimisticDrawings, rollbackOptimisticDrawing, upsertDrawing } from "@/lib/poster-state";
import type { CellDrawing, CellHold, Point, PosterConfig, PosterSnapshot, Stroke } from "@/lib/types";

type Selection =
  | { kind: "edit"; cellId: string; hold: CellHold; camera: CameraFrame; isClaiming: boolean }
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

type CameraStyle = {
  poster: CSSProperties;
  target: CSSProperties;
  posterMotion: {
    x: number;
    y: number;
    scale: number;
  };
  targetMotion: {
    x: number;
    y: number;
    scale: number;
    opacity: number;
  };
};

type ReplayMode = "simultaneous" | "sequential";
type CellReplay = {
  elapsedMs: number;
  durationMs?: number;
};
type PosterMotionStyle = ComponentProps<typeof motion.div>["style"];
type ZoomPanelMotionStyle = ComponentProps<typeof motion.div>["style"];

const cameraMs = 620;
const cameraTransition = {
  duration: cameraMs / 1000,
  ease: [0.16, 1, 0.2, 1],
} as const;
const cameraExitTransition = {
  duration: cameraMs / 1000,
  ease: [0.42, 0, 0.28, 1],
} as const;
const cameraCleanupMs = cameraMs + 120;
const zoomCanvasNeighborRadius = 1;
const maxZoomCanvasScale = 14;
const authorLabelFontRatio = 0.08;
const authorLabelMarginRatio = 0.05;
const visibleRefreshMs = 1_000;
const hiddenRefreshMs = 5_000;
const heartbeatMs = 60_000;

function createOptimisticHold(cellId: string, sessionId: string, holdMs: number): CellHold {
  const now = new Date();
  return {
    cellId,
    sessionId,
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + holdMs).toISOString(),
  };
}

export function PosterApp() {
  const [snapshot, setSnapshot] = useState<PosterSnapshot | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [zoomPhase, setZoomPhase] = useState<"enter" | "idle" | "exit">("idle");
  const [sessionId, setSessionId] = useState("");
  const [message, setMessage] = useState("");
  const [showPrintTools, setShowPrintTools] = useState(false);
  const [replayStartedAt, setReplayStartedAt] = useState<number | null>(null);
  const [replayElapsed, setReplayElapsed] = useState(0);
  const [replayMode, setReplayMode] = useState<ReplayMode>("simultaneous");
  const [isSaving, setIsSaving] = useState(false);

  const selectedRef = useRef<Selection | null>(null);
  const optimisticDrawingsRef = useRef<Map<string, CellDrawing>>(new Map());
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  selectedRef.current = selection;
  const cameraStyle = useMemo(() => (selection ? getCameraStyle(selection.camera) : undefined), [selection]);
  const posterX = useMotionValue(0);
  const posterY = useMotionValue(0);
  const posterScale = useMotionValue(1);
  const panelX = useMotionValue(0);
  const panelY = useMotionValue(0);
  const panelScale = useMotionValue(1);
  const posterMotionStyle = useMemo(
    () =>
      ({
        x: posterX,
        y: posterY,
        scale: posterScale,
      }) satisfies PosterMotionStyle,
    [posterScale, posterX, posterY],
  );
  const zoomPanelMotionStyle = useMemo(
    () =>
      ({
        ...cameraStyle?.target,
        x: panelX,
        y: panelY,
        scale: panelScale,
      }) satisfies ZoomPanelMotionStyle,
    [cameraStyle?.target, panelScale, panelX, panelY],
  );

  const config = snapshot?.config;
  const cellIds = useMemo(() => (config ? getCellIds(config) : []), [config]);
  const drawingsById = useMemo(() => {
    const map = new Map<string, CellDrawing>();
    for (const cell of snapshot?.cells ?? []) map.set(cell.id, cell);
    return map;
  }, [snapshot]);

  const orderedDrawings = useMemo(() => getOrderedDrawings(snapshot?.cells ?? []), [snapshot]);

  const holdsById = useMemo(() => {
    const map = new Map<string, CellHold>();
    const now = Date.now();
    for (const hold of snapshot?.holds ?? []) {
      if (new Date(hold.expiresAt).getTime() > now) map.set(hold.cellId, hold);
    }
    return map;
  }, [snapshot]);

  const withOptimisticDrawings = useCallback((next: PosterSnapshot) => applyOptimisticDrawings(next, optimisticDrawingsRef.current), []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/poster", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load poster");
    const next = (await response.json()) as PosterSnapshot;
    setSnapshot(withOptimisticDrawings(next));
  }, [withOptimisticDrawings]);

  useEffect(() => {
    let existing = window.localStorage.getItem("scribbles-session-id");
    if (!existing) {
      existing = crypto.randomUUID();
      window.localStorage.setItem("scribbles-session-id", existing);
    }
    setSessionId(existing);
    setShowPrintTools(new URLSearchParams(window.location.search).get("print") === "1");
    refresh().catch(() => setMessage("Could not load poster."));

    let timer = 0;
    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      const delay = document.hidden ? hiddenRefreshMs : visibleRefreshMs;
      timer = window.setTimeout(() => {
        refresh().catch(() => undefined).finally(scheduleRefresh);
      }, delay);
    };
    const refreshNow = () => {
      refresh().catch(() => undefined);
      scheduleRefresh();
    };

    scheduleRefresh();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", refreshNow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", refreshNow);
    };
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
      })
        .then(async (response) => {
          if (response.ok) return;
          const result = (await response.json().catch(() => null)) as { reason?: string } | null;
          if (response.status === 410 || result?.reason === "invalid") {
            setSelection(null);
            setZoomPhase("idle");
            setMessage("Your cell hold expired. Pick another open cell.");
            await refresh().catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, heartbeatMs);
    return () => window.clearInterval(timer);
  }, [refresh, selection, sessionId]);

  useEffect(() => {
    if (replayStartedAt === null || !config) return;
    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - replayStartedAt;
      const duration = getReplayDuration(replayMode, orderedDrawings.length, config);
      setReplayElapsed(Math.min(elapsed, duration));
      if (elapsed < duration) frame = requestAnimationFrame(tick);
      else setReplayStartedAt(null);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [config, orderedDrawings.length, replayMode, replayStartedAt]);

  useLayoutEffect(() => {
    if (!selection || !cameraStyle) {
      posterX.set(0);
      posterY.set(0);
      posterScale.set(1);
      panelX.set(0);
      panelY.set(0);
      panelScale.set(1);
      return;
    }

    if (zoomPhase === "idle") return;

    const posterTarget = zoomPhase === "exit" ? { x: 0, y: 0, scale: 1 } : cameraStyle.posterMotion;
    const panelTarget = zoomPhase === "exit" ? cameraStyle.targetMotion : { x: 0, y: 0, scale: 1 };
    const transition = zoomPhase === "exit" ? cameraExitTransition : cameraTransition;

    if (zoomPhase === "enter") {
      panelX.set(cameraStyle.targetMotion.x);
      panelY.set(cameraStyle.targetMotion.y);
      panelScale.set(cameraStyle.targetMotion.scale);
    }

    const controls = [
      animate(posterX, posterTarget.x, transition),
      animate(posterY, posterTarget.y, transition),
      animate(posterScale, posterTarget.scale, transition),
      animate(panelX, panelTarget.x, transition),
      animate(panelY, panelTarget.y, transition),
      animate(panelScale, panelTarget.scale, transition),
    ];
    return () => {
      for (const control of controls) control.stop();
    };
  }, [cameraStyle, panelScale, panelX, panelY, posterScale, posterX, posterY, selection, zoomPhase]);

  useEffect(() => {
    const release = () => {
      const current = selectedRef.current;
      if (current?.kind !== "edit") return;
      navigator.sendBeacon?.(
        `/api/cells/${current.cellId}/hold`,
        new Blob([JSON.stringify({ action: "release", sessionId, holdStartedAt: current.hold.startedAt })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [sessionId]);

  const navigateView = useCallback(
    (direction: GridNavigationDirection) => {
      if (!selection || selection.kind !== "view" || !config) return;

      const targetId = getDirectionalCellId(selection.cellId, [...drawingsById.keys()], config, direction);
      if (!targetId) return;

      const drawing = drawingsById.get(targetId);
      const camera = getCameraForCell(targetId, selection.camera, config, cellIds);
      if (!drawing || !camera) return;

      setMessage("");
      setSelection({ kind: "view", cellId: targetId, drawing, camera });
      setZoomPhase("enter");
    },
    [cellIds, config, drawingsById, selection],
  );

  useEffect(() => {
    if (!selection || selection.kind !== "view") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const direction = getDirectionFromKey(event.key);
      if (!direction) return;
      event.preventDefault();
      navigateView(direction);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateView, selection]);

  function beginSwipe(event: PointerEvent<HTMLDivElement>) {
    if (selection?.kind !== "view" || event.pointerType === "mouse") return;
    swipeStartRef.current = { x: event.clientX, y: event.clientY };
  }

  function endSwipe(event: PointerEvent<HTMLDivElement>) {
    if (selection?.kind !== "view" || event.pointerType === "mouse") return;
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;

    const direction = getDirectionFromSwipe(event.clientX - start.x, event.clientY - start.y);
    if (direction) navigateView(direction);
  }

  async function openCell(cellId: string, camera: CameraFrame) {
    if (!snapshot || !sessionId || !config) return;
    setMessage("");

    const drawing = drawingsById.get(cellId);
    if (drawing) {
      setSelection({ kind: "view", cellId, drawing, camera });
      setZoomPhase("enter");
      return;
    }

    const hold = holdsById.get(cellId);
    if (hold) {
      setMessage(hold.sessionId === sessionId ? "That cell is already held." : "That cell is currently held by someone else.");
      return;
    }

    const optimisticHold = createOptimisticHold(cellId, sessionId, config.holdMs);
    setSelection({ kind: "edit", cellId, hold: optimisticHold, camera, isClaiming: true });
    setZoomPhase("enter");
    setSnapshot((current) =>
      current
        ? {
            ...current,
            holds: [...current.holds.filter((item) => item.cellId !== cellId), optimisticHold],
          }
        : current,
    );

    const response = await fetch(`/api/cells/${cellId}/hold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "acquire", sessionId }),
    });
    const result = (await response.json()) as { ok: boolean; reason?: string; hold?: CellHold };

    if (!response.ok || !result.ok || !result.hold) {
      setMessage(result.reason === "held" ? "That cell was just claimed." : "Could not claim that cell.");
      setZoomPhase("exit");
      window.setTimeout(() => {
        setSelection(null);
        setZoomPhase("idle");
      }, cameraCleanupMs);
      await refresh().catch(() => undefined);
      return;
    }

    const confirmedHold = result.hold;
    const currentSelection = selectedRef.current;
    if (currentSelection?.kind !== "edit" || currentSelection.cellId !== cellId) {
      fetch(`/api/cells/${cellId}/hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", sessionId, holdStartedAt: confirmedHold.startedAt }),
      }).catch(() => undefined);
      return;
    }

    setSelection((current) => (current?.kind === "edit" && current.cellId === cellId ? { ...current, hold: confirmedHold, isClaiming: false } : current));
    setSnapshot((current) =>
      current
        ? {
            ...current,
            holds: [...current.holds.filter((item) => item.cellId !== cellId), confirmedHold],
          }
        : current,
    );
  }

  async function closeSelection() {
    if (!selection) return;

    setZoomPhase("exit");

    if (selection?.kind === "edit") {
      const releasedCellId = selection.cellId;
      setSnapshot((current) =>
        current
          ? {
              ...current,
              holds: current.holds.filter((item) => item.cellId !== releasedCellId),
            }
          : current,
      );
      fetch(`/api/cells/${selection.cellId}/hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", sessionId, holdStartedAt: selection.hold.startedAt }),
      }).catch(() => undefined);
    }

    window.setTimeout(() => {
      setSelection(null);
      setZoomPhase("idle");
    }, cameraCleanupMs);
  }

  async function saveDrawing(drawing: CellDrawing, hold: CellHold) {
    optimisticDrawingsRef.current.set(drawing.id, drawing);
    setSnapshot((current) => (current ? upsertDrawing(withOptimisticDrawings(current), drawing) : current));
    setMessage("Saved.");
    setZoomPhase("exit");
    setIsSaving(true);

    window.setTimeout(() => {
      setSelection(null);
      setZoomPhase("idle");
    }, cameraCleanupMs);

    try {
      const response = await fetch(`/api/cells/${drawing.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, holdStartedAt: hold.startedAt, hold, drawing }),
      });

      if (!response.ok) {
        optimisticDrawingsRef.current.delete(drawing.id);
        setSnapshot((current) => (current ? rollbackOptimisticDrawing(current, drawing) : current));
        setMessage(getSaveErrorMessage(response.status));
        await refresh().catch(() => undefined);
        return;
      }

      const savedDrawing = (await response.json()) as CellDrawing;
      optimisticDrawingsRef.current.set(savedDrawing.id, savedDrawing);
      setSnapshot((current) => (current ? upsertDrawing(current, savedDrawing) : current));
      setMessage("Saved.");
    } catch {
      optimisticDrawingsRef.current.delete(drawing.id);
      setSnapshot((current) => (current ? rollbackOptimisticDrawing(current, drawing) : current));
      setMessage("Could not save. Check your connection and try another cell.");
      await refresh().catch(() => undefined);
    } finally {
      setIsSaving(false);
    }
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
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(0.45 * scale)}px Arial, sans-serif`;
    ctx.fillText(config.title, canvas.width * 0.05, (config.titleHeightIn * scale) / 2);

    const cellPx = config.cellSizeIn * scale;
    const xStart = config.gridOffsetXIn * scale;
    const yStart = (config.titleHeightIn + config.gridOffsetYIn) * scale;
    for (const id of cellIds) {
      const index = cellIds.indexOf(id);
      const col = index % config.columns;
      const row = Math.floor(index / config.columns);
      const x = xStart + col * cellPx;
      const y = yStart + row * cellPx;
      const drawing = drawingsById.get(id);
      if (!drawing) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(cellPx / config.canvasSize, cellPx / config.canvasSize);
      drawStrokes(ctx, drawing.strokes, config.canvasSize);
      drawAuthorLabel(ctx, drawing.name, config.canvasSize);
      ctx.restore();
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
  const zoomCanvasScale = selection && cameraStyle ? getZoomCanvasScale(cameraStyle.posterMotion.scale) : 1;
  const replayByCellId = replayActive && config ? getReplayByCellId(replayMode, replayElapsed, orderedDrawings, config) : new Map<string, CellReplay>();

  return (
    <main className={`app ${selection ? "zoomActive" : ""} ${zoomPhase === "exit" ? "zoomClosing" : "zoomOpening"}`}>
      <section className="stage" aria-label="Collaborative poster">
        <motion.div
          className="poster"
          style={
            {
              "--poster-width": config.posterWidthIn,
              "--poster-height": config.posterHeightIn,
              "--title-height": config.titleHeightIn,
              "--columns": config.columns,
              "--rows": config.rows,
              "--grid-width-percent": `${(config.gridWidthIn / config.posterWidthIn) * 100}%`,
              "--grid-height-percent": `${(config.gridHeightIn / (config.posterHeightIn - config.titleHeightIn)) * 100}%`,
              ...posterMotionStyle,
              ...cameraStyle?.poster,
            } as PosterMotionStyle
          }
          initial={false}
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
                replay={replayByCellId.get(cellId) ?? null}
                renderScale={isZoomNeighborCell(cellIds, cellId, selection?.cellId, config) ? zoomCanvasScale : 1}
                onOpen={(camera) => openCell(cellId, camera)}
              />
            ))}
          </div>
        </motion.div>
      </section>

      <div className="toolbar noPrint">
        <button className={`iconButton ${replayMode === "simultaneous" ? "active" : ""}`} type="button" onClick={() => setReplayMode("simultaneous")}>
          All
        </button>
        <button className={`iconButton ${replayMode === "sequential" ? "active" : ""}`} type="button" onClick={() => setReplayMode("sequential")}>
          Seq
        </button>
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
          phase={zoomPhase}
          style={zoomPanelMotionStyle}
          onPointerDown={beginSwipe}
          onPointerUp={endSwipe}
          onPointerCancel={() => {
            swipeStartRef.current = null;
          }}
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
  replay,
  renderScale,
  onOpen,
}: {
  cellId: string;
  config: PosterConfig;
  drawing?: CellDrawing;
  hold?: CellHold;
  ownSessionId: string;
  replay: CellReplay | null;
  renderScale: number;
  onOpen: (camera: CameraFrame) => void;
}) {
  const hasHold = Boolean(hold && !drawing);
  const heldByOther = Boolean(hasHold && hold?.sessionId !== ownSessionId);
  const heldByOwner = Boolean(hasHold && hold?.sessionId === ownSessionId);
  const isAvailable = !drawing && !hasHold;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (hasHold) return;
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
      className={`cell ${drawing ? "occupied" : ""} ${hasHold ? "held" : ""} ${heldByOther ? "heldOther" : ""} ${heldByOwner ? "heldOwn" : ""} ${isAvailable ? "available" : ""}`}
      type="button"
      disabled={hasHold}
      onClick={handleClick}
      aria-label={`${cellId}${drawing ? ` by ${drawing.name}` : hasHold ? (heldByOwner ? " held by you" : " held") : " empty"}`}
    >
      <DrawingCanvas drawing={drawing} config={config} replay={replay} renderScale={renderScale} />
      {hasHold ? <span className="cellHeld">{heldByOwner ? "Yours" : "Held"}</span> : null}
    </button>
  );
}

function DrawingCanvas({
  drawing,
  config,
  replay,
  renderScale = 1,
}: {
  drawing?: CellDrawing;
  config: PosterConfig;
  replay: CellReplay | null;
  renderScale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const backingScale = Math.max(1, renderScale);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr * backingScale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr * backingScale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(canvas.width / config.canvasSize, 0, 0, canvas.height / config.canvasSize, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, config.canvasSize, config.canvasSize);
      if (!drawing) return;

      if (replay === null) {
        drawStrokes(ctx, drawing.strokes, config.canvasSize);
        drawAuthorLabel(ctx, drawing.name, config.canvasSize);
        return;
      }

      if (replay.elapsedMs > 0) {
        const sourceDuration = getStrokeDuration(drawing.strokes);
        const replayDuration = replay.durationMs ?? Math.min(sourceDuration, config.maxReplayMs);
        const untilMs = replayDuration <= 0 ? sourceDuration : Math.min(sourceDuration, (replay.elapsedMs / replayDuration) * sourceDuration);
        drawStrokes(ctx, drawing.strokes, config.canvasSize, { untilMs });
      }
      drawAuthorLabel(ctx, drawing.name, config.canvasSize);
    };

    render();
    const timer = window.setTimeout(render, cameraMs + 40);
    return () => window.clearTimeout(timer);
  }, [config, drawing, replay, renderScale]);

  return <canvas ref={canvasRef} className="drawingCanvas" />;
}

function CellOverlay({
  selection,
  config,
  sessionId,
  isSaving,
  phase,
  style,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onClose,
  onSave,
}: {
  selection: Selection;
  config: PosterConfig;
  sessionId: string;
  isSaving: boolean;
  phase: "enter" | "idle" | "exit";
  style: ZoomPanelMotionStyle;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onClose: () => void;
  onSave: (drawing: CellDrawing, hold: CellHold) => void;
}) {
  return (
    <div className="overlay noPrint">
      {selection.kind === "edit" ? (
        <motion.div aria-hidden="true" className={`drawGuideFrame ${phase === "exit" ? "closing" : "opening"}`} style={style}>
          <span className="drawGuideLine drawGuideLineTop" />
          <span className="drawGuideLine drawGuideLineRight" />
          <span className="drawGuideLine drawGuideLineBottom" />
          <span className="drawGuideLine drawGuideLineLeft" />
        </motion.div>
      ) : null}
      <motion.div
        className={`zoomPanel ${phase === "exit" ? "closing" : "opening"}`}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        style={style}
      >
        {selection.kind === "view" ? (
          <ReadOnlyCell drawing={selection.drawing} config={config} onClose={onClose} />
        ) : (
          <Editor
            cellId={selection.cellId}
            hold={selection.hold}
            config={config}
            sessionId={sessionId}
            isClaiming={selection.isClaiming}
            isSaving={isSaving}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </motion.div>
    </div>
  );
}

function getCameraForCell(cellId: string, sourceCamera: CameraFrame, config: PosterConfig, cellIds: string[]): CameraFrame | null {
  const cellIndex = cellIds.indexOf(cellId);
  if (cellIndex < 0) return null;

  const poster = sourceCamera.poster;
  const titleHeightPx = poster.height * (config.titleHeightIn / config.posterHeightIn);
  const drawableHeightPx = poster.height - titleHeightPx;
  const gridWidthPx = poster.width * (config.gridWidthIn / config.posterWidthIn);
  const gridHeightPx = drawableHeightPx * (config.gridHeightIn / (config.posterHeightIn - config.titleHeightIn));
  const gridLeft = poster.x + (poster.width - gridWidthPx) / 2;
  const gridTop = poster.y + titleHeightPx + (drawableHeightPx - gridHeightPx) / 2;
  const cellWidth = gridWidthPx / config.columns;
  const cellHeight = gridHeightPx / config.rows;
  const col = cellIndex % config.columns;
  const row = Math.floor(cellIndex / config.columns);

  return {
    cell: {
      x: gridLeft + col * cellWidth,
      y: gridTop + row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    },
    poster,
  };
}

function getDirectionFromKey(key: string): GridNavigationDirection | null {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

function getDirectionFromSwipe(dx: number, dy: number): GridNavigationDirection | null {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const minSwipePx = 42;
  if (Math.max(absX, absY) < minSwipePx) return null;

  if (absX >= absY) return dx < 0 ? "right" : "left";
  return dy < 0 ? "down" : "up";
}

function getCameraStyle(camera: CameraFrame): CameraStyle {
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
      "--zoom-from-x": `${camera.cell.x}px`,
      "--zoom-from-y": `${camera.cell.y}px`,
      "--zoom-from-size": `${Math.max(camera.cell.width, camera.cell.height)}px`,
      "--zoom-dx": `${camera.cell.x - targetLeft}px`,
      "--zoom-dy": `${camera.cell.y - targetTop}px`,
      "--zoom-scale": Math.max(camera.cell.width, camera.cell.height) / targetSize,
      "--zoom-to-x": `${targetLeft}px`,
      "--zoom-to-y": `${targetTop}px`,
      "--zoom-to-size": `${targetSize}px`,
    } as CSSProperties,
    posterMotion: {
      x: targetLeft - camera.poster.x - cellOffsetX * scale,
      y: targetTop - camera.poster.y - cellOffsetY * scale,
      scale,
    },
    targetMotion: {
      x: camera.cell.x - targetLeft,
      y: camera.cell.y - targetTop,
      scale: Math.max(camera.cell.width, camera.cell.height) / targetSize,
      opacity: 1,
    },
  };
}

function getZoomCanvasScale(cameraScale: number) {
  return Math.max(1, Math.min(maxZoomCanvasScale, Math.ceil(cameraScale)));
}

function drawAuthorLabel(ctx: CanvasRenderingContext2D, name: string, canvasSize: number) {
  const margin = canvasSize * authorLabelMarginRatio;
  ctx.save();
  ctx.fillStyle = "#9a9a9a";
  ctx.font = `600 ${Math.round(canvasSize * authorLabelFontRatio)}px Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(name, margin, canvasSize - margin, canvasSize - margin * 2);
  ctx.restore();
}

function isZoomNeighborCell(cellIds: string[], cellId: string, selectedCellId: string | undefined, config: PosterConfig) {
  if (!selectedCellId) return false;
  const cellIndex = cellIds.indexOf(cellId);
  const selectedIndex = cellIds.indexOf(selectedCellId);
  if (cellIndex < 0 || selectedIndex < 0) return false;

  const cellCol = cellIndex % config.columns;
  const cellRow = Math.floor(cellIndex / config.columns);
  const selectedCol = selectedIndex % config.columns;
  const selectedRow = Math.floor(selectedIndex / config.columns);

  return (
    Math.abs(cellCol - selectedCol) <= zoomCanvasNeighborRadius &&
    Math.abs(cellRow - selectedRow) <= zoomCanvasNeighborRadius
  );
}

function getOrderedDrawings(drawings: CellDrawing[]) {
  return [...drawings].sort((a, b) => {
    const byOrder = getDrawOrder(a) - getDrawOrder(b);
    if (byOrder !== 0) return byOrder;
    const byCreatedAt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id.localeCompare(b.id);
  });
}

function getDrawOrder(drawing: CellDrawing) {
  return Number.isFinite(drawing.drawOrder) && drawing.drawOrder > 0 ? drawing.drawOrder : Number.MAX_SAFE_INTEGER;
}

function getSaveErrorMessage(status: number) {
  if (status === 400) return "Could not save. Refresh and try again.";
  if (status === 409) return "That cell was already saved.";
  if (status === 423) return "Could not save. Your hold may have expired.";
  return "Could not save. Check your connection and try another cell.";
}

function getReplayDuration(mode: ReplayMode, drawingCount: number, config: PosterConfig) {
  if (mode === "simultaneous") return config.maxReplayMs;
  return Math.max(config.sequentialReplayCellMs, drawingCount * config.sequentialReplayCellMs);
}

function getReplayByCellId(mode: ReplayMode, elapsedMs: number, drawings: CellDrawing[], config: PosterConfig) {
  const map = new Map<string, CellReplay>();

  if (mode === "simultaneous") {
    for (const drawing of drawings) {
      map.set(drawing.id, { elapsedMs });
    }
    return map;
  }

  drawings.forEach((drawing, index) => {
    const startMs = index * config.sequentialReplayCellMs;
    const localElapsedMs = Math.max(0, Math.min(config.sequentialReplayCellMs, elapsedMs - startMs));
    map.set(drawing.id, {
      elapsedMs: localElapsedMs,
      durationMs: config.sequentialReplayCellMs,
    });
  });

  return map;
}

function ReadOnlyCell({ drawing, config, onClose }: { drawing: CellDrawing; config: PosterConfig; onClose: () => void }) {
  return (
    <>
      <div className="editorCanvasWrap readOnly">
        <DrawingCanvas drawing={drawing} config={config} replay={null} />
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
  isClaiming,
  isSaving,
  onClose,
  onSave,
}: {
  cellId: string;
  hold: CellHold;
  config: PosterConfig;
  sessionId: string;
  isClaiming: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: (drawing: CellDrawing, hold: CellHold) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const drawingStartedAtRef = useRef(performance.now());
  const strokeStartedAtRef = useRef(0);
  const [strokesVersion, setStrokesVersion] = useState(0);
  const [color, setColor] = useState(config.palette[0]);
  const [name, setName] = useState("");

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
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      redraw();
    };
    resize();
    const timer = window.setTimeout(resize, cameraMs + 40);
    window.addEventListener("resize", resize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", resize);
    };
  }, [redraw]);

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
    if (activePointerIdRef.current !== null) return;
    if (event.pointerType !== "mouse") event.preventDefault();

    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const didCommitCurrentStroke = commitCurrentStroke();
    strokeStartedAtRef.current = performance.now();
    currentStrokeRef.current = {
      id: crypto.randomUUID(),
      order: strokesRef.current.length,
      startedAt: Math.max(0, strokeStartedAtRef.current - drawingStartedAtRef.current),
      color,
      width: config.strokeWidth,
      points: [getPoint(event)],
    };
    if (didCommitCurrentStroke || strokesRef.current.length === 0) {
      setStrokesVersion((value) => value + 1);
    }
    redraw();
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.pointerType !== "mouse") event.preventDefault();
    if (!currentStrokeRef.current) return;
    const points = currentStrokeRef.current.points;
    const next = getPoint(event);
    const previous = points[points.length - 1];
    if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < 2) return;
    points.push(next);
    redraw();
  }

  function finishStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.pointerType !== "mouse") event.preventDefault();
    activePointerIdRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!commitCurrentStroke()) return;
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function commitCurrentStroke() {
    const currentStroke = currentStrokeRef.current;
    if (!currentStroke) return false;
    strokesRef.current = [...strokesRef.current, currentStroke];
    currentStrokeRef.current = null;
    return true;
  }

  function undo() {
    if (currentStrokeRef.current) {
      currentStrokeRef.current = null;
      activePointerIdRef.current = null;
      setStrokesVersion((value) => value + 1);
      redraw();
      return;
    }
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function clear() {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    activePointerIdRef.current = null;
    setStrokesVersion((value) => value + 1);
    redraw();
  }

  function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const didCommitCurrentStroke = commitCurrentStroke();
    if (didCommitCurrentStroke) {
      setStrokesVersion((value) => value + 1);
    }
    const now = new Date().toISOString();
    onSave(
      {
        id: cellId,
        drawOrder: 0,
        name: trimmedName,
        strokes: strokesRef.current,
        createdAt: now,
        updatedAt: now,
      },
      hold,
    );
  }

  const hasStrokeContent = strokesRef.current.length > 0 || currentStrokeRef.current !== null;
  const hasName = name.trim().length > 0;

  return (
    <>
      <div className="editorCanvasWrap editing">
        <canvas
          ref={canvasRef}
          className="editorCanvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onLostPointerCapture={finishStroke}
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
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" required />
        <button type="button" onClick={undo} disabled={!hasStrokeContent || isSaving}>
          Undo
        </button>
        <button type="button" onClick={clear} disabled={!hasStrokeContent || isSaving}>
          Clear
        </button>
        <button type="button" onClick={onClose} disabled={isSaving}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={isClaiming || isSaving || !hasStrokeContent || !hasName} data-primary>
          {isSaving ? "Saving" : isClaiming ? "Claiming" : "Save"}
        </button>
        <span className="srOnly">{strokesVersion}</span>
      </div>
    </>
  );
}
