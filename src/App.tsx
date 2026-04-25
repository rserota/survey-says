import { useEffect, useState } from "react";
import { Lobby } from "./components/Lobby";
import { GameBoard } from "./components/GameBoard";
import type { GameState, PlayerSession, ServerMessage } from "./types";
import "./App.css";

interface StoredSession {
  roomCode: string;
  session: PlayerSession;
}

const SESSION_STORAGE_KEY = "survey-says-session";

export default function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadStoredSession();
    if (saved) {
      connectToRoom(saved.roomCode, { type: "rejoin", playerId: saved.session.playerId });
    }
  }, []);

  function leaveRoom() {
    ws?.close();
    setWs(null);
    setGameState(null);
    setRoomCode(null);
    setSession(null);
    clearStoredSession();
  }

  function connectToRoom(
    code: string,
    joinRequest: { type: "join"; teamName: string; playerName: string } | { type: "rejoin"; playerId: string },
  ) {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/api/rooms/${code}/ws`);
    const isRejoin = joinRequest.type === "rejoin";

    socket.addEventListener("open", () => {
      setError(null);
      socket.send(JSON.stringify(joinRequest));
    });

    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      if (msg.type === "state_update") {
        setGameState(msg.state);
        setError(null);
      }
      if (msg.type === "joined") {
        setSession(msg.session);
        storeSession({ roomCode: code, session: msg.session });
      }
      if (msg.type === "error") {
        setError(msg.message);
        if (isRejoin) {
          clearStoredSession();
          setGameState(null);
          setRoomCode(null);
          setSession(null);
          setWs(null);
          socket.close();
        }
      }
    });

    socket.addEventListener("close", () => {
      setWs(null);
    });

    setWs(socket);
    setRoomCode(code);
  }

  async function createRoom(teamName: string, playerName: string) {
    const res = await fetch("/api/rooms", { method: "POST" });
    const { roomCode: code } = (await res.json()) as { roomCode: string };
    connectToRoom(code, { type: "join", teamName, playerName });
  }

  function joinRoom(code: string, teamName: string, playerName: string) {
    connectToRoom(code, { type: "join", teamName, playerName });
  }

  function send(msg: object) {
    ws?.send(JSON.stringify(msg));
  }

  if (!gameState || !roomCode || !ws) {
    return <Lobby onCreate={createRoom} onJoin={joinRoom} error={error} />;
  }

  return <GameBoard state={gameState} roomCode={roomCode} send={send} session={session} error={error} onLeave={leaveRoom} />;
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function storeSession(value: StoredSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
}

function clearStoredSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}
