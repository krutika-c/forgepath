require('dotenv').config()
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')

const app = express()
const PORT = process.env.PORT || 3002
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

// Hard ceiling on how many times Gemini is allowed to be called per day,
// across ALL visitors combined. This is your safety net against cost blowups if
// this app gets shared/scraped after going public. Tune it to whatever you're
// comfortable spending on. Resets automatically at midnight server time.
const DAILY_REQUEST_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT) || 100

// How long an identical request is served from cache instead of re-billed to Gemini.
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_MINUTES) || 5) * 60 * 1000

// If you deploy behind a platform that proxies requests (Render, Railway, Vercel,
// Heroku, etc.), this tells Express to trust the X-Forwarded-For header so
// rate limiting sees the real visitor IP instead of the proxy's IP. Without this,
// every visitor looks like the same IP and one person could lock out everyone else.
app.set('trust proxy', 1)

// needed so req.body works on POST /api/generate
app.use(express.json())

//web server:
app.use(express.static("frontend"))

// ---- Per-IP rate limit: stops any single visitor from spamming Generate ----
const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 generate/regenerate requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Please wait a few minutes and try again.' }
})

// ---- Global daily cap: stops the SITE TOTAL from exceeding a budget you set ----
let dailyCount = 0
let dailyResetAt = getNextMidnight()

function getNextMidnight() {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

// Rolls the counter over at midnight. Does NOT increment — call this any time
// you need an up-to-date view of today's usage.
function refreshDailyWindow() {
  if (Date.now() >= dailyResetAt) {
    dailyCount = 0
    dailyResetAt = getNextMidnight()
  }
}

function checkDailyBudget() {
  refreshDailyWindow()
  return dailyCount < DAILY_REQUEST_LIMIT
}

function usageInfo() {
  refreshDailyWindow()
  return {
    limit: DAILY_REQUEST_LIMIT,
    remaining: Math.max(0, DAILY_REQUEST_LIMIT - dailyCount),
    resetAt: dailyResetAt
  }
}

// Surfaces the daily budget on every response so the frontend can render an
// honest "X generations left today" indicator instead of the limit being an
// invisible failure mode that only shows up as a mystery 429.
function setUsageHeaders(res) {
  const u = usageInfo()
  res.set('X-RateLimit-Limit-Daily', String(u.limit))
  res.set('X-RateLimit-Remaining-Daily', String(u.remaining))
  res.set('X-RateLimit-Reset', String(u.resetAt))
}

// ---- Response cache: identical profile requests within CACHE_TTL_MS are served
// from memory instead of re-billed to Gemini. Cheap win for e.g. accidental double
// clicks or two visitors with the same profile shape. ----
const responseCache = new Map() // hash -> { data, expiresAt }

function hashKey(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function normalizeProfileForCache(profile, avoidTitles) {
  const norm = (arr) => [...new Set((arr || []).map((s) => String(s).trim().toLowerCase()))].sort()
  return {
    languages: norm(profile.languages),
    frameworks: norm(profile.frameworks),
    experience: String(profile.experience || '').trim().toLowerCase(),
    time: String(profile.time || '').trim().toLowerCase(),
    goal: String(profile.goal || '').trim().toLowerCase(),
    interests: norm(profile.interests),
    avoid: norm(avoidTitles)
  }
}

function getCached(key) {
  const entry = responseCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key)
    return null
  }
  return entry.data
}

function setCached(key, data) {
  // Lazy cleanup of stale entries so this map doesn't grow forever on a long-running server.
  for (const [k, v] of responseCache) {
    if (Date.now() > v.expiresAt) responseCache.delete(k)
  }
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    projectTitle: { type: 'STRING' },
    shortDescription: { type: 'STRING' },
    problemSolved: { type: 'STRING' },
    whyBestFit: { type: 'STRING' },
    keyFeatures: { type: 'ARRAY', items: { type: 'STRING' } },
    technologies: { type: 'ARRAY', items: { type: 'STRING' } },
    suggestedApis: { type: 'ARRAY', items: { type: 'STRING' } },
    skillsLearned: { type: 'ARRAY', items: { type: 'STRING' } },
    difficulty: { type: 'STRING', enum: ['Beginner', 'Intermediate', 'Advanced'] },
    estimatedTime: { type: 'STRING' },
    roadmap: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          milestone: { type: 'STRING' },
          description: { type: 'STRING' }
        },
        required: ['milestone', 'description']
      }
    },
    portfolioValue: { type: 'STRING' },
    stretchGoals: { type: 'ARRAY', items: { type: 'STRING' } },
    // Left as an empty string when there's no real tension in the profile — only
    // populated when the mentor genuinely has something to flag (see prompt).
    mentorNote: { type: 'STRING' }
  },
  required: [
    'projectTitle', 'shortDescription', 'problemSolved', 'whyBestFit', 'keyFeatures',
    'technologies', 'skillsLearned', 'difficulty', 'estimatedTime', 'roadmap',
    'portfolioValue', 'stretchGoals'
  ]
}

