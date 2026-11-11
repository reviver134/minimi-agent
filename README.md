# minimi-agent

A chat agent with one tool, web search. It remembers dated conversations and can re-check its old answers against the live web.

Status: session 1 of 6 is built (streaming chat with Gemini, no search or memory yet).

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
