# Snapshots — what worked and what didn't

Local history for the bot. Compare any file against a good snapshot with:
`git diff good-2026-10-27 -- <file>` · list snapshots: `git tag -l 'good-*'` · see one: `git show good-2026-10-27:<file>`

## good-2026-10-27 — baseline that worked well (deployed Oct 27, 5:30 PM)

**Measured (data/turns.log):**

| Period | Median answer | p90 | Median tokens in | Under 5 s |
|---|---|---|---|---|
| Before routing (Oct 25-26) | 2.9 s | 147 s | 3,568 | 19/30 |
| Routing era (Oct 26-27) | 1.5 s | 24.7 s | 1,801 | 24/29 |
| After this deploy (Oct 27-28) | 1.8 s | 2.7 s | 1,460 | 33/34 |

**Setup that produced it:**
- Model: Groq `qwen/qwen3.8-27b` (free tier: ~7,000 input tokens/min, 200k tokens/day). maxTokens 1500, 6-step cap.
- Prompt split into `agent/packs/*.md` (core always; places, web, weather, reminders, self on demand). User facts (`agent/me.md`) only ride along with packs that use them.
- Router (`plugins/router.mjs`): `baseten/elephant-1` decides packs (yes/no per pack, threshold 0.3), `baseten/mammoth-1` only when Elephant is rate-limited (free tier: 5 req/min per model). Previous message passed for follow-ups. No answer within 1.5 s → turn runs with the full prompt. Bench: 19/19 standalone, 4/4 follow-ups.
- Search filter: Serper results scored by Elephant then Mammoth; keep >= 2, max 3 (fallback Google's top 3).
- Places: Serper `/maps` (has hours), today's hours + distance computed in code, nearest first, zoom widens when nothing nearby.
- Tools return finished answers (hours for today, distances, plain-English reminder parsing in `plugins/when.mjs`) so the model does no weekday or date math. `calc` for arithmetic and time math.

**What did NOT work (don't repeat):**
- Keyword routing: worked (19/19 after fixes) but the user disliked it; removed.
- Racing both decision models at once: wasted the 5/min free quota.
- `convaiinnovations/laya(-free)`: retains and trains on data, scored search results almost uniformly (~0.86), rejected requests. Not used.
- Jev (`typesafe-ai/jev`) and `liquid/d1`: need paid Vercel credits.
- Keeping only 1 search result: Qwen embellished the gaps (invented a "4-0 lead"). Keep >= 2.
- Long chat sessions: Qwen started inventing answers (made up a bitcoin price). Sessions rotate after idle time / heavy turns.
- Grok (`grok-4.3`, xAI OAuth) as the self-editing model: faked tool calls (`calc "done"`) instead of using `shell`, claimed it could not run commands.
- tomorrow.io sun/moon times: moonrise off by 10-80 min or missing (UTC day windows). Fixed after this snapshot by using the US Naval Observatory API.
- Bot-made `agent/tools/astronomy.mjs`: truncated code, never loaded.
