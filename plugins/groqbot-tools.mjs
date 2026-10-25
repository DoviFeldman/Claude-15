// Groqbot preset plugin: tiny editable prompt + cheap tools (weather, search,
// places, travel time, notes) + make_tool so the agent can grow new tools.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseWhen } from './when.mjs'

export const name = 'groqbot-tools'
export const inject = ['tools', 'systemPrompt']

const ROOT = process.env.GROQBOT_HOME ?? join(process.env.HOME, 'GroqAgent')
const AGENT = join(ROOT, 'agent')
const TOOLS_DIR = join(AGENT, 'tools')
const NOTES = join(ROOT, 'data', 'notes.json')
// The user's home (city/address) lives in .env only, never in the repo.
const HOME = process.env.GROQBOT_HOME_LOCATION || 'New York, NY'
const UA = { 'User-Agent': 'groqbot/0.1 (personal assistant)' }

const text = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }
const read = (f, d = '') => { try { return readFileSync(f, 'utf8') } catch { return d } }

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...init.headers }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// Tomorrow.io weatherCode -> words (common codes only).
const WX = { 1000: 'clear', 1100: 'mostly clear', 1101: 'partly cloudy', 1102: 'mostly cloudy', 1001: 'cloudy',
  2000: 'fog', 2100: 'light fog', 4000: 'drizzle', 4001: 'rain', 4200: 'light rain', 4201: 'heavy rain',
  5000: 'snow', 5001: 'flurries', 5100: 'light snow', 5101: 'heavy snow', 6000: 'freezing drizzle',
  6001: 'freezing rain', 7000: 'ice pellets', 8000: 'thunderstorm' }

async function weather({ location, days }) {
  const key = process.env.TOMORROW_API_KEY
  if (!key) return 'TOMORROW_API_KEY not set.'
  const c = await geocode(location || HOME) // tomorrow.io chokes on "City, ST zip"
  const n = Math.min(Math.max(days ?? 2, 1), 5)
  const d = await getJson(`https://api.tomorrow.io/v4/weather/forecast?location=${c.lat},${c.lon}&timesteps=1d,1h&units=imperial&apikey=${key}`)
  const now = d.timelines.hourly[0].values
  const lines = [c.name.split(',').slice(0, 3).join(','),
    `Now: ${Math.round(now.temperature)}F (feels ${Math.round(now.temperatureApparent)}F), ${WX[now.weatherCode] ?? now.weatherCode}, wind ${Math.round(now.windSpeed)} mph, rain chance ${now.precipitationProbability}%`]
  for (const day of d.timelines.daily.slice(0, n)) {
    const v = day.values
    lines.push(`${day.time.slice(0, 10)}: ${Math.round(v.temperatureMin)}-${Math.round(v.temperatureMax)}F, ${WX[v.weatherCodeMax] ?? v.weatherCodeMax}, rain ${v.precipitationProbabilityMax}%`)
  }
  return lines.join('\n')
}

