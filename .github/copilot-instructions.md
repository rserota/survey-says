# Survey Says - Copilot Instructions

## Project Overview
A multiplayer Family Feud-style game ("Survey Says") built on Cloudflare Workers.
- **Runtime**: Cloudflare Workers (TypeScript)
- **State**: Durable Objects — one instance per game room
- **Real-time**: WebSockets via Durable Objects Hibernation API
- **AI Host**: Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct` or similar) for dynamic host responses
- **Frontend**: Served from the Worker itself (HTML/CSS/JS, no separate framework)

## Architecture
- `src/index.ts` — Worker entry point, routes HTTP + WebSocket upgrades
- `src/GameRoom.ts` — Durable Object class managing game state, WebSocket connections, and AI calls
- `src/types.ts` — Shared TypeScript types for messages and game state
- `public/` — Static frontend assets served by the Worker

## Key Conventions
- All game state lives inside the `GameRoom` Durable Object
- WebSocket messages are JSON with a `type` discriminator field
- Use the Durable Objects Hibernation API (`acceptWebSocket`) for scalable connections
- Cloudflare AI binding is named `AI` in `wrangler.toml`
- Durable Object binding is named `GAME_ROOM` in `wrangler.toml`
- Game rooms are identified by a short alphanumeric code (e.g. `ABC123`)
