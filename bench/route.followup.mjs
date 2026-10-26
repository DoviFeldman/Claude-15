// SPACING_MS=12500 node bench/route.followup.mjs — real route() on standalone questions and follow-up pairs.
const { route } = await import('../plugins/router.mjs')
const src = (await import('node:fs')).readFileSync(new URL('./router.bench.mjs', import.meta.url), 'utf8')
const i = src.indexOf('const cases = ') + 14
const standalone = eval(src.slice(i, src.indexOf(']\n', i) + 1)).map(([q, w]) => [null, q, w])
const followups = [
  [['is the target near me open right now?', ['places']], 'what about the one in Eatontown?', ['places']],
  [['will it rain tomorrow?', ['weather']], 'and friday?', ['weather']],
  [['who won game 2 of the world series?', ['web']], 'when is the next game?', ['web']],
  [['will it rain tomorrow?', ['weather']], 'ok whats 15% of 84', []],
]
const spacing = Number(process.env.SPACING_MS ?? 0)
let ok = 0, n = 0, ms = []
for (const [prev, q, want] of [...standalone, ...followups]) {
  if (spacing) await new Promise((r) => setTimeout(r, spacing))
  const r = await route(q, prev ? { text: prev[0], packs: prev[1] } : undefined)
  ms.push(r.ms); n++
  const hit = want.every((w) => r.packs.includes(w)) && r.packs.length <= want.length + 1
  ok += hit
  if (!hit || prev) console.log(`${hit ? 'ok ' : 'BAD'} ${JSON.stringify(r.packs).padEnd(24)} ${r.by.padEnd(20)} ${r.ms}ms  ${prev ? `[after "${prev[0]}"] ` : ''}${q}`)
}
console.log(`\n${ok}/${n} correct, median ${ms.sort((a, b) => a - b)[ms.length >> 1]} ms`)