async function serper(path, body) {
  const key = process.env.SERPER_API_KEY
  if (!key) return null
  return getJson(`https://google.serper.dev/${path}`, {
    method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function webSearch({ query }) {
  const d = await serper('search', { q: query, gl: 'us', num: 6 })
  if (!d) return 'Search unavailable: SERPER_API_KEY not set.'
  const out = []
  if (d.answerBox) out.push(`Answer: ${d.answerBox.answer ?? d.answerBox.snippet ?? ''}`)
  if (d.knowledgeGraph?.description) out.push(`KG: ${d.knowledgeGraph.title}: ${d.knowledgeGraph.description}`)
  for (const r of (d.organic ?? []).slice(0, 5)) out.push(`- ${r.title}: ${r.snippet ?? ''} (${r.link})`)
  return out.join('\n').slice(0, 2500) || 'No results.'
}

// Straight-line miles between two lat/lon points.
function miles(a, b) {
  const r = (d) => (d * Math.PI) / 180
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2
  return 7918 * Math.asin(Math.sqrt(h))
}

async function places({ query, near }) {
  const where = near || HOME
  const c = await geocode(where)
  // Serper /maps (not /places) is the endpoint that returns opening hours.
  const d = await serper('maps', { q: query, ll: `@${c.lat},${c.lon},12z` })
  if (d) {
    const day = new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'long' })
    const rows = (d.places ?? []).slice(0, 5).map((p) => ({
      ...p, mi: p.latitude ? miles(c, { lat: p.latitude, lon: p.longitude }) : undefined,
    })).sort((a, b) => (a.mi ?? 99) - (b.mi ?? 99))
    return rows.map((p) => [
      `- ${p.title}`, p.address, p.mi !== undefined ? `${p.mi.toFixed(1)} mi` : '',
      p.openingHours ? `today (${day}) ${p.openingHours[day]?.replace(/ /g, ' ') ?? 'n/a'}` : 'hours n/a',
      p.rating ? `${p.rating}★ (${p.ratingCount})` : '', p.type ?? '', p.phoneNumber ?? '',
    ].filter(Boolean).join(' | ')).join('\n') + `\n(nearest first; straight-line distance from ${near ? where : 'home'})` || 'No places found.'
  }
  // Fallback without Serper: OpenStreetMap, which often has opening_hours.
  const box = [c.lon - 0.12, c.lat + 0.09, c.lon + 0.12, c.lat - 0.09].join(',')
  const r = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&extratags=1&bounded=1&viewbox=${box}&q=${encodeURIComponent(query)}`)
  if (!r.length) return 'No places found.'
  return r.map((p) => `- ${p.name || p.display_name.split(',')[0]} | ${p.display_name.split(',').slice(1, 4).join(',')} | ${hoursToday(p.extratags?.opening_hours)}`).join('\n')
    + '\n(source: OpenStreetMap; hours may be outdated)'
}

// Resolve the simple OSM opening_hours forms ("Mo-Sa 07:00-23:00; Su 08:00-20:00")
// to today's hours, so the model does not have to do weekday math.
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
function hoursToday(spec) {
  if (!spec) return 'hours unknown'
  if (spec.trim() === '24/7') return 'open 24/7'
  const today = DAYS.indexOf(new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'short' }).slice(0, 2))
  for (const rule of spec.split(';').map((s) => s.trim())) {
    const m = rule.match(/^([A-Za-z,\- ]+?)\s+([\d:,\- ]+|off|closed)$/)
    if (!m) continue
    const hit = m[1].split(',').some((part) => {
      const [a, b] = part.trim().split('-').map((d) => DAYS.indexOf(d))
      if (a < 0) return false
      return b === undefined ? a === today : a <= b ? today >= a && today <= b : today >= a || today <= b
    })
    if (hit) return /off|closed/.test(m[2]) ? `closed today (raw: ${spec})` : `today ${m[2]} (raw: ${spec})`
  }
  return `hours: ${spec}`
}

async function geocode(q) {
  const r = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`)
  if (!r.length) throw new Error(`could not find "${q}"`)
  return { lat: +r[0].lat, lon: +r[0].lon, name: r[0].display_name }
}

async function travelTime({ to, from, mode }) {
  const a = await geocode(from || HOME)
  const b = await geocode(to)
  const profile = { walk: 'foot', bike: 'bike' }[mode] ?? 'car'
  const host = { foot: 'routing.openstreetmap.de/routed-foot', bike: 'routing.openstreetmap.de/routed-bike', car: 'router.project-osrm.org' }[profile]
  const r = await getJson(`https://${host}/route/v1/${profile === 'car' ? 'driving' : profile}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`)
  const route = r.routes?.[0]
  if (!route) return 'No route found.'
  return `${(route.distance / 1609.34).toFixed(1)} mi, about ${Math.round(route.duration / 60)} min by ${mode || 'car'} without traffic, to ${b.name.split(',').slice(0, 3).join(',')}`
}

function notes({ action, text: body, id }) {
  const list = JSON.parse(read(NOTES, '[]'))
  if (action === 'add') {
    if (!body) return 'text required'
    const note = { id: (list.at(-1)?.id ?? 0) + 1, text: body, at: new Date().toISOString().slice(0, 16) }
    list.push(note); writeFileSync(NOTES, JSON.stringify(list, null, 1))
    return `saved note #${note.id}`
  }
  if (action === 'delete') {
    const next = list.filter((n) => n.id !== id)
    writeFileSync(NOTES, JSON.stringify(next, null, 1))
    return next.length < list.length ? `deleted #${id}` : `no note #${id}`
  }
  const q = body?.toLowerCase()
  const hits = q ? list.filter((n) => n.text.toLowerCase().includes(q)) : list
  return hits.map((n) => `#${n.id} (${n.at}) ${n.text}`).join('\n') || 'no notes'
}

