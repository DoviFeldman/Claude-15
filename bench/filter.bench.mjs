// node bench/filter.bench.mjs model... — show which Serper results each decision model keeps.
const KEY = process.env.AI_GATEWAY_API_KEY, SERPER = process.env.SERPER_API_KEY
const models = process.argv.slice(2)
const queries = ['DJI Mini 5 Pro max transmission range', 'TypeSafe Jev API pricing per token', 'World Series 2026 game 3 start time']
for (const q of queries) {
  const d = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': SERPER, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, num: 8 }) }).then((r) => r.json())
  const results = (d.organic ?? []).map((r) => `${r.title}: ${(r.snippet ?? '').slice(0, 200)}`)
  console.log(`\n### ${q}`); results.forEach((r, i) => console.log(`  r${i} ${r.slice(0, 110)}`))
  for (const m of models) {
    await new Promise((r) => setTimeout(r, 13000))
    const t = Date.now()
    const res = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, state: { question: q, results: Object.fromEntries(results.map((r, i) => [`r${i}`, r])) },
        questions: Object.fromEntries(results.map((_, i) => [`r${i}`, { type: 'boolean', instructions: `Does result r${i} contain information that helps answer the question?` }])) }) }).then((r) => r.json())
    const p = Object.entries(res.answers ?? {}).map(([k, v]) => [k, v.probability]).sort((a, b) => b[1] - a[1])
    console.log(`  ${m.padEnd(24)} ${Date.now() - t}ms  ${res.error ? res.error.message.slice(0, 90) : p.map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}`)
  }
}
