# minimi-agent

A chat agent with one tool, web search. It remembers dated conversations and can re-check its old answers against the live web.

Status: sessions 1 to 3 of 6 are built. It is a streaming chat with Gemini that searches the web (Tavily) when a question needs fresh facts, cites its sources by number, keeps each person's chats in SQLite under their name and remembers the last turns of a chat. Recall by date and re-checking old answers are not built yet.

- Plan, design principles and per-session test sets: [docs/PLAN.md](docs/PLAN.md)
- Evaluation questions: [evals/questions.md](evals/questions.md)
- Keys and settings: [.env.example](.env.example)

## Run

Needs Node 22.13 or newer. Copy `.env.example` to `.env` and set `GOOGLE_GENERATIVE_AI_API_KEY` and `TAVILY_API_KEY`.

A free-tier Gemini key allows only 20 requests a day on the default main model, and a question with a web search uses 2 to 4 of them. See the note in `.env.example`.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:3000.

## Test

Tests use a mock model and a mock search, so they need no key and no network.

```bash
npm test
```
