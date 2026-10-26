// Picks which prompt/tool packs a message needs, and which search results are
// worth keeping. Uses Jev (TypeSafe decision model) when a key works, else a
// free keyword fallback, so the bot never depends on Jev being up.

export const PACKS = {
  places: 'stores, restaurants, businesses, opening hours, addresses, distance or travel time, directions',
  web: 'facts that need looking up online: prices, products, specs, news, sports, companies, people, anything recent',
  weather: 'weather, temperature, rain, forecast, sunrise or sunset',
  reminders: 'reminders, alarms, scheduling something, notes, remembering or recalling something',
  self: 'changing the bot itself: its prompt, settings, commands, tools, code, files, or facts about the user',
}

// Plurals (reminders, stores) match via the trailing (?:s|es)?.
const KEYWORDS = {
  places: /\b(store|shop|restaurant|cafe|coffee|dunkin|starbucks|target|walmart|uniqlo|mall|open|close[sd]?|hours|near(by| me)?|closest|nearest|address|street|far|distance|drive|driving|walk|bike|miles?|minutes? away|get to|directions|pharmacy|gas|grocery|pizza|dinner|lunch|breakfast|food|eat|bakery|bagel|sushi)(?:s|es)?\b/i,
  web: /(\$\d)|\b(best|top|under|price|cost|how much|buy|cheapest|least|news|score|game|win|won|beat|last night|yesterday|today's|tonight's|who is|what is the|latest|release|specs?|range|battery|review|vs\.?|compare|stock|company|invest|minimum|website|search|google|look up)(?:s|es)?\b/i,
  weather: /\b(weather|rain|snow|temperature|temp|cold|hot|warm|forecast|wind|humid|storm|sunny|cloudy|sunset|sunrise|umbrella|jacket)(?:s|es)?\b/i,
  reminders: /\b(remind|reminder|alarm|schedule|every (day|week|morning|night)|everyday|tomorrow at|note|notes|remember|forget|wrote down|todo|to-do)(?:s|es)?\b/i,
  self: /\b(edit yourself|change your|update your|commands?|menu|your (prompt|settings?|commands?|tools?|code|files?)|fresh chat|idle|make (a|yourself a) (tool|command)|build (a|yourself a) tool|setting|\/cmd|harness|plugin|restart)(?:s|es)?\b/i,
}

function keywordRoute(text) {
  return Object.keys(PACKS).filter((p) => KEYWORDS[p].test(text))
}

// --- Decision-model client ---------------------------------------------
// Vercel AI Gateway /v1/evaluate. Each job tries its models in order and falls
// through on errors or rate limits (free tier: 5 req/min per model). Defaults
// are Baseten's zero-data-retention models; Elephant-1 benched best at both
// routing (19/19) and result filtering. Laya is not used: it retains data and
// scored results almost uniformly.
const list = (v, d) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean)
const ROUTER_MODELS = list(process.env.ROUTER_MODELS, 'baseten/elephant-1,baseten/mammoth-1')
const FILTER_MODELS = list(process.env.FILTER_MODELS, 'baseten/elephant-1,baseten/mammoth-1')
const downUntil = new Map() // model -> time it may be tried again

async function evaluate(model, state, questions, timeoutMs) {
  const res = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'boolean', instructions: q }])) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    // Rate limit: sit out only as long as the gateway says; other errors: 10 min.
    const wait = res.status === 429 ? Number(res.headers.get('retry-after') ?? 10) * 1000 : 10 * 60000
    downUntil.set(model, Date.now() + wait)
    throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`)
  }
  const { answers } = await res.json()
  return Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.probability ?? 0]))
}

// questions: { name: yes/no instructions } -> { p: { name: probability }, model } or null.
async function decide(models, state, questions, timeoutMs) {
  if (!process.env.AI_GATEWAY_API_KEY) return null
  for (const model of models) {
    if (Date.now() < (downUntil.get(model) ?? 0)) continue
    try {
      return { p: await evaluate(model, state, questions, timeoutMs), model }
    } catch (e) {
      if (!downUntil.has(model) || Date.now() >= downUntil.get(model)) downUntil.set(model, Date.now() + 60000) // timeouts
      console.warn(`[router] ${model}: ${e.message}`)
    }
  }
  return null
}

// One yes/no per pack, bundled in one request. Liberal threshold: a missing
// tool costs more than a few extra prompt lines.
// Routing sits in front of every reply, so all router models are asked at once
// and the first answer wins, capped at ROUTER_TIMEOUT_MS (cold starts happen).
async function race(models, state, questions, timeoutMs) {
  const live = models.filter((m) => Date.now() >= (downUntil.get(m) ?? 0))
  if (!process.env.AI_GATEWAY_API_KEY || !live.length) return null
  return Promise.any(live.map((m) => decide([m], state, questions, timeoutMs).then((d) => d ?? Promise.reject(new Error('no answer')))))
    .catch(() => null)
}

export async function route(text) {
  const t = Date.now()
  const d = await race(ROUTER_MODELS, `User message to a personal assistant: ${text}`, Object.fromEntries(
    Object.entries(PACKS).map(([k, desc]) => [k, `Does answering this message need help with: ${desc}?`])), Number(process.env.ROUTER_TIMEOUT_MS ?? 1500))
  // Model and keywords are unioned: either one spotting a need is enough.
  const kw = keywordRoute(text)
  const picked = d ? [...new Set([...Object.keys(PACKS).filter((k) => d.p[k] >= 0.3), ...kw])] : kw
  // Nothing matched: still allow a web lookup rather than leave the model toolless.
  const packs = picked.length ? picked : ['web']
  return { packs, by: d?.model ?? 'keywords', ms: Date.now() - t }
}

// Keep only search results that help answer `query`; fallback keeps Google's top `keep`.
export async function filterResults(query, results, keep = 3) {
  if (results.length <= keep) return { results, by: 'none' }
  const d = await decide(FILTER_MODELS,
    { question: query, results: Object.fromEntries(results.map((r, i) => [`r${i}`, r])) },
    Object.fromEntries(results.map((_, i) => [`r${i}`, `Does result r${i} contain information that helps answer the question?`])),
    Number(process.env.FILTER_TIMEOUT_MS ?? 2500))
  if (!d) return { results: results.slice(0, keep), by: 'order' }
  const ranked = results.map((r, i) => [r, d.p[`r${i}`] ?? 0]).sort((a, b) => b[1] - a[1])
  const good = ranked.filter(([, p]) => p >= 0.5).slice(0, keep)
  // Keep at least 2: with a single snippet Qwen tends to embellish the gaps.
  return { results: (good.length >= 2 ? good : ranked.slice(0, Math.min(2, keep))).map(([r]) => r), by: d.model }
}
