import type { GameState, Question, Team, ClientMessage, ServerMessage, PlayerSession, Player } from "../src/types";

// ── Fallback questions (used only if AI generation fails) ───────────────────
const FALLBACK_QUESTIONS: Question[] = [
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
  {
    prompt: "Name something people bring to a picnic.",
    answers: [
      { text: "Food", points: 48, revealed: false },
      { text: "Blanket", points: 35, revealed: false },
      { text: "Drinks", points: 30, revealed: false },
      { text: "Utensils", points: 20, revealed: false },
      { text: "Sunscreen", points: 15, revealed: false },
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
      roundsToPlay: 2,
      questionTheme: null,
      currentQuestionIndex: 0,
      questions: [],
      activeTeamId: null,
      lastRoundStarterTeamId: null,
      roundControlPassed: false,
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
          roundsToPlay: savedState.roundsToPlay ?? 2,
          questionTheme: savedState.questionTheme ?? null,
          lastRoundStarterTeamId: savedState.lastRoundStarterTeamId ?? null,
          roundControlPassed: savedState.roundControlPassed ?? false,
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
        await this.timeAction("ws.start_game", requestId, () =>
          this.handleStartGame(ws, session, msg.roundsToPlay, msg.questionTheme)
        );
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

  private async handleStartGame(
    ws: WebSocket,
    session: SessionAttachment | null,
    requestedRoundsToPlay?: number,
    requestedQuestionTheme?: string,
  ): Promise<void> {
    if (!session) {
      this.sendTo(ws, { type: "error", message: "Join a team before starting the game." });
      return;
    }
    if (!session.isHost) {
      this.sendTo(ws, { type: "error", message: "Only the host team can start the game." });
      return;
    }

    const roundsToPlay = Math.min(4, Math.max(1, Math.round(requestedRoundsToPlay ?? 2)));
    const questionTheme = requestedQuestionTheme?.trim() ? requestedQuestionTheme.trim() : null;

    this.gameState.roundsToPlay = roundsToPlay;
    this.gameState.questionTheme = questionTheme;

    await this.ensureQuestionsInitialized(roundsToPlay, questionTheme);
    if (this.gameState.questions.length < 1) {
      this.sendTo(ws, { type: "error", message: "Could not prepare questions. Try again." });
      return;
    }
    if (this.gameState.teams.length < 1) return;
    this.gameState.phase = "guessing";
    const firstRoundStarter = this.pickRandomTeamId();
    this.gameState.activeTeamId = firstRoundStarter;
    this.gameState.lastRoundStarterTeamId = firstRoundStarter;
    this.gameState.teams.forEach((team) => (team.strikes = 0));
    this.gameState.roundControlPassed = false;
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
    const matchIndex = await this.findMatchingAnswerIndex(question, answer);
    const match = matchIndex !== null ? question.answers[matchIndex] : undefined;

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
          if (this.gameState.roundControlPassed) {
            // Both teams struck out — reveal remaining answers and end the round
            const remainingAnswers = question.answers
              .filter((a) => !a.revealed)
              .map((a) => a.text);
            question.answers.forEach((a) => (a.revealed = true));
            this.gameState.phase = "reveal";
            await this.publishState(
              `Three strikes from ${activeTeam.name} too! No one got it — let's reveal the remaining answers! ` +
              `Official revealed answers: ${remainingAnswers.join(", ")}.`
            );
          } else {
            // First strike-out — pass control to other team
            const previousActiveTeamName = activeTeam.name;
            this.switchActiveTeam();
            const newActiveTeam = this.activeTeam();
            const newActiveTeamName = newActiveTeam?.name || "the other team";
            if (newActiveTeam) {
              newActiveTeam.strikes = 0;
            }
            this.gameState.roundControlPassed = true;
            this.gameState.phase = "guessing";
            await this.publishState(
              `Three strikes! "${answer}" was not on the board. Control switches from ${previousActiveTeamName} to ${newActiveTeamName}. ` +
              `Host note: this handoff is FROM "${previousActiveTeamName}" TO "${newActiveTeamName}". ` +
              `Attempt to make a quick joke or pun about the new team name "${newActiveTeamName}" before handing over control.`
            );
          }
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
    const previousActiveTeam = this.activeTeam();
    const previousActiveTeamName = previousActiveTeam?.name || "The current team";
    this.switchActiveTeam();
    const newActiveTeam = this.activeTeam();
    const newActiveTeamName = newActiveTeam?.name || "The other team";
    if (newActiveTeam) {
      // Reset the new team's strikes to 0 for their attempt
      newActiveTeam.strikes = 0;
    }
    this.gameState.phase = "guessing";
    await this.publishState(
      `${previousActiveTeamName} passed. Control switches to ${newActiveTeamName}. ` +
      `${newActiveTeamName}, can you answer: "${this.currentQuestion().prompt}"?`
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
        winner
          ? `That's game! ${winner.name} wins with ${winner.score} points! Thanks for playing Survey Says! ` +
            `Host note: include one quick, clean joke or pun about the winning team name "${winner.name}" during the winner announcement.`
          : "That's game! It's a tie! Thanks for playing Survey Says!"
      );
    } else {
      this.gameState.currentQuestionIndex += 1;
      this.gameState.phase = "guessing";
      const nextStarter = this.pickAlternatingTeamId(this.gameState.lastRoundStarterTeamId ?? null);
      this.gameState.activeTeamId = nextStarter;
      this.gameState.lastRoundStarterTeamId = nextStarter;
      // Reset strikes and control-pass flag for new question
      this.gameState.teams.forEach((t) => (t.strikes = 0));
      this.gameState.roundControlPassed = false;
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

  private pickAlternatingTeamId(previousStarterId: string | null): string | null {
    const teams = this.gameState.teams;
    if (teams.length === 0) return null;
    if (teams.length === 1) return teams[0]?.id ?? null;
    if (!previousStarterId) return teams[0]?.id ?? null;

    const previousIndex = teams.findIndex((team) => team.id === previousStarterId);
    if (previousIndex === -1) return teams[0]?.id ?? null;

    return teams[(previousIndex + 1) % teams.length]?.id ?? null;
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

  private normaliseQuestionText(value: string): string {
    return value.trim().replace(/\s+/g, " ");
  }

  private toValidatedQuestions(rawQuestions: unknown, expectedCount: number): Question[] | null {
    if (!Array.isArray(rawQuestions) || rawQuestions.length !== expectedCount) return null;

    const seenPrompts = new Set<string>();
    const parsed: Question[] = [];

    for (const rawQuestion of rawQuestions) {
      if (!rawQuestion || typeof rawQuestion !== "object") return null;
      const prompt = this.normaliseQuestionText(String((rawQuestion as { prompt?: unknown }).prompt ?? ""));
      const rawAnswers = (rawQuestion as { answers?: unknown }).answers;
      if (!prompt || !Array.isArray(rawAnswers) || rawAnswers.length < 4) return null;

      const promptKey = prompt.toLowerCase();
      if (seenPrompts.has(promptKey)) return null;
      seenPrompts.add(promptKey);

      const answers = rawAnswers
        .map((rawAnswer) => {
          if (!rawAnswer || typeof rawAnswer !== "object") return null;
          const text = this.normaliseQuestionText(String((rawAnswer as { text?: unknown }).text ?? ""));
          const pointsValue = (rawAnswer as { points?: unknown }).points;
          const points = typeof pointsValue === "number" ? Math.round(pointsValue) : Number(pointsValue);
          if (!text || !Number.isFinite(points) || points <= 0) return null;
          return { text, points, revealed: false };
        })
        .filter((answer): answer is { text: string; points: number; revealed: false } => answer !== null)
        .sort((a, b) => b.points - a.points)
        .slice(0, 8);

      if (answers.length < 4) return null;
      parsed.push({ prompt, answers });
    }

    return parsed;
  }

  private hasOverusedPromptPatterns(questions: Question[]): boolean {
    const overusedPatterns = [
      /woman'?s\s+(purse|bag|handbag)/i,
      /find\s+in\s+a\s+woman'?s\s+(purse|bag|handbag)/i,
      /\b(purse|handbag)\b/i,
      /\b(pet|pets|dog|dogs|cat|cats)\b/i,
    ];

    return questions.some((question) =>
      overusedPatterns.some((pattern) => pattern.test(question.prompt))
    );
  }

  private async generateQuestionsFromAI(count: number, theme: string | null): Promise<Question[] | null> {
    const startedAt = performance.now();
    const themePool = [
      "workplace",
      "school",
      "travel",
      "holidays",
      "weather",
      "sports",
      "music",
      "technology",
      "food",
      "shopping",
      "family",
      "home chores",
      "transportation",
      "health",
      "weekends",
      "movies",
      "social media",
      "parties",
      "cooking",
      "exercise",
    ];
    const shuffledThemes = [...themePool].sort(() => Math.random() - 0.5);
    const selectedThemes = theme ? [theme] : shuffledThemes.slice(0, 6);
    const variationSeed = crypto.randomUUID().slice(0, 8);

    try {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "Generate Family Feud style game content as strict JSON only. " +
              "Output exactly one JSON object with shape {\"questions\":[...]}. " +
              "Each question must have: prompt (string), answers (array of 4-6 items). " +
              "Each answer must have: text (string), points (integer). " +
              "Keep prompts clean and family-friendly. Do not include markdown or extra commentary. " +
              "Avoid overused prompts about women's purses/handbags and pets/dogs/cats.",
          },
          {
            role: "user",
            content:
              `Create exactly ${count} unique questions for one game round set. ` +
              "Points should be plausible survey-style values in descending popularity range. " +
              `Use this variation seed: ${variationSeed}. ` +
              (theme
                ? `Use this single theme for ALL questions: ${theme}. Every question and answer set must stay within this theme while still being distinct from each other. `
                : `Use these themes for variety: ${selectedThemes.join(", ")}. `) +
              "Do not repeat common trope prompts. Make each question about a clearly different situation.",
          },
        ],
        temperature: 0.85,
        max_tokens: 900,
      });

      const raw = (response as { response?: string }).response ?? "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        this.logTiming("ai.questions.unparseable", this.requestSequence, startedAt);
        return null;
      }

      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { questions?: unknown };
      const validatedQuestions = this.toValidatedQuestions(parsed.questions, count);
      if (!validatedQuestions) {
        this.logTiming("ai.questions.invalid", this.requestSequence, startedAt);
        return null;
      }

      if (this.hasOverusedPromptPatterns(validatedQuestions)) {
        this.logTiming("ai.questions.overused", this.requestSequence, startedAt);
        return null;
      }

      this.logTiming("ai.questions.generated", this.requestSequence, startedAt, `count=${validatedQuestions.length}`);
      return validatedQuestions;
    } catch {
      this.logTiming("ai.questions.error", this.requestSequence, startedAt);
      return null;
    }
  }

  private async ensureQuestionsInitialized(roundsToPlay: number, theme: string | null): Promise<void> {
    if (this.gameState.questions.length === roundsToPlay) return;

    const generated = await this.generateQuestionsFromAI(roundsToPlay, theme);
    if (generated) {
      this.gameState.questions = generated;
      this.gameState.currentQuestionIndex = 0;
      await this.saveState();
      return;
    }

    // Fallback so the game can still start if generation fails.
    this.gameState.questions = FALLBACK_QUESTIONS
      .slice(0, roundsToPlay)
      .map((question) => ({
        prompt: question.prompt,
        answers: question.answers.map((answer) => ({ ...answer, revealed: false })),
      }));
    this.gameState.currentQuestionIndex = 0;
    await this.saveState();
  }

  private normaliseForMatching(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private tokenizeForMatching(value: string): string[] {
    return this.normaliseForMatching(value)
      .split(" ")
      .filter(Boolean);
  }

  private async findMatchingAnswerIndex(question: Question, guess: string): Promise<number | null> {
    const normalisedGuess = this.normaliseForMatching(guess);
    if (!normalisedGuess) return null;

    // Fast exact-text path for obvious matches.
    for (let i = 0; i < question.answers.length; i++) {
      const candidate = question.answers[i];
      if (!candidate || candidate.revealed) continue;
      if (this.normaliseForMatching(candidate.text) === normalisedGuess) {
        return i;
      }
    }

    const startedAt = performance.now();
    const unrevealedCandidates = question.answers
      .map((candidate, index) => ({ index, text: candidate.text, revealed: candidate.revealed }))
      .filter((candidate) => !candidate.revealed);

    if (unrevealedCandidates.length === 0) return null;

    try {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "You decide if a Family Feud player guess semantically matches ONE unrevealed board answer. " +
              "Be VERY strict to avoid false positives. Match synonyms/paraphrases (e.g. 'bathe' == 'shower') only when clearly equivalent in this question context. " +
              "Do NOT match items that are merely in the same category (example: fish != lizard, dog != cat, apple != orange). " +
              "For single-word guess vs single-word answer, only match if they are near-synonyms or lexical variants of the same concept. " +
                            "Be EXTREMELY strict. Only match if the guess is a direct synonym or clear paraphrase of the answer. " +
                            "REJECT if they are merely related or in the same category (example: meat != cheese, fish != lizard, dog != cat). " +
                            "REJECT if uncertain. For any doubt, return null. " +
              "If uncertain or multiple choices are plausible, return no match. " +
              "Respond with ONLY valid JSON: {\"matchIndex\": number|null, \"confidence\": number, \"equivalent\": boolean, \"isCategoryOnly\": boolean, \"reason\": string}.",
          },
          {
            role: "user",
            content:
              `Question: ${question.prompt}\n` +
              `Guess: ${guess.trim()}\n` +
              `Unrevealed answers: ${JSON.stringify(unrevealedCandidates)}\n` +
              "Pick exactly one index from the unrevealed list or null. Set equivalent=true only when the guess and chosen answer are truly equivalent in meaning for this question. Set isCategoryOnly=true when they are related but not equivalent.",
          },
        ],
        temperature: 0.1,
        max_tokens: 120,
      });

      const raw = (response as { response?: string }).response ?? "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        this.logTiming("ai.match.unparseable", this.requestSequence, startedAt);
        return null;
      }

      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
        matchIndex?: number | null;
        confidence?: number;
        equivalent?: boolean;
        isCategoryOnly?: boolean;
        reason?: string;
      };

      if (parsed.matchIndex === null || parsed.matchIndex === undefined) {
        this.logTiming("ai.match.none", this.requestSequence, startedAt, `confidence=${(parsed.confidence ?? 0).toFixed(2)}`);
        return null;
      }

      const matchedCandidate = unrevealedCandidates.find((candidate) => candidate.index === parsed.matchIndex);
      if (!matchedCandidate) {
        this.logTiming("ai.match.invalid_index", this.requestSequence, startedAt);
        return null;
      }

      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      if (confidence < 0.85) {
        this.logTiming("ai.match.low_confidence", this.requestSequence, startedAt, `confidence=${confidence.toFixed(2)}`);
        return null;
      }

      // Guardrail for single-word matches: require explicit equivalence decision from AI.
      const guessTokens = this.tokenizeForMatching(guess);
      const answerTokens = this.tokenizeForMatching(matchedCandidate.text);
      const guessNorm = guessTokens.join(" ");
      const answerNorm = answerTokens.join(" ");

      const guessIsSingle = guessTokens.length === 1;
      const answerIsSingle = answerTokens.length === 1;

      if (
        guessIsSingle &&
        answerIsSingle &&
        guessNorm !== answerNorm
      ) {
        const equivalent = parsed.equivalent === true;
        const categoryOnly = parsed.isCategoryOnly === true;
        if (!equivalent || categoryOnly || confidence < 0.9) {
          this.logTiming(
            "ai.match.rejected.single_word_mismatch",
            this.requestSequence,
            startedAt,
            `guess=${guessNorm} answer=${answerNorm} equivalent=${equivalent} categoryOnly=${categoryOnly} confidence=${confidence.toFixed(2)}`
          );
          return null;
        }
      }

      const reason = (parsed.reason ?? "").slice(0, 80);
      this.logTiming("ai.match.accepted", this.requestSequence, startedAt, `index=${matchedCandidate.index} confidence=${confidence.toFixed(2)} reason=${reason}`);
      return matchedCandidate.index;
    } catch {
      this.logTiming("ai.match.error", this.requestSequence, startedAt);
      return null;
    }
  }

  private extractQuestionFromContext(context: string): string | null {
    const match = context.match(/(?:first question|Next question|can you answer):\s*"([^"]+)"/i);
    return match?.[1]?.trim() || null;
  }

  private buildQuestionSafeFallback(context: string, question: string): string {
    const starter = context.match(/\.\s*([^.!?]+?)\s+(?:goes first|starts this round)\.?$/i)?.[1]?.trim();
    if (starter) {
      return `Next up: "${question}" ${starter} starts.`;
    }
    return `Next up: "${question}"`;
  }

  private extractOfficialAnswersFromContext(context: string): string[] {
    const match = context.match(/Official revealed answers:\s*([^]+?)\.?\s*(?:Host note:|$)/i);
    if (!match?.[1]) return [];
    return match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private buildRevealAnswersFallback(answers: string[]): string {
    if (answers.length === 0) {
      return "No one got it — here's what was left on the board!";
    }
    return `No one got it — the remaining answers were: ${answers.join(", ")}.`;
  }

  private async getAIHostMessage(context: string): Promise<string> {
    const startedAt = performance.now();
    const contextPreview = context.length > 500 ? `${context.slice(0, 500)}…` : context;
    const expectedQuestion = this.extractQuestionFromContext(context);
    const officialAnswers = this.extractOfficialAnswersFromContext(context);
    if (officialAnswers.length > 0) {
      this.logTiming("ai.run.reveal_fallback", this.requestSequence, startedAt, `answers=${officialAnswers.length}`);
      return this.buildRevealAnswersFallback(officialAnswers);
    }
    try {
      const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "You are the enthusiastic, witty host of a Family Feud-style game show called 'Survey Says'. " +
              "Keep responses SHORT (1-2 sentences), energetic, and fun. Stay in character at all times. " +
              "Never invent or alter facts, answers, or questions. If a question appears in context, use that exact question text. " +
              "Never mention a next question unless the context explicitly says 'Next question'. " +
              "If context includes a host note asking for a pun/joke about a team name, include one quick, clean joke as instructed (handoff or winner announcement).",
          },
          { role: "user", content: context },
        ],
        temperature: 0.2,
        max_tokens: 100,
      });
      const result = response as { response?: string };
      const aiText = result.response ?? context;
      if (expectedQuestion && !aiText.includes(`"${expectedQuestion}"`) && !aiText.includes(expectedQuestion)) {
        this.logTiming("ai.run.offtopic_question", this.requestSequence, startedAt);
        console.log(`[GameRoom ${this.gameState.roomCode || "unknown"}] ai.offtopic expectedQuestion="${expectedQuestion}" response=${aiText}`);
        return this.buildQuestionSafeFallback(context, expectedQuestion);
      }
      this.logTiming("ai.run.success", this.requestSequence, startedAt);
      console.log(`[GameRoom ${this.gameState.roomCode || "unknown"}] ai.context ${contextPreview}, response ${result.response ?? "no response"}`);
      return aiText;
    } catch {
      // Fall back to plain context if AI is unavailable
      this.logTiming("ai.run.fallback", this.requestSequence, startedAt);
      if (expectedQuestion) {
        return this.buildQuestionSafeFallback(context, expectedQuestion);
      }
      return context;
    }
  }

  private async publishState(hostMessageContext?: string): Promise<void> {
    const startedAt = performance.now();
    
    // If generating new host message, show loading state immediately
    if (hostMessageContext !== undefined) {
      this.gameState.hostMessage = "Loading host message...";
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
