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
// Vercel AI Gateway /v1/evaluate (yes/no type "boolean", field "probability"),
// or TypeSafe's own API (type "noul", field "noul"). DECISION_MODEL picks the
// model; off unless set, since Vercel's free tier does not serve Jev.
function endpoint() {
  const model = process.env.DECISION_MODEL
  if (process.env.TYPESAFE_API_KEY) return { url: 'https://api.typesafe.ai/v1/systemone', key: process.env.TYPESAFE_API_KEY, model: model ?? 'jev-latest', yesNo: 'noul' }
  if (process.env.AI_GATEWAY_API_KEY && model) return { url: 'https://ai-gateway.vercel.sh/v1/evaluate', key: process.env.AI_GATEWAY_API_KEY, model, yesNo: 'boolean' }
  return null
}

let downUntil = 0 // after a failure, skip the model for a while instead of paying the timeout every message

// questions: { name: instructions } yes/no questions -> { name: probability } or null.
export async function jev(state, questions, timeoutMs = Number(process.env.JEV_TIMEOUT_MS ?? 2500)) {
  const ep = endpoint()
  if (!ep || Date.now() < downUntil) return null
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ep.model, state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: ep.yesNo, instructions: q }])) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`)
    const { answers } = await res.json()
    return Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.probability ?? a.noul ?? 0]))
  } catch (e) {
    downUntil = Date.now() + 10 * 60000
    console.warn(`[router] ${ep.model} unavailable, using fallback for 10 min: ${e.message}`)
    return null
  }
}

// Bundled yes/no per pack (Jev runs them in parallel). Liberal threshold: a
// missing tool costs more than a few extra prompt lines.
export async function route(text) {
  const t = Date.now()
  const p = await jev(`User message to a personal assistant: ${text}`, Object.fromEntries(
    Object.entries(PACKS).map(([k, desc]) => [k, `Does answering this message need help with: ${desc}?`])))
  // Model and keywords are unioned: either one spotting a need is enough.
  const kw = keywordRoute(text)
  const picked = p ? [...new Set([...Object.keys(PACKS).filter((k) => p[k] >= 0.3), ...kw])] : kw
  // Nothing matched: still allow a web lookup rather than leave the model toolless.
  const packs = picked.length ? picked : ['web']
  return { packs, by: p ? process.env.DECISION_MODEL ?? 'jev' : 'keywords', ms: Date.now() - t, ...(p ? { scores: p } : {}) }
}

// Keep only search results that help answer `query`. Jev scores each one;
// fallback keeps the first `keep` in Google's order.
export async function filterResults(query, results, keep = 3) {
  if (results.length <= keep) return { results, by: 'none' }
  const p = await jev(
    { question: query, results: Object.fromEntries(results.map((r, i) => [`r${i}`, r])) },
    Object.fromEntries(results.map((_, i) => [`r${i}`, `Does result r${i} contain information that helps answer the question?`])))
  if (!p) return { results: results.slice(0, keep), by: 'order' }
  const ranked = results.map((r, i) => [r, p[`r${i}`] ?? 0]).sort((a, b) => b[1] - a[1])
  const good = ranked.filter(([, p]) => p >= 0.5).slice(0, keep)
  return { results: (good.length ? good : ranked.slice(0, 1)).map(([r]) => r), by: 'jev' }
}
