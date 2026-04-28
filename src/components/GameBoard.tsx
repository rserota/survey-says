import { useState, useEffect } from "react";
import type { GameState, PlayerSession } from "../types";

interface Props {
  state: GameState;
  roomCode: string;
  send: (msg: object) => void;
  session: PlayerSession | null;
  error?: string | null;
  onLeave: () => void;
}

export function GameBoard({ state, roomCode, send, session, error, onLeave }: Props) {
  const [guess, setGuess] = useState("");
  const [copied, setCopied] = useState(false);
  const [loadingStart, setLoadingStart] = useState(false);
  const [guessPending, setGuessPending] = useState(false);
  const [waitingForHost, setWaitingForHost] = useState(false);
  const [ellipsisDots, setEllipsisDots] = useState("");
  const question = state.questions[state.currentQuestionIndex];
  const isHost = session?.isHost ?? false;
  const isActiveTeam = !!session && state.activeTeamId === session.teamId;
  const canStart = state.phase === "lobby" && isHost;
  const canGuess = state.phase === "guessing" && isActiveTeam && !guessPending;
  const canPass = canGuess;
  const canAdvance = state.phase === "reveal" && isHost;

  function submitGuess() {
    if (!guess.trim() || !canGuess) return;
    setGuessPending(true);
    send({ type: "guess", answer: guess.trim() });
    setGuess("");
  }

  async function copyRoomCode() {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  function handleStartGame() {
    setLoadingStart(true);
    send({ type: "start_game" });
  }

  // Detect when AI is generating host message
  useEffect(() => {
    const isGenerating = state.phase !== "lobby" && state.hostMessage === "Loading host message...";
    setWaitingForHost(isGenerating);
  }, [state.hostMessage, state.phase]);

  // Animate ellipsis while waiting for host
  useEffect(() => {
    if (!waitingForHost) return;
    const interval = setInterval(() => {
      setEllipsisDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 400);
    return () => clearInterval(interval);
  }, [waitingForHost]);

  // Clear loading state when game starts
  useEffect(() => {
    if (state.phase !== "lobby") {
      setLoadingStart(false);
    }
  }, [state.phase]);

  useEffect(() => {
    setGuessPending(false);
  }, [state]);

  useEffect(() => {
    if (error) {
      setGuessPending(false);
    }
  }, [error]);

  return (
    <div className="game-board">
      {/* Header */}
      <header className="game-header">
        <div className="room-code-group">
          <span className="room-code">Room: {roomCode}</span>
          <button className="copy-btn" onClick={copyRoomCode}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <h1>Survey Says!</h1>
        <div className="header-right">
          <span className="phase-badge">{state.phase}</span>
          <button className="leave-btn" onClick={onLeave}>Leave</button>
        </div>
      </header>

      <div className="player-status">
        <span>
          You are <strong>{session?.playerName ?? "joining..."}</strong>
          {session?.teamName ? <> on <strong>{session.teamName}</strong></> : null}
          {isHost ? " · Host" : ""}
        </span>
        {state.activeTeamId && (
          <span>
            Active team: <strong>{state.teams.find((team) => team.id === state.activeTeamId)?.name ?? "Unknown"}</strong>
          </span>
        )}
      </div>

      {error && <p className="error-banner">{error}</p>}

      {/* Host message */}
      <div className="host-message">
        <span className="host-icon">🎤</span>
        <p className={waitingForHost ? "loading-text" : ""}>
          {waitingForHost ? ellipsisDots || "..." : state.hostMessage}
        </p>
      </div>

      {/* Scoreboard */}
      <div className="scoreboard">
        {state.teams.map((team) => (
          <div
            key={team.id}
            className={`team-card ${state.activeTeamId === team.id ? "active" : ""}`}
          >
            <div className="team-name">{team.name}</div>
            <div className="team-players">
              {team.players.map((player) => player.name).join(" • ")}
            </div>
            <div className="team-score">{team.score}</div>
            {state.activeTeamId === team.id && <div className="strikes">{"❌".repeat(team.strikes)}</div>}
          </div>
        ))}
      </div>

      {/* Question + Answer Board */}
      {state.phase !== "lobby" && state.phase !== "gameover" && (
        <div className="question-section">
          <div className="question-prompt">{question.prompt}</div>
          <div className="answer-grid">
            {question.answers.map((answer, i) => (
              <div key={i} className={`answer-tile ${answer.revealed ? "revealed" : "hidden"}`}>
                <span className="answer-number">{i + 1}</span>
                <span className="answer-text">{answer.revealed ? answer.text : "???"}</span>
                <span className="answer-points">{answer.revealed ? answer.points : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="controls">
        {state.phase === "lobby" && (
          <button disabled={!canStart || loadingStart} onClick={handleStartGame}>
            {loadingStart ? (
              <>
                <span className="spinner"></span> Loading questions...
              </>
            ) : isHost ? (
              "Start Game"
            ) : (
              "Waiting for host to start"
            )}
          </button>
        )}

        {state.phase === "guessing" && (
          <div className="guess-area">
            <input
              placeholder="Your answer…"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitGuess()}
              disabled={!canGuess}
              autoFocus
            />
            <button disabled={!canGuess} onClick={submitGuess}>
              {guessPending ? <span className="spinner"></span> : "Submit"}
            </button>
            <button className="secondary" disabled={!canPass} onClick={() => send({ type: "pass" })}>Pass</button>
          </div>
        )}

        {(state.phase === "reveal") && (
          <button disabled={!canAdvance} onClick={() => send({ type: "next_question" })}>
            {canAdvance ? "Next Question →" : "Waiting for host"}
          </button>
        )}

        {state.phase === "gameover" && (
          <div className="gameover">
            <h2>🏆 Game Over!</h2>
            {[...state.teams]
              .sort((a, b) => b.score - a.score)
              .map((t, i) => (
                <p key={t.id}>
                  {i === 0 ? "🥇" : "🥈"} {t.name}: {t.score} pts
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
