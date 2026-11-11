# minimi-agent

A chat agent with one tool, web search. It remembers dated conversations and can re-check its old answers against the live web.

- **Ask anything current** and it searches, answers and cites its sources by number.
- **Ask about the past**: "What did I ask you last Tuesday about Postgres?" It looks up your earlier chats by date and topic, and says so plainly when it has no record.
- **Ask whether an old answer still holds**: "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?" It searches once per item it named then and answers with the value then and the value now.
- **Tell it how you like answers** ("keep answers short", "my name is Asha") and it remembers across chats.

How it works and why: [DESIGN.md](DESIGN.md). The build plan with every test: [docs/PLAN.md](docs/PLAN.md).

## Run

Needs Node 22.13 or newer.

1. Copy `.env.example` to `.env`.
2. Set `GOOGLE_GENERATIVE_AI_API_KEY` (from https://aistudio.google.com/apikey) and `TAVILY_API_KEY` (from https://app.tavily.com). Both have free tiers.
3. Install and start:

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000 and enter any name. Your chats are kept under that name in a local SQLite file (`data/minimi.db`); entering the same name later brings them back. There is no login: the server listens on this machine only.

### About the models

The default main model is `gemini-3.5-flash-lite`, because it works on a free-tier Gemini key. `gemini-3.6-flash` gives better answers, but a free key allows only 20 requests a day on it and one question with a web search uses 2 to 4. If your key has billing, set `MODEL_MAIN=gemini-3.6-flash` in `.env`.

## Try the questions it was built for

The eval questions in [evals/questions.md](evals/questions.md) assume a small history for a user called `demo` and a fixed date.

1. Load the history:

```bash
npm run seed
```

2. Set `CLOCK_OVERRIDE=2026-11-11T10:00:00+05:30` in `.env` and restart.
3. Sign in as `demo` and ask, for example:
   - What did I ask you on 3 November?
   - What did I ask you on 6 November? (there is no record; it offers the nearest days)
   - Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?
   - Which of the CRMs you shortlisted is cheapest for 20 seats today?

Remove `CLOCK_OVERRIDE` afterwards to use the real date.

## Tests and evals

The tests use a mock model and a mock search, so they need no key and no network:

```bash
npm test
```

The evals ask every question in `evals/questions.md` through the real model and search, each on a freshly seeded database with the clock fixed, and print pass or fail and latency. They use your API keys (about 80 model requests and 60 searches):

```bash
npm run evals
```

The last run is in [evals/results/latest.md](evals/results/latest.md), with every answer.

## Layout

```
prompts/           the system prompt and the two helper-call prompts
src/server/        HTTP routes, the streaming chat endpoint, static page
src/agent/         agent loop, web_search tool, re-check, prompt and context builders
src/memory/        SQLite store, recall, answer records, write-back
src/temporal/      clock, date phrases, timezone day boundaries
src/search/        search interface, Tavily, mock
src/llm/           model interface, Gemini, mock
src/telemetry/     step timing, logging with key redaction
web/               the chat page (no build step)
evals/             questions, seed history, runner, last results
tests/             unit and integration tests
```

## Settings

Everything is in [.env.example](.env.example): the two keys, the model ids, `THINKING_LEVEL`, `PORT`, `DB_PATH` and `CLOCK_OVERRIDE`. The server checks them at startup and names anything that is missing.
