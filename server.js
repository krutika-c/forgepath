require('dotenv').config()
const express = require('express')
const path = require('path')
const rateLimit = require('express-rate-limit')

const app = express()
const PORT = process.env.PORT || 3002
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

// Hard ceiling on how many times /api/generate is allowed to call Gemini per day,
// across ALL visitors combined. This is your safety net against cost blowups if
// this app gets shared/scraped after going public. Tune it to whatever you're
// comfortable spending on. Resets automatically at midnight server time.
const DAILY_REQUEST_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT) || 100

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
  max: 10, // max 10 generate requests per IP per window
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

function checkDailyBudget() {
  if (Date.now() >= dailyResetAt) {
    dailyCount = 0
    dailyResetAt = getNextMidnight()
  }
  return dailyCount < DAILY_REQUEST_LIMIT
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
    stretchGoals: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: [
    'projectTitle', 'shortDescription', 'problemSolved', 'whyBestFit', 'keyFeatures',
    'technologies', 'skillsLearned', 'difficulty', 'estimatedTime', 'roadmap',
    'portfolioValue', 'stretchGoals'
  ]
}

function buildPrompt(profile, avoidTitles) {
  const avoidClause = Array.isArray(avoidTitles) && avoidTitles.length
    ? `Do not recommend any of these previously suggested projects: ${avoidTitles.join('; ')}. Recommend something different.`
    : ''

  return `You are ForgePath, an experienced senior developer acting as a mentor to a less experienced developer. Based on the profile below, recommend exactly ONE project the developer should build next. The project must genuinely match their stated skills and experience level (do not recommend something requiring technologies they don't know unless it's a small, clearly-flagged stretch skill), fit within their available time, and serve their stated goal and interests.

Developer profile:
- Languages known: ${(profile.languages || []).join(', ') || 'none specified'}
- Frameworks/libraries known: ${(profile.frameworks || []).join(', ') || 'none specified'}
- Experience level: ${profile.experience || 'unspecified'}
- Time available: ${profile.time || 'unspecified'}
- Primary goal: ${profile.goal || 'unspecified'}
- Interests: ${(profile.interests || []).join(', ') || 'open to anything'}

${avoidClause}

Be specific and practical, not generic. Explain your reasoning like a mentor who actually looked at this person's profile, not a template. The roadmap should have between 4 and 7 realistic milestones sized to fit within the stated time budget.`
}

// This is the route your frontend calls when you click "Generate" — it was missing before,
// which is why the request was failing.
app.post('/api/generate', generateLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Add it to your .env file and restart the server.' })
  }

  if (!checkDailyBudget()) {
    return res.status(429).json({ error: 'This app has hit its daily generation limit. Please try again tomorrow.' })
  }

  const { profile, avoidTitles } = req.body || {}
  if (!profile || !Array.isArray(profile.languages) || profile.languages.length === 0) {
    return res.status(400).json({ error: 'A profile with at least one language is required.' })
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`

  try {
    dailyCount++

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(profile, avoidTitles) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
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
      return res.status(geminiRes.status).json({ error: detail })
    }

    const data = await geminiRes.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
    if (!text) {
      return res.status(502).json({ error: 'The model returned an empty response.' })
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (_) {
      return res.status(502).json({ error: 'The model returned a response that could not be parsed.' })
    }

    return res.json(parsed)
  } catch (err) {
    console.error('Gemini request error:', err)
    return res.status(500).json({ error: 'Failed to reach the Gemini API. Check your server connection and try again.' })
  }
})

// Fallback to index.html for any non-API route (simple SPA support)
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'))
})

app.listen(PORT, function () {
  console.log("successfully running at http://localhost:" + PORT)
  console.log(`Safety limits active: max 10 requests per IP per 15 min, ${DAILY_REQUEST_LIMIT} total requests per day.`)
  if (!GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY is not set. Add it to a .env file before generating projects.')
  }
})