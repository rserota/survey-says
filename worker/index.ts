import { GameRoom } from "./GameRoom";

export { GameRoom };

function generateRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Room creation: POST /api/rooms ──────────────────────────────────────
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const roomCode = generateRoomCode();
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      await stub.fetch(new Request(`https://internal/init/${roomCode}`, { method: "POST" }));
      return Response.json({ roomCode });
    }

    // ── WebSocket upgrade: GET /api/rooms/:code/ws ──────────────────────────
    const wsMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/ws$/);
    if (wsMatch && request.headers.get("Upgrade") === "websocket") {
      const roomCode = wsMatch[1];
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // ── Room info: GET /api/rooms/:code ─────────────────────────────────────
    const infoMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)$/);
    if (infoMatch && request.method === "GET") {
      const roomCode = infoMatch[1];
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(new Request("https://internal/", { method: "GET" }));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
