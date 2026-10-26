// node bench/router.bench.mjs — compare a gateway decision model vs keyword routing on labeled questions.
const KEY = process.env.AI_GATEWAY_API_KEY, MODEL = process.argv[2] ?? 'convaiinnovations/laya-free'
const { PACKS } = await import('../plugins/router.mjs')
const cases = [
  ['how far is the closest Uniqlo?', ['places']], ["What's the least amount of money I can put into JEV from typesafe AI?", ['web']],
  ['make /new the last command in the menu', ['self']], ['Is the Dunkin on ocean and Brighton open now?', ['places']],
  ['whats 15% of 84?', []], ['what is the range of a DJI mini 5 drone?', ['web']], ['remind me everyday at 8am to take vitamins', ['reminders']],
  ['will it rain tomorrow?', ['weather']], ['who was the first president of the US?', []], ['how long to drive to Philly?', ['places']],
  ['best noise cancelling headphones under $200', ['web']], ['what notes do I have?', ['reminders']], ['is it jacket weather tonight?', ['weather']],
  ['start a fresh chat after 2 hours of quiet', ['self']], ['did the Brewers win last night?', ['web']], ['any pizza open late near me?', ['places']],
  ['what reminders do I have?', ['reminders']], ['which stores sell AA batteries around here?', ['places']], ['any restaurants open now?', ['places']],
]
const kw = (await import('../plugins/router.mjs'))
let okM = 0, okK = 0, ms = []
const SPACING = Number(process.env.SPACING_MS ?? 0) // free gateway tier: 5 req/min per model
for (const [q, want] of cases) {
  if (SPACING) await new Promise((r) => setTimeout(r, SPACING))
  const t = Date.now()
  const res = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state: `User message to a personal assistant: ${q}`, questions: Object.fromEntries(Object.entries(PACKS).map(([p, d]) => [p, { type: 'boolean', instructions: `Does answering this message need help with: ${d}?` }])) }) }).then((r) => r.json())
  ms.push(Date.now() - t)
  const probs = Object.fromEntries(Object.entries(res.answers ?? {}).map(([k, v]) => [k, v.probability]))
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1])
  const model = top.filter(([, p]) => p >= 0.3).map(([k]) => k)
  const keyw = (await kw.route(q)).packs
  const hit = (got) => want.every((w) => got.includes(w)) && got.length <= want.length + 1
  if (hit(model)) okM++; if (hit(keyw)) okK++
  console.log(`${hit(model) ? 'ok ' : 'BAD'} model=${JSON.stringify(model).padEnd(22)} ${hit(keyw) ? 'ok ' : 'BAD'} kw=${JSON.stringify(keyw).padEnd(14)} ${ms.at(-1)}ms  ${q.slice(0, 45)} ${res.error ? res.error.message.slice(0, 80) : top.slice(0, 2).map(([k, p]) => k + '=' + p.toFixed(2)).join(' ')}`)
}
console.log(`\n${MODEL}: ${okM}/${cases.length} correct, median ${ms.sort((a, b) => a - b)[ms.length >> 1]} ms | keywords: ${okK}/${cases.length}`)
