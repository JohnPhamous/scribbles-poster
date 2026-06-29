import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellHold } from "./types";

const blobStore = new Map<string, unknown>();
const del = vi.fn(async (path: string) => {
  blobStore.delete(path);
});

vi.mock("@vercel/blob", () => ({
  del,
  get: vi.fn(async (path: string) => {
    if (!blobStore.has(path)) return null;
    return {
      statusCode: 200,
      stream: new Response(JSON.stringify(blobStore.get(path))).body,
    };
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: Array.from(blobStore.keys())
      .filter((pathname) => pathname.startsWith(prefix))
      .map((pathname) => ({ pathname })),
  })),
  put: vi.fn(async (path: string, body: string, options: { allowOverwrite?: boolean }) => {
    if (!options.allowOverwrite && blobStore.has(path)) {
      throw new Error("Blob already exists");
    }
    blobStore.set(path, JSON.parse(body));
    return {};
  }),
}));

describe("storage", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    blobStore.clear();
    del.mockClear();
  });

  it("does not delete a Blob hold owned by another session", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    const hold = makeHold({ cellId: "r1c1", sessionId: "owner" });
    blobStore.set("holds/r1c1/claim.json", hold);
    const { deleteHold } = await import("./storage");

    await deleteHold("r1c1", "intruder");

    expect(del).not.toHaveBeenCalled();
    expect(blobStore.get("holds/r1c1/claim.json")).toEqual(hold);
  });

  it("deletes a Blob hold for the owning session", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    blobStore.set("holds/r1c1/claim.json", makeHold({ cellId: "r1c1", sessionId: "owner" }));
    const { deleteHold } = await import("./storage");

    await deleteHold("r1c1", "owner");

    expect(del).toHaveBeenCalledWith("holds/r1c1/claim.json");
    expect(blobStore.has("holds/r1c1/claim.json")).toBe(false);
  });

  it("does not delete a newer hold for the same session when the hold timestamp does not match", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    const hold = makeHold({ cellId: "r1c1", sessionId: "owner", startedAt: "2026-01-01T00:01:00.000Z" });
    blobStore.set("holds/r1c1/claim.json", hold);
    const { deleteHold } = await import("./storage");

    await deleteHold("r1c1", "owner", "2026-01-01T00:00:00.000Z");

    expect(del).not.toHaveBeenCalled();
    expect(blobStore.get("holds/r1c1/claim.json")).toEqual(hold);
  });

  it("filters and deletes stale Blob holds when listing active holds", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    const active = makeHold({ cellId: "r1c2", sessionId: "active" });
    blobStore.set("holds/r1c1/claim.json", makeHold({ cellId: "r1c1", sessionId: "expired", expiresAt: "2020-01-01T00:00:00.000Z" }));
    blobStore.set("holds/r1c2/claim.json", active);
    const { listActiveHolds } = await import("./storage");

    await expect(listActiveHolds()).resolves.toEqual([active]);

    expect(del).toHaveBeenCalledWith("holds/r1c1/claim.json");
    expect(blobStore.has("holds/r1c1/claim.json")).toBe(false);
  });

  it("treats expired session holds as missing", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    blobStore.set("holds/r1c1/claim.json", makeHold({ cellId: "r1c1", sessionId: "owner", expiresAt: "2020-01-01T00:00:00.000Z" }));
    const { getSessionHold } = await import("./storage");

    await expect(getSessionHold("r1c1", "owner")).resolves.toBeNull();
  });

  it("treats same-session holds with a different timestamp as missing", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    blobStore.set("holds/r1c1/claim.json", makeHold({ cellId: "r1c1", sessionId: "owner", startedAt: "2026-01-01T00:01:00.000Z" }));
    const { getSessionHold } = await import("./storage");

    await expect(getSessionHold("r1c1", "owner", "2026-01-01T00:00:00.000Z")).resolves.toBeNull();
  });

  it("bypasses stale cell list cache when assigning draw order", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    blobStore.set("cells/r1c1.json", makeDrawing("r1c1", 1));
    blobStore.set("holds/r1c3/claim.json", makeHold({ cellId: "r1c3", sessionId: "owner" }));
    const { listCells, saveCell } = await import("./storage");
    await listCells();
    blobStore.set("cells/r1c2.json", makeDrawing("r1c2", 5));

    const saved = await saveCell(makeDrawing("r1c3", 0));

    expect(saved).toMatchObject({ id: "r1c3", drawOrder: 6 });
  });

  it("returns held when replacing an expired Blob hold loses the race", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "token");
    const winner = makeHold({
      cellId: "r1c1",
      sessionId: "winner",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    blobStore.set(
      "holds/r1c1/claim.json",
      makeHold({ cellId: "r1c1", sessionId: "expired", expiresAt: "2020-01-01T00:00:00.000Z" }),
    );
    del.mockImplementationOnce(async (path: string) => {
      blobStore.delete(path);
      blobStore.set(path, winner);
    });
    const { acquireHold } = await import("./storage");

    const result = await acquireHold("r1c1", "challenger");

    expect(result).toEqual({ ok: false, reason: "held", hold: winner });
  });
});

function makeHold(overrides: Partial<CellHold>): CellHold {
  return {
    cellId: "r1c1",
    sessionId: "owner",
    startedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function makeDrawing(id: string, drawOrder: number) {
  return {
    id,
    drawOrder,
    name: id,
    strokes: [
      {
        id: `${id}-stroke`,
        order: 0,
        startedAt: 0,
        color: "#E63946",
        width: 14,
        points: [
          { x: 1, y: 1, t: 0 },
          { x: 2, y: 2, t: 10 },
        ],
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