function profileBlock(profile) {
  return `- Languages known: ${(profile.languages || []).join(', ') || 'none specified'}
- Frameworks/libraries known: ${(profile.frameworks || []).join(', ') || 'none specified'}
- Experience level: ${profile.experience || 'unspecified'}
- Time available: ${profile.time || 'unspecified'}
- Primary goal: ${profile.goal || 'unspecified'}
- Interests: ${(profile.interests || []).join(', ') || 'open to anything'}`
}

function buildPrompt(profile, avoidTitles) {
  const avoidClause = Array.isArray(avoidTitles) && avoidTitles.length
    ? `Do not recommend any of these previously suggested projects: ${avoidTitles.join('; ')}. Recommend something different.`
    : ''

  return `You are ForgePath, an experienced senior developer acting as a mentor to a less experienced developer. Based on the profile below, recommend exactly ONE project the developer should build next. The project must genuinely match their stated skills and experience level (do not recommend something requiring technologies they don't know unless it's a small, clearly-flagged stretch skill), fit within their available time, and serve their stated goal and interests.

Developer profile:
${profileBlock(profile)}

${avoidClause}

Be specific and practical, not generic. Explain your reasoning like a mentor who actually looked at this person's profile, not a template. The roadmap should have between 4 and 7 realistic milestones sized to fit within the stated time budget.

Act like a real mentor, not a wish-granting machine: if there is a genuine tension in this profile (for example, a beginner picking an ambitious/unfamiliar area like AI/ML with only a weekend or a week, or a stated time budget that's unrealistic for the requested goal), say so plainly in "mentorNote" — name the tension in one or two sentences, then explain how you scoped the recommended project down (or sequenced it) so it's still genuinely achievable while still honoring their stated interest. Do not silently swap in something unrelated to their interests just to dodge the mismatch. If there is no meaningful tension in the profile, set "mentorNote" to an empty string — don't invent a concern that isn't there.`
}

// ---- Section regeneration: lets the frontend ask for a fresh take on ONE part
// of an already-generated project (e.g. just the roadmap) without discarding
// the rest of the recommendation. ----
const SECTION_CONFIG = {
  roadmap: {
    label: 'development roadmap',
    schema: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { milestone: { type: 'STRING' }, description: { type: 'STRING' } },
        required: ['milestone', 'description']
      }
    },
    instruction: 'Provide between 4 and 7 realistic milestones sized to fit the stated time budget.'
  },
  keyFeatures: {
    label: 'key features',
    schema: { type: 'ARRAY', items: { type: 'STRING' } },
    instruction: 'List 4-6 concrete, specific features for this exact project.'
  },
  technologies: {
    label: 'technologies to use',
    schema: { type: 'ARRAY', items: { type: 'STRING' } },
    instruction: "List specific technologies appropriate to the developer's known skills and this project's scope."
  },
  suggestedApis: {
    label: 'suggested public APIs',
    schema: { type: 'ARRAY', items: { type: 'STRING' } },
    instruction: 'List 2-5 real public APIs relevant to the project, or an empty array if none genuinely fit.'
  },
  skillsLearned: {
    label: 'skills the developer will learn',
    schema: { type: 'ARRAY', items: { type: 'STRING' } },
    instruction: 'List 3-6 concrete, specific skills this project will build.'
  },
  stretchGoals: {
    label: 'future improvements and stretch goals',
    schema: { type: 'ARRAY', items: { type: 'STRING' } },
    instruction: 'List 3-5 stretch goals of increasing ambition beyond the core build.'
  },
  whyBestFit: {
    label: 'why this project fits the developer',
    schema: { type: 'STRING' },
    instruction: 'Write 2-4 sentences, specific to this profile and this project.'
  }
}

function buildSectionPrompt(profile, project, sectionKey, previousValue) {
  const cfg = SECTION_CONFIG[sectionKey]
  const previousText = previousValue !== undefined && previousValue !== null && previousValue !== ''
    ? `\nPrevious ${cfg.label}: ${typeof previousValue === 'string' ? previousValue : JSON.stringify(previousValue)}\nGive a genuinely different take — don't just reword the same ideas.`
    : ''

  return `You are ForgePath, a senior developer mentor. A developer has already committed to the project below. Regenerate ONLY the "${cfg.label}" for this project. Do not change the project's identity, difficulty, or overall scope — everything you produce must still make sense for this exact project and this exact developer.

Fixed project context:
- Title: ${project.projectTitle || ''}
- Description: ${project.shortDescription || ''}
- Problem solved: ${project.problemSolved || ''}
- Difficulty: ${project.difficulty || ''}
- Estimated time: ${project.estimatedTime || ''}

Developer profile:
${profileBlock(profile || {})}

${cfg.instruction}${previousText}`
}

