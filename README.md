# minimi-agent

A chat agent with one tool, web search. It remembers dated conversations and can re-check its old answers against the live web.

Status: sessions 1 and 2 of 6 are built. It is a streaming chat with Gemini that keeps each person's chats in SQLite under their name and remembers the last turns of a chat. Web search and recall by date are not built yet.

- Plan, design principles and per-session test sets: [docs/PLAN.md](docs/PLAN.md)
- Evaluation questions: [evals/questions.md](evals/questions.md)
- Keys and settings: [.env.example](.env.example)

## Run

Needs Node 22.13 or newer. Copy `.env.example` to `.env` and set `GOOGLE_GENERATIVE_AI_API_KEY`.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:3000.

## Test

Tests use a mock model, so they need no key and no network.

```bash
npm test
```
