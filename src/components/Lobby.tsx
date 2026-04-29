import { useState } from "react";

interface Props {
  onCreate: (teamName: string, playerName: string) => Promise<void>;
  onJoin: (roomCode: string, teamName: string, playerName: string) => void;
  error?: string | null;
}

export function Lobby({ onCreate, onJoin, error }: Props) {
  const [playerName, setPlayerName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [view, setView] = useState<"home" | "create" | "join">("home");
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!teamName.trim() || !playerName.trim()) return;
    setLoading(true);
    await onCreate(teamName.trim(), playerName.trim());
    setLoading(false);
  }

  function handleJoin() {
    if (!teamName.trim() || !joinCode.trim() || !playerName.trim()) return;
    onJoin(joinCode.trim().toUpperCase(), teamName.trim(), playerName.trim());
  }

  if (view === "create") {
    return (
      <div className="lobby">
        <h1>Survey Says! 🎉</h1>
        <h2>Create a Room</h2>
        {error && <p className="error-banner">{error}</p>}
        <input
          placeholder="Your player name"
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
        />
        <input
          placeholder="Your team name"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <button disabled={loading || !teamName.trim() || !playerName.trim()} onClick={handleCreate}>
          {loading ? "Creating…" : "Create Room"}
        </button>
        <button className="secondary" onClick={() => setView("home")}>Back</button>
      </div>
    );
  }

  if (view === "join") {
    return (
      <div className="lobby">
        <h1>Survey Says! 🎉</h1>
        <h2>Join a Room</h2>
        {error && <p className="error-banner">{error}</p>}
        <input
          placeholder="Your player name"
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
        />
        <input
          placeholder="Team name to join"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
        />
        <input
          placeholder="Room code (e.g. ABC123)"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          maxLength={6}
        />
        <button disabled={!teamName.trim() || !joinCode.trim() || !playerName.trim()} onClick={handleJoin}>
          Join Room
        </button>
        <button className="secondary" onClick={() => setView("home")}>Back</button>
      </div>
    );
  }

  return (
    <div className="lobby">
      <h1>Survey Says! 🎉</h1>
      <p className="subtitle">Guess what the crowd said</p>
      {error && <p className="error-banner">{error}</p>}
      <button onClick={() => setView("create")}>Create Room</button>
      <button className="secondary" onClick={() => setView("join")}>Join Room</button>
    </div>
  );
}