// A self-made tool is agent/tools/<name>.mjs exporting { description, parameters, run(args) }.
async function loadCustomTool(ctx, file, loaded) {
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`)
  const toolName = file.split('/').pop().replace(/\.mjs$/, '')
  loaded.get(toolName)?.()
  loaded.set(toolName, ctx.tools.register(defineTool({
    name: toolName,
    description: mod.description,
    parameters: mod.parameters ?? {},
    output: text,
    execute: async (args) => String(await mod.run(args, { fetch, getJson })).slice(0, 4000),
  })))
}

const TZ = process.env.GROQBOT_TZ ?? 'America/New_York'
const nowLocal = () => new Date().toLocaleString('en-US', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' })

// Wall-clock parts of `date` in TZ, as a Date whose UTC fields hold local time.
const localParts = (date = new Date()) => new Date(date.toLocaleString('en-US', { timeZone: TZ }) + ' UTC')

function untilTime(spec) {
  const m = String(spec).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) throw new Error(`untilTime wants "6:04 PM" or "18:04", got "${spec}"`)
  let h = Number(m[1]) % 12
  if (!m[3]) h = Number(m[1])
  else if (m[3].toLowerCase() === 'pm') h += 12
  const now = localParts()
  const target = new Date(now)
  target.setUTCHours(h, Number(m[2] ?? 0), 0, 0)
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1)
  const mins = Math.round((target - now) / 60000)
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function daysUntil(dateStr) {
  const today = localParts(); today.setUTCHours(0, 0, 0, 0)
  return Math.round((new Date(`${dateStr}T00:00:00Z`) - today) / 86400000)
}

function calc(expression) {
  const fn = new Function('Math', 'untilTime', 'daysUntil', 'now', `"use strict"; return (${expression})`)
  const out = fn(Math, untilTime, daysUntil, nowLocal)
  return typeof out === 'number' ? String(Math.round(out * 1e6) / 1e6) : String(out)
}

function runShell({ command }, exec) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { cwd: ROOT, timeout: 60000, maxBuffer: 1 << 20, signal: exec.signal }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr ? `\n[stderr] ${stderr}` : ''}${err?.code ? `\n[exit ${err.code}]` : ''}`.trim()
      resolve(out.length > 3000 ? `${out.slice(0, 1500)}\n...\n${out.slice(-1500)}` : out || '(no output)')
    })
  })
}

// Compact front-end to the dsh Host schedule service (same persistence and
// delivery as schedule_create, a fraction of the schema tokens).
// Reminders are listed across all of this chat's sessions (chats rotate), so
// "what reminders do I have" still finds ones made in an older conversation.
async function remind(schedule, { action, text: body, when, id }, exec) {
  const sessionId = exec.agent?.session.id
  if (!sessionId) return 'no session'
  const mine = async () => (await schedule.catalog()).filter((r) => r.status === 'active' && chatSessions(sessionId).includes(r.sessionId))
  if (action === 'list') {
    const list = await mine()
    return list.map((r, i) => `${i + 1}. ${r.title} — next ${new Date(r.scheduledAt).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' })} [id ${r.id}]`).join('\n') || 'no reminders'
  }
  if (action === 'delete') {
    const list = await mine()
    const hit = list.find((r) => r.id === id) ?? list[Number(id) - 1]
      ?? list.find((r) => id && r.title.toLowerCase().includes(String(id).toLowerCase()))
    if (!hit) return `no reminder matching "${id}". Use action list.`
    await schedule.delete({ sessionId: hit.sessionId, id: hit.id }, exec.signal)
    return `deleted: ${hit.title}`
  }
  if (!body || !when) return 'add needs text and when'
  const { selector, summary } = parseWhen(when, TZ)
  await schedule.create(sessionId, { prompt: `Remind the user, briefly: ${body}`, title: `${body.slice(0, 80)} · ${summary}`.slice(0, 120), ...selector }, exec.signal)
  return `Set: "${body}" ${summary}.`
}

// The chat bridge records which sessions belong to one chat in chat-sessions.json.
function chatSessions(sessionId) {
  const map = JSON.parse(read(join(ROOT, 'data', 'chat-sessions.json'), '{}'))
  const all = { ...map._old, ...Object.fromEntries(Object.entries(map).filter(([k]) => k !== '_old').map(([c, s]) => [s, c])) }
  const chat = all[sessionId]
  return chat ? Object.keys(all).filter((s) => all[s] === chat) : [sessionId]
}

// Bot behaviour knobs the user can change by chatting; the bridge re-reads them every message.
const SETTINGS_FILE = join(ROOT, 'data', 'settings.json')
const SETTINGS = { idle_minutes: 'start a fresh chat after this many quiet minutes', max_steps: 'max model calls per answer (1-12)' }
function settings({ name: key, value }) {
  const cur = JSON.parse(read(SETTINGS_FILE, '{}'))
  if (!key) return Object.keys(SETTINGS).map((k) => `${k} = ${cur[k] ?? 'default'} (${SETTINGS[k]})`).join('\n')
  if (!SETTINGS[key]) return `unknown setting; options: ${Object.keys(SETTINGS).join(', ')}`
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1 || (key === 'max_steps' && n > 12)) return `bad value for ${key}`
  cur[key] = n
  writeFileSync(SETTINGS_FILE, JSON.stringify(cur, null, 1))
  return `${key} set to ${n}.`
}

