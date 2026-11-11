# minimi-agent

A chat agent with one tool, web search. It remembers dated conversations and can re-check its old answers against the live web.

Status: sessions 1 to 5 of 6 are built. It is a streaming chat with Gemini that searches the web (Tavily) when a question needs fresh facts, cites its sources by number, keeps each person's chats in SQLite under their name, recalls past conversations by date and topic ("what did I ask you last Tuesday about Postgres?"), re-checks an old answer against the web ("has any of that pricing changed?") and remembers what you tell it about yourself across chats. The eval runner, error hardening and `DESIGN.md` are still to come.

- Plan, design principles and per-session test sets: [docs/PLAN.md](docs/PLAN.md)
- Evaluation questions: [evals/questions.md](evals/questions.md)
- Keys and settings: [.env.example](.env.example)

## Run

Needs Node 22.13 or newer. Copy `.env.example` to `.env` and set `GOOGLE_GENERATIVE_AI_API_KEY` and `TAVILY_API_KEY`.

The default main model is `gemini-3.5-flash-lite`, which works on a free-tier Gemini key. `gemini-3.6-flash` answers better but a free key allows only 20 requests a day on it; see the note in `.env.example`.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:3000.

## Try the eval history

The eval questions in [evals/questions.md](evals/questions.md) assume a small history for a user called `demo` and a fixed date. Load the history:

```bash
npm run seed
```

Then set `CLOCK_OVERRIDE=2026-11-11T10:00:00+05:30` in `.env`, restart, and sign in as `demo`.

## Test

Tests use a mock model and a mock search, so they need no key and no network.

```bash
npm test
```
