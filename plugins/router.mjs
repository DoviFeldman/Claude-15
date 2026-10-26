// Picks which prompt/tool packs a message needs, and which search results are
// worth keeping, using free decision models on Vercel AI Gateway. When they
// are unavailable the bot simply runs unrouted.

export const PACKS = {
  places: 'stores, restaurants, businesses, opening hours, addresses, distance or travel time, directions',
  web: 'facts that need looking up online: prices, products, specs, news, sports, companies, people, anything recent',
  weather: 'weather, temperature, rain, forecast, sunrise or sunset',
  reminders: 'reminders, alarms, scheduling something, notes, remembering or recalling something',
  self: 'changing the bot itself: its prompt, settings, commands, tools, code, files, or facts about the user',
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

// Tries models in order. The next model is used only when one is rate-limited
// or erroring (it sits out for the gateway's retry-after); a slow answer just
// gives up for this call, since waiting on a second model would double latency.
// questions: { name: yes/no instructions } -> { p: { name: probability }, model } or null.
async function decide(models, state, questions, timeoutMs) {
  if (!process.env.AI_GATEWAY_API_KEY) return null
  for (const model of models) {
    if (Date.now() < (downUntil.get(model) ?? 0)) continue
    try {
      return { p: await evaluate(model, state, questions, timeoutMs), model }
    } catch (e) {
      console.warn(`[router] ${model}: ${e.message}`)
      if (e.name === 'TimeoutError') return null
    }
  }
  return null
}

// One yes/no per pack, bundled in one request, so several packs can be picked
// at once (e.g. "remind me before Target closes" = places + reminders). The
// previous message is included so follow-ups ("and the one in Eatontown?")
// keep their topic. If no model answers in time, packs is null: the bridge
// then shows Qwen everything (full prompt, all tools) rather than guessing.
export async function route(text, previous) {
  const t = Date.now()
  const state = previous?.text
    ? { previous_user_message: previous.text, latest_user_message: text }
    : { latest_user_message: text }
  const d = await decide(ROUTER_MODELS, state, Object.fromEntries(Object.entries(PACKS).map(([k, desc]) =>
    [k, `To answer the latest message (read it as a follow-up if it refers back to the previous one), does the assistant need help with: ${desc}?`])),
  Number(process.env.ROUTER_TIMEOUT_MS ?? 1500))
  if (d) return { packs: Object.keys(PACKS).filter((k) => d.p[k] >= 0.3), by: d.model, ms: Date.now() - t }
  return { packs: null, by: 'none (full prompt)', ms: Date.now() - t }
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
