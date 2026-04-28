// ── Game state ────────────────────────────────────────────────────────────────

export type GamePhase =
  | "lobby"        // waiting for players
  | "question"     // question on screen, teams can buzz
  | "guessing"     // a team is actively guessing
  | "reveal"       // revealing all answers after round ends
  | "gameover";    // game finished

export interface Answer {
  text: string;
  points: number;
  revealed: boolean;
}

export interface Player {
  id: string;
  name: string;
}

export interface Question {
  prompt: string;
  answers: Answer[]; // ordered by point value descending
}

export interface Team {
  id: string;
  name: string;
  players: Player[];
  score: number;
  strikes: number; // 0-3; 3 = strike-out
}

export interface GameState {
  roomCode: string;
  phase: GamePhase;
  teams: Team[];
  currentQuestionIndex: number;
  questions: Question[];
  activeTeamId: string | null;
  lastRoundStarterTeamId?: string | null;
  roundControlPassed?: boolean;
  hostTeamId: string | null;
  hostMessage: string;
}

export interface PlayerSession {
  playerId: string;
  playerName: string;
  teamId: string;
  teamName: string;
  isHost: boolean;
}

// ── WebSocket messages (client → server) ─────────────────────────────────────

export type ClientMessage =
  | { type: "join"; teamName: string; playerName: string }
  | { type: "rejoin"; playerId: string }
  | { type: "start_game" }
  | { type: "guess"; answer: string }
  | { type: "pass" }           // pass control to other team
  | { type: "next_question" }; // host/admin advances

// ── WebSocket messages (server → client) ─────────────────────────────────────

export type ServerMessage =
  | { type: "joined"; session: PlayerSession }
  | { type: "state_update"; state: GameState }
  | { type: "host_message"; message: string }
  | { type: "error"; message: string };
