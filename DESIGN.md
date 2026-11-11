# Design

One Node process (TypeScript, Hono, SQLite, Gemini, Tavily) and a static page: a chat agent with one tool, web search, that remembers dated conversations and re-checks its old answers.

## How a message is handled

1. **Dates.** Code resolves "last Tuesday" or "3 November" against an injectable clock and the user's timezone. The model does no date arithmetic.
2. **Memory or not.** Only a message with a date or a memory phrase ("did I ask", "you shortlisted") is examined further. Code settles most of these; the rest get one small fast-model call returning JSON.
3. **Recall.** Turns are fetched by user, UTC range and topic words. An empty day returns nothing plus the nearest days with records, so the agent says "no record" and offers them.
4. **Re-check.** If the question is also about now, code searches once per item the old answer named, in parallel, before the model is called.
5. **Answer.** One model, one tool, at most 3 search rounds with every query of a round in parallel, streamed with numbered citations.
6. **Write-back.** After the last token, one fast-model call files the turn: title, checkable claims, profile changes, summary. It cannot delay or fail the reply.

## Why

- **Code decides, the model writes.** Dates, recall, caps, timeouts and what to re-check are deterministic and tested offline (91 tests, no keys). That is why "what did I ask on 6 November?" gets "no record", not a plausible invention.
- **Memory is context, not a second tool.** The brief allows one tool, and a tagged section built before the call is faster than a tool round trip.
- **Raw turns are the source of truth.** Claims, profile and summaries are derived. A claim is stored only if its value appears in the answer character for character.
- **Hot path and background are separate,** and every step is timed per turn.
- **Web text is data.** Results and records sit in tags that page text cannot close.
- **The prompt is ordered for caching:** fixed text, profile, date, then what was looked up.

## Rejected

- **Memory as a tool, or a second agent building context:** an extra model round trip for work code does faster and testably.
- **A vector database:** date range plus keywords covers the questions.
- **Gemini's built-in search grounding:** no control over parallelism, timing or stored sources.
- **LangChain, and the SDK's own tool loop:** ours is 100 lines and gives the round cap, step timing and a search-down rule.
- **`chrono-node`:** recall needs "most recent past" and two candidates for "last Tuesday".
- **Login, Docker, a shared knowledge base:** not asked for.

## Known limits

Measured on 11 November 2026 with `gemini-3.5-flash-lite`, the default because it runs on a free key. Answers: [evals/results/latest.md](evals/results/latest.md).

- **Evals: 28 and 27 of 31 in two full runs, with different misses each time:** a missing as-of date (B1, B5), searching before asking what "it" is (G4), no official page cited (B3), a skipped second question (D2), a medium answer for "long detailed" (F3). One miss (D5) was a bug, now fixed. After prompt changes each passed a re-run except B3, when the model was overloaded. What remains is the small model varying; `gemini-3.6-flash` answered better but a free key allows 20 requests a day.
- **The checks are patterns.** They confirm what was recalled, searched and cited, not that a quoted price is right.
- **Time to first token, median of 3:** no search 1.2 s (target 1.5), 5-item re-check 4.3 s (target 5), recall query 0.9 ms: met. Recall-only 4.1 s (target 2) and single search 6.3 s (target 5): missed. Our steps take milliseconds; the same model call ranged from 1 to 19 s.
- **Recall matches words, not meaning.** A name is not a password. Seeded "then" prices are made up.

## With another week

- A grading model in the eval runner.
- A faster first token: prompt caching, and results trimmed by relevance.
- Recall by meaning; re-check that compares prices and versions in code.
- Accounts, and export or deletion of a user's memory.
