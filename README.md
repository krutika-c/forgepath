# ForgePath

**An AI developer mentor that recommends your next coding project** — based on your actual skills, your actual goal, and how much time you actually have. Not a random idea generator: it reasons about the fit, tells you when your ambition and your timeline don't match, and lets you tune the result section by section instead of rerolling the whole thing.

---

## Why this is more than a ChatGPT wrapper

| | |
| :--- | :--- |
| **Mentor, not machine** | If your profile has real tension — say, "Beginner" + "1 Week" + "AI / ML" — the model says so explicitly in a **"Reality check"** callout, then explains how it scoped the project down to stay achievable instead of silently dodging the mismatch. |
| **Edit, don't reroll** | Don't like the roadmap but love the project idea? Hit the small refresh icon on just that section (roadmap, features, tech stack, APIs, skills, stretch goals, or the "why this fits you" writeup) and only that part regenerates. |
| **Honest about its limits** | The daily Gemini call budget isn't a silent failure mode — it's a small live pill next to the Generate button ("7 / 10 left today") that turns red as it runs low. |
| **Cost-aware by design** | Identical requests within a short window are served from an in-memory cache instead of re-billed to Gemini, on top of per-IP rate limiting and the global daily cap. |

---

## Features

- **One tailored recommendation at a time** — not a list to sift through. The model reasons over your languages, frameworks, experience, time budget, goal, and interests together.
- **"Reality check" mismatch flagging** — the mentor prompt explicitly asks the model to name any tension in your profile (skill vs. ambition vs. time) rather than paper over it.
- **Per-section regeneration** — regenerate just the roadmap, key features, tech stack, suggested APIs, skills learned, stretch goals, or the "why this fits you" writeup, while the rest of the recommendation stays put.
- **Live "generations left today" indicator** — reads real usage data from the server on load and after every call, so the daily budget is visible instead of a surprise 429.
- **Request caching** — identical profile submissions within a configurable window are served from memory, saving both cost and latency.
- **Favorites drawer** — save recommendations to `localStorage` and revisit them later, including any sections you've regenerated.
- **Two safety nets on Gemini spend** — a per-IP rate limit (10 requests / 15 min) and a global daily request cap, both configurable via environment variables.

---

## How it works

1. You fill in a short profile: languages, frameworks, experience level, time available, goal, and interests.
2. The frontend posts that profile to `POST /api/generate` — your Gemini API key never leaves the server.
3. The server builds a mentor-style prompt, calls Gemini with a strict JSON response schema, and returns a structured project recommendation (including a `mentorNote` field that's only populated when there's a genuine mismatch to flag).
4. You can regenerate any one section via `POST /api/regenerate-section`, which sends back just that piece, re-grounded in the fixed project context so it stays consistent.
5. Every response carries `X-RateLimit-Remaining-Daily` / `X-RateLimit-Limit-Daily` headers, which the frontend uses to keep the usage pill honest.

---

## Project structure

```text
forgepath/
├── frontend/
│   ├── index.html
│   ├── index.css
│   └── index.js
├── node_modules/
├── .env
├── .gitignore
├── package-lock.json
├── package.json
├── README.md
└── server.js
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your own Gemini API key:

```bash
cp .env.example .env
```

```env
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-2.5-flash
PORT=3002
DAILY_REQUEST_LIMIT=100
CACHE_TTL_MINUTES=5
```

| Variable | Purpose | Default |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Your Gemini API key. Required — the server refuses to call Gemini without it. | — |
| `GEMINI_MODEL` | Which Gemini model to call. | `gemini-2.5-flash` |
| `PORT` | Local server port. | `3002` |
| `DAILY_REQUEST_LIMIT` | Hard ceiling on Gemini calls per day, across every visitor combined. Your safety net against cost blowups if this gets shared publicly. | `100` |
| `CACHE_TTL_MINUTES` | How long an identical profile request is served from cache instead of re-billed to Gemini. | `5` |

### 3. Run it

```bash
npm start      # production
npm run dev    # auto-restarts on file changes
```

Visit `http://localhost:3002` (or whatever `PORT` you set).

---

## API reference

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/generate` | `POST` | Generates a full project recommendation from a profile. Body: `{ profile, avoidTitles? }`. |
| `/api/regenerate-section` | `POST` | Regenerates one section of an existing recommendation. Body: `{ profile, project, section }`, where `section` is one of `roadmap`, `keyFeatures`, `technologies`, `suggestedApis`, `skillsLearned`, `stretchGoals`, `whyBestFit`. |
| `/api/usage` | `GET` | Returns today's remaining Gemini budget: `{ limit, remaining, resetAt }`. |

All three set `X-RateLimit-Limit-Daily` and `X-RateLimit-Remaining-Daily` response headers.

---

## Security & cost notes

- Your Gemini API key lives only in `.env` on the server and is never sent to the browser.
- `.env` is git-ignored by default (see `.gitignore`) — don't remove that line.
- Recommendations aren't stored anywhere server-side. Favorites are saved only in your own browser's `localStorage`.
- Because LLM calls cost real money, this repo ships with rate limiting, a global daily cap, and response caching turned on by default — tune `DAILY_REQUEST_LIMIT` and `CACHE_TTL_MINUTES` to whatever you're comfortable spending before deploying this publicly.