async function callGeminiJSON(prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`

  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.9
      }
    })
  })

  if (!geminiRes.ok) {
    let detail = `Gemini API request failed with status ${geminiRes.status}`
    try {
      const errJson = await geminiRes.json()
      detail = errJson?.error?.message || detail
    } catch (_) { /* ignore parse error */ }
    const err = new Error(detail)
    err.status = geminiRes.status
    throw err
  }

  const data = await geminiRes.json()
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
  if (!text) {
    const err = new Error('The model returned an empty response.')
    err.status = 502
    throw err
  }

  try {
    return JSON.parse(text)
  } catch (_) {
    const err = new Error('The model returned a response that could not be parsed.')
    err.status = 502
    throw err
  }
}

// Lightweight endpoint so the frontend can show "X left today" on page load,
// before the visitor has generated anything yet.
app.get('/api/usage', (req, res) => {
  setUsageHeaders(res)
  res.json(usageInfo())
})

app.post('/api/generate', generateLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) {
    setUsageHeaders(res)
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Add it to your .env file and restart the server.' })
  }

  const { profile, avoidTitles } = req.body || {}
  if (!profile || !Array.isArray(profile.languages) || profile.languages.length === 0) {
    setUsageHeaders(res)
    return res.status(400).json({ error: 'A profile with at least one language is required.' })
  }

  const cacheKey = hashKey({ mode: 'generate', ...normalizeProfileForCache(profile, avoidTitles) })
  const cached = getCached(cacheKey)
  if (cached) {
    res.set('X-Cache', 'HIT')
    setUsageHeaders(res)
    return res.json(cached)
  }

  if (!checkDailyBudget()) {
    res.set('X-Cache', 'MISS')
    setUsageHeaders(res)
    return res.status(429).json({ error: 'This app has hit its daily generation limit. Please try again tomorrow.' })
  }

  try {
    dailyCount++
    const parsed = await callGeminiJSON(buildPrompt(profile, avoidTitles), RESPONSE_SCHEMA)
    if (typeof parsed.mentorNote !== 'string') parsed.mentorNote = ''
    setCached(cacheKey, parsed)
    res.set('X-Cache', 'MISS')
    setUsageHeaders(res)
    return res.json(parsed)
  } catch (err) {
    console.error('Gemini request error:', err)
    res.set('X-Cache', 'MISS')
    setUsageHeaders(res)
    return res.status(err.status && Number.isInteger(err.status) ? err.status : 500).json({ error: err.message || 'Failed to reach the Gemini API. Check your server connection and try again.' })
  }
})

app.post('/api/regenerate-section', generateLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) {
    setUsageHeaders(res)
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Add it to your .env file and restart the server.' })
  }

  const { profile, project, section } = req.body || {}
  const cfg = SECTION_CONFIG[section]

  if (!cfg) {
    setUsageHeaders(res)
    return res.status(400).json({ error: 'Unknown or unsupported section.' })
  }
  if (!profile || !Array.isArray(profile.languages) || profile.languages.length === 0) {
    setUsageHeaders(res)
    return res.status(400).json({ error: 'A profile with at least one language is required.' })
  }
  if (!project || !project.projectTitle) {
    setUsageHeaders(res)
    return res.status(400).json({ error: 'Missing project context to regenerate against.' })
  }

  if (!checkDailyBudget()) {
    setUsageHeaders(res)
    return res.status(429).json({ error: 'This app has hit its daily generation limit. Please try again tomorrow.' })
  }

  const schema = { type: 'OBJECT', properties: { value: cfg.schema }, required: ['value'] }

  try {
    dailyCount++
    const parsed = await callGeminiJSON(
      buildSectionPrompt(profile, project, section, project[section]),
      schema
    )
    setUsageHeaders(res)
    return res.json({ section, value: parsed.value })
  } catch (err) {
    console.error('Gemini section regenerate error:', err)
    setUsageHeaders(res)
    return res.status(err.status && Number.isInteger(err.status) ? err.status : 500).json({ error: err.message || 'Failed to regenerate this section. Try again.' })
  }
})

// Fallback to index.html for any non-API route (simple SPA support)
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'))
})

app.listen(PORT, function () {
  console.log("successfully running at http://localhost:" + PORT)
  console.log(`Safety limits active: max 10 requests per IP per 15 min, ${DAILY_REQUEST_LIMIT} total requests per day, ${CACHE_TTL_MS / 60000}min cache window.`)
  if (!GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY is not set. Add it to a .env file before generating projects.')
  }
})