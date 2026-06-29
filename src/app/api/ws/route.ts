import { experimental_upgradeWebSocket, type WebSocketData } from "@vercel/functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sockets = new Set<{ send: (data: string) => void }>();

export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    sockets.add(ws);

    ws.on("message", (data: WebSocketData) => {
      const message = typeof data === "string" ? data : data.toString();
      for (const socket of sockets) {
        try {
          socket.send(message);
        } catch {
          sockets.delete(socket);
        }
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
    });
  });
}
