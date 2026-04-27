import type { GameState, Question, Team, ClientMessage, ServerMessage, PlayerSession, Player } from "../src/types";

// ── Sample questions ──────────────────────────────────────────────────────────
const SAMPLE_QUESTIONS: Question[] = [
  {
    prompt: "Name something people do first thing in the morning.",
    answers: [
      { text: "Check their phone", points: 42, revealed: false },
      { text: "Brush teeth", points: 38, revealed: false },
      { text: "Make coffee", points: 35, revealed: false },
      { text: "Use the bathroom", points: 30, revealed: false },
      { text: "Shower", points: 22, revealed: false },
      { text: "Eat breakfast", points: 15, revealed: false },
    ],
  },
  {
    prompt: "Name something you find in a kitchen.",
    answers: [
      { text: "Refrigerator", points: 45, revealed: false },
      { text: "Stove/Oven", points: 40, revealed: false },
      { text: "Sink", points: 35, revealed: false },
      { text: "Microwave", points: 28, revealed: false },
      { text: "Dishes", points: 20, revealed: false },
    ],
  },
  {
    prompt: "Name a reason someone might be late to work.",
    answers: [
      { text: "Traffic", points: 50, revealed: false },
      { text: "Overslept", points: 44, revealed: false },
      { text: "Car trouble", points: 30, revealed: false },
      { text: "Couldn't find keys", points: 18, revealed: false },
      { text: "Bad weather", points: 15, revealed: false },
    ],
  },
];

type SessionAttachment = PlayerSession;

// ── Durable Object ────────────────────────────────────────────────────────────