export async function apply(ctx) {
  // Prompt comes from editable files, re-read every step, so the agent can rewrite itself.
  ctx.systemPrompt.variable('groqbot_prompt', () =>
    `${read(join(AGENT, 'prompt.md'))}\n${read(join(AGENT, 'me.md'))}\nNow: ${nowLocal()} (${TZ}).`.replaceAll('{{', '{ {'))

  const reg = (def) => ctx.tools.register(defineTool({ output: text, ...def }))
  reg({
    name: 'settings', description: 'View/change bot settings. No args = list. name: idle_minutes|max_steps, value: number.',
    parameters: { name: { type: 'string' }, value: { type: 'number' } }, execute: settings,
  })
  reg({
    name: 'calc',
    description: 'Exact math and time math. JS expression; Math.* available, plus untilTime("6:04 PM") -> "3h 12m", daysUntil("2026-12-25"), now().',
    parameters: { expression: { type: 'string', required: true } },
    execute: ({ expression }) => calc(expression),
  })
  reg({
    name: 'shell', description: `Run a bash command in ${ROOT} (60s limit). For files, installs, editing yourself.`,
    parameters: { command: { type: 'string', required: true } }, execute: runShell,
  })
  ctx.inject(['schedule'], (sctx) => {
    sctx.tools.register(defineTool({
      name: 'remind',
      description: 'Reminders. action add|list|delete. add: text + when in the user\'s own words ("in 20 min", "tomorrow 5pm", "every weekday at 7:30am", "every year on Mar 3"). delete: id = number from list, id, or words.',
      parameters: {
        action: { type: 'string', required: true }, text: { type: 'string' }, when: { type: 'string' }, id: { type: 'string' },
      },
      output: text,
      execute: (args, exec) => remind(sctx.schedule, args, exec).catch((e) => `error: ${e.message}`),
    }))
  })
  reg({
    name: 'weather', description: 'Current weather + daily forecast. Default location: user home.',
    parameters: { location: { type: 'string' }, days: { type: 'number', description: '1-5' } },
    execute: weather,
  })
  reg({
    name: 'web_search', description: 'Google search (Serper). For facts that change or that you do not know.',
    parameters: { query: { type: 'string', required: true } }, execute: webSearch,
  })
  reg({
    name: 'places', description: 'Find stores/places with hours, address, rating. Default near user home.',
    parameters: { query: { type: 'string', required: true }, near: { type: 'string' } }, execute: places,
  })
  reg({
    name: 'travel_time', description: 'Distance and rough travel time. Default start: user home.',
    parameters: { to: { type: 'string', required: true }, from: { type: 'string' }, mode: { type: 'string', description: 'car|walk|bike' } },
    execute: travelTime,
  })
  reg({
    name: 'notes', description: 'User notes. action add|list|delete; text = note or list filter.',
    parameters: { action: { type: 'string', required: true }, text: { type: 'string' }, id: { type: 'number' } },
    execute: notes,
  })

  mkdirSync(TOOLS_DIR, { recursive: true })
  const loaded = new Map()
  for (const f of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.mjs'))) {
    await loadCustomTool(ctx, join(TOOLS_DIR, f), loaded).catch((e) => ctx.logger?.('groqbot').warn?.(`tool ${f}: ${e.message}`))
  }
  reg({
    name: 'make_tool',
    description: 'Create or replace one of your own tools; usable from your next step. code = body of async run(args, {fetch, getJson}) returning a string. params = JSON like {"city":{"type":"string","required":true}}.',
    parameters: {
      name: { type: 'string', required: true, description: 'snake_case' },
      description: { type: 'string', required: true },
      params: { type: 'string', description: 'JSON object' },
      code: { type: 'string', required: true },
    },
    async execute({ name: toolName, description, params, code }) {
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(toolName)) return 'bad name: use snake_case'
      const file = join(TOOLS_DIR, `${toolName}.mjs`)
      const existed = existsSync(file)
      // Models often send a whole `async function run(...)` instead of a body; accept both.
      const body = /function\s+run\s*\(/.test(code) ? `${code}\nreturn run(args, { fetch, getJson })` : code
      writeFileSync(file, `export const description = ${JSON.stringify(description)}\n`
        + `export const parameters = ${params ? JSON.stringify(JSON.parse(params)) : '{}'}\n`
        + `export async function run(args, { fetch, getJson }) {\n${body}\n}\n`)
      await loadCustomTool(ctx, file, loaded)
      return `${existed ? 'replaced' : 'created'} tool ${toolName}; call it now.`
    },
  })
}