export class GameRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private gameState: GameState;
  private hostMessageGeneration = 0;
  private requestSequence = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.gameState = {
      roomCode: "",
      phase: "lobby",
      teams: [],
      currentQuestionIndex: 0,
      questions: SAMPLE_QUESTIONS.map((q) => ({
        ...q,
        answers: q.answers.map((a) => ({ ...a })),
      })),
      activeTeamId: null,
      hostTeamId: null,
      hostMessage: "Welcome! Waiting for teams to join…",
    };

    this.state.blockConcurrencyWhile(async () => {
      const savedState = await this.state.storage.get<GameState>("gameState");
      if (savedState) {
        this.gameState = {
          ...savedState,
          teams: savedState.teams.map((team) => ({
            ...team,
            players: team.players ?? [],
          })),
          hostTeamId: savedState.hostTeamId ?? null,
        };
      }
    });
  }

  // ── WebSocket entry point ───────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.startsWith("/init/")) {
      const roomCode = url.pathname.split("/").at(-1) ?? "";
      if (roomCode && !this.gameState.roomCode) {
        this.gameState.roomCode = roomCode;
        await this.saveState();
      }
      return Response.json({ roomCode: this.gameState.roomCode });
    }

    const routeRoomCode = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/ws)?$/)?.[1];
    if (routeRoomCode && !this.gameState.roomCode) {
      this.gameState.roomCode = routeRoomCode;
      await this.saveState();
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      this.sendTo(server, { type: "state_update", state: this.gameState });
      return new Response(null, { status: 101, webSocket: client });
    }

    // REST: create/get room info
    if (request.method === "GET") {
      return Response.json({ roomCode: this.gameState.roomCode, phase: this.gameState.phase });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Hibernation API handlers ────────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const requestId = ++this.requestSequence;
    const startedAt = performance.now();
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage));
    } catch {
      this.sendTo(ws, { type: "error", message: "Invalid JSON" });
      this.logTiming("ws.invalid_json", requestId, startedAt);
      return;
    }

    const session = this.getSession(ws);

    switch (msg.type) {
      case "join":
        await this.timeAction("ws.join", requestId, () => this.handleJoin(ws, msg.teamName, msg.playerName));
        break;
      case "rejoin":
        await this.timeAction("ws.rejoin", requestId, () => this.handleRejoin(ws, msg.playerId));
        break;
      case "start_game":
        await this.timeAction("ws.start_game", requestId, () => this.handleStartGame(ws, session));
        break;
      case "guess":
        await this.timeAction("ws.guess", requestId, () => this.handleGuess(ws, session, msg.answer));
        break;
      case "pass":
        await this.timeAction("ws.pass", requestId, () => this.handlePass(ws, session));
        break;
      case "next_question":
        await this.timeAction("ws.next_question", requestId, () => this.handleNextQuestion(ws, session));
        break;
    }

    this.logTiming(`ws.total.${msg.type}`, requestId, startedAt);
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Connections close cleanly; no cleanup needed for game state
  }

  // ── Game logic ──────────────────────────────────────────────────────────────

  private async handleJoin(ws: WebSocket, teamName: string, playerName: string): Promise<void> {
    const existingSession = this.getSession(ws);
    if (existingSession) {
      this.sendTo(ws, { type: "joined", session: existingSession });
      this.sendTo(ws, { type: "state_update", state: this.gameState });
      return;
    }

    const normalizedTeamName = teamName.trim();
    const normalizedPlayerName = playerName.trim();

    if (!normalizedTeamName || !normalizedPlayerName) {
      this.sendTo(ws, { type: "error", message: "Enter both a team name and player name." });
      return;
    }

    if (this.gameState.phase !== "lobby") {
      this.sendTo(ws, { type: "error", message: "Game already in progress" });
      return;
    }

    const wasEmptyRoom = this.gameState.teams.length === 0;
    let team = this.findTeamByName(normalizedTeamName);

    if (!team) {
      if (this.gameState.teams.length >= 2) {
        this.sendTo(ws, { type: "error", message: "Room is full. Join one of the existing teams to enter." });
        return;
      }

      team = {
        id: crypto.randomUUID(),
        name: normalizedTeamName,
        players: [],
        score: 0,
        strikes: 0,
      };
      this.gameState.teams.push(team);
    }

    const duplicatePlayer = team.players.find((player) => player.name.toLowerCase() === normalizedPlayerName.toLowerCase());
    if (duplicatePlayer) {
      this.sendTo(ws, { type: "error", message: "That player name is already on this team. Try rejoining instead." });
      return;
    }

    const player: Player = {
      id: crypto.randomUUID(),
      name: normalizedPlayerName,
    };
    team.players.push(player);

    const session: SessionAttachment = {
      playerId: player.id,
      playerName: player.name,
      teamId: team.id,
      teamName: team.name,
      isHost: wasEmptyRoom,
    };

    if (session.isHost) {
      this.gameState.hostTeamId = team.id;
    }
    this.gameState.hostMessage = `${player.name} joined ${team.name}!`;
    ws.serializeAttachment(session);
    this.sendTo(ws, { type: "joined", session });
    await this.saveState();
    await this.broadcastState();
  }

  private async handleRejoin(ws: WebSocket, playerId: string): Promise<void> {
    const player = this.findPlayerById(playerId);
    if (!player) {
      this.sendTo(ws, { type: "error", message: "Could not restore that session. Please join the room again." });
      return;
    }

    const session: SessionAttachment = {
      playerId: player.player.id,
      playerName: player.player.name,
      teamId: player.team.id,
      teamName: player.team.name,
      isHost: this.gameState.hostTeamId === player.team.id,
    };

    ws.serializeAttachment(session);
    this.sendTo(ws, { type: "joined", session });
    this.sendTo(ws, { type: "state_update", state: this.gameState });
  }

  private async handleStartGame(ws: WebSocket, session: SessionAttachment | null): Promise<void> {
    if (!session) {
      this.sendTo(ws, { type: "error", message: "Join a team before starting the game." });
      return;
    }
    if (!session.isHost) {
      this.sendTo(ws, { type: "error", message: "Only the host team can start the game." });
      return;
    }
    if (this.gameState.teams.length < 1) return;
    this.gameState.phase = "guessing";
    this.gameState.activeTeamId = this.pickRandomTeamId();
    this.gameState.teams.forEach((team) => (team.strikes = 0));
    const startingTeam = this.activeTeam();
    await this.publishState(
      `The game is starting! Here's the first question: "${this.currentQuestion().prompt}". ${startingTeam?.name ?? "A team"} goes first.`
    );
  }

  private async handleGuess(ws: WebSocket, session: SessionAttachment | null, answer: string): Promise<void> {
    if (!session) {
      this.sendTo(ws, { type: "error", message: "Join a team before guessing." });
      return;
    }
    if (this.gameState.phase !== "guessing") return;
    if (session.teamId !== this.gameState.activeTeamId) {
      this.sendTo(ws, { type: "error", message: "It is not your team's turn to guess." });
      return;
    }
    const question = this.currentQuestion();
    const normalised = answer.toLowerCase().trim();
    const match = question.answers.find(
      (a) => !a.revealed && a.text.toLowerCase().includes(normalised)
    );

    if (match) {
      match.revealed = true;
      const activeTeam = this.activeTeam();
      if (activeTeam) activeTeam.score += match.points;

      const allRevealed = question.answers.every((a) => a.revealed);
      if (allRevealed) {
        this.gameState.phase = "reveal";
        await this.publishState(
          `Amazing! All answers revealed for "${question.prompt}"! The board is cleared!`
        );
      } else {
        this.gameState.phase = "guessing";
        await this.publishState(
          `"${match.text}" is on the board for ${match.points} points! Keep going!`
        );
      }
    } else {
      const activeTeam = this.activeTeam();
      if (activeTeam) {
        activeTeam.strikes += 1;
        if (activeTeam.strikes >= 3) {
          // Team got 3 strikes - pass control to other team
          this.switchActiveTeam();
          const newActiveTeam = this.activeTeam();
          if (newActiveTeam) {
            // Reset the new team's strikes to 0 for their attempt
            newActiveTeam.strikes = 0;
          }
          this.gameState.phase = "guessing";
          await this.publishState(
            `Three strikes! "${answer}" was not on the board. Control passes to ${newActiveTeam?.name || "the other team"}!`
          );
        } else {
          await this.publishState(
            `"${answer}" is not on the board! That's strike ${activeTeam.strikes}!`
          );
        }
      }
    }
  }

  private async handlePass(ws: WebSocket, session: SessionAttachment | null): Promise<void> {
    if (!session) {
      this.sendTo(ws, { type: "error", message: "Join a team before passing." });
      return;
    }
    if (this.gameState.phase !== "guessing") return;
    if (session.teamId !== this.gameState.activeTeamId) {
      this.sendTo(ws, { type: "error", message: "Only the active team can pass." });
      return;
    }
    this.switchActiveTeam();
    const newActiveTeam = this.activeTeam();
    if (newActiveTeam) {
      // Reset the new team's strikes to 0 for their attempt
      newActiveTeam.strikes = 0;
    }
    this.gameState.phase = "guessing";
    await this.publishState(
      `The team passed! ${newActiveTeam?.name || "The other team"}, can you answer: "${this.currentQuestion().prompt}"?`
    );
  }

  private async handleNextQuestion(ws: WebSocket, session: SessionAttachment | null): Promise<void> {
    if (!session) {
      this.sendTo(ws, { type: "error", message: "Join a team before advancing the game." });
      return;
    }
    if (!session.isHost) {
      this.sendTo(ws, { type: "error", message: "Only the host team can advance to the next question." });
      return;
    }
    if (this.gameState.currentQuestionIndex + 1 >= this.gameState.questions.length) {
      this.gameState.phase = "gameover";
      const winner = [...this.gameState.teams].sort((a, b) => b.score - a.score)[0];
      await this.publishState(
        `That's game! ${winner ? `${winner.name} wins with ${winner.score} points!` : "It's a tie!"} Thanks for playing Survey Says!`
      );
    } else {
      this.gameState.currentQuestionIndex += 1;
      this.gameState.phase = "guessing";
      this.gameState.activeTeamId = this.pickRandomTeamId();
      // Reset strikes for new question
      this.gameState.teams.forEach((t) => (t.strikes = 0));
      const startingTeam = this.activeTeam();
      await this.publishState(
        `Next question: "${this.currentQuestion().prompt}". ${startingTeam?.name ?? "A team"} starts this round.`
      );
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private currentQuestion(): Question {
    return this.gameState.questions[this.gameState.currentQuestionIndex];
  }

  private activeTeam(): Team | undefined {
    return this.gameState.teams.find((t) => t.id === this.gameState.activeTeamId);
  }

  private switchActiveTeam(): void {
    const teams = this.gameState.teams;
    if (teams.length < 2) return;
    const currentIdx = teams.findIndex((t) => t.id === this.gameState.activeTeamId);
    this.gameState.activeTeamId = teams[(currentIdx + 1) % teams.length].id;
  }

  private pickRandomTeamId(): string | null {
    if (this.gameState.teams.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * this.gameState.teams.length);
    return this.gameState.teams[randomIndex]?.id ?? null;
  }

  private findTeamByName(teamName: string): Team | undefined {
    return this.gameState.teams.find((team) => team.name.toLowerCase() === teamName.toLowerCase());
  }

  private findPlayerById(playerId: string): { team: Team; player: Player } | null {
    for (const team of this.gameState.teams) {
      const player = team.players.find((candidate) => candidate.id === playerId);
      if (player) {
        return { team, player };
      }
    }

    return null;
  }

  private async getAIHostMessage(context: string): Promise<string> {
    const startedAt = performance.now();
    const contextPreview = context.length > 500 ? `${context.slice(0, 500)}…` : context;
    try {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "You are the enthusiastic, witty host of a Family Feud-style game show called 'Survey Says'. " +
              "Keep responses SHORT (1-2 sentences), energetic, and fun. Stay in character at all times.",
          },
          { role: "user", content: context },
        ],
        temperature: 0.3,
        max_tokens: 100,
      });
      const result = response as { response?: string };
      this.logTiming("ai.run.success", this.requestSequence, startedAt);
      console.log(`[GameRoom ${this.gameState.roomCode || "unknown"}] ai.context ${contextPreview}, response ${result.response ?? "no response"}`);
      return result.response ?? context;
    } catch {
      // Fall back to plain context if AI is unavailable
      this.logTiming("ai.run.fallback", this.requestSequence, startedAt);
      return context;
    }
  }

  private async publishState(hostMessageContext?: string): Promise<void> {
    const startedAt = performance.now();
    if (hostMessageContext !== undefined) {
      this.gameState.hostMessage = hostMessageContext;
    }

    await this.saveState();
    await this.broadcastState();
    this.logTiming("state.publish", this.requestSequence, startedAt, `phase=${this.gameState.phase} sockets=${this.state.getWebSockets().length}`);

    if (hostMessageContext !== undefined) {
      const generation = ++this.hostMessageGeneration;
      this.state.waitUntil(this.refreshHostMessageFromAI(hostMessageContext, generation));
    }
  }

  private async refreshHostMessageFromAI(context: string, generation: number): Promise<void> {
    const startedAt = performance.now();
    const aiMessage = await this.getAIHostMessage(context);

    // Ignore stale AI responses that finished after a newer game event.
    if (generation !== this.hostMessageGeneration) {
      this.logTiming("ai.refresh.stale", this.requestSequence, startedAt, `generation=${generation}`);
      return;
    }
    if (aiMessage === this.gameState.hostMessage) {
      this.logTiming("ai.refresh.noop", this.requestSequence, startedAt, `generation=${generation}`);
      return;
    }

    this.gameState.hostMessage = aiMessage;
    await this.saveState();
    await this.broadcastState();
    this.logTiming("ai.refresh.applied", this.requestSequence, startedAt, `generation=${generation}`);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed
    }
  }

  private async broadcastState(): Promise<void> {
    const msg: ServerMessage = { type: "state_update", state: this.gameState };
    const payload = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Skip closed sockets
      }
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put("gameState", this.gameState);
  }

  private getSession(ws: WebSocket): SessionAttachment | null {
    const session = ws.deserializeAttachment();
    return session ? (session as SessionAttachment) : null;
  }

  private async timeAction(label: string, requestId: number, action: () => Promise<void>): Promise<void> {
    const startedAt = performance.now();
    try {
      await action();
    } finally {
      this.logTiming(label, requestId, startedAt);
    }
  }

  private logTiming(label: string, requestId: number, startedAt: number, meta?: string): void {
    const elapsedMs = performance.now() - startedAt;
    const roomCode = this.gameState.roomCode || "unknown";
    const suffix = meta ? ` ${meta}` : "";
    console.log(`[GameRoom ${roomCode}] #${requestId} ${label} ${elapsedMs.toFixed(1)}ms${suffix}`);
  }
}
