// Chat bridge: Telegram long-polling (when TELEGRAM_BOT_TOKEN is set) plus a
// localhost HTTP endpoint for testing. One dsh Session per chat, all on the
// groqbot preset. Turns the agent starts by itself (schedule reminders) are
// pushed back to the chat they belong to.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { route } from './router.mjs'

export const name = 'chat-bridge'
export const inject = ['sessionController', 'agents', 'sessions']

const ROOT = process.env.GROQBOT_HOME ?? join(process.env.HOME, 'GroqAgent')
const MAP_FILE = join(ROOT, 'data', 'chat-sessions.json')
const LOG = join(ROOT, 'data', 'turns.log')
const PRESET = process.env.GROQBOT_PRESET ?? 'groqbot'

function friendlyError(msg) {
  const wait = msg.match(/try again in ([\dhms.]*[hms])/)?.[1]?.replace(/\.\d+s/, 's')
  if (/tokens per day/.test(msg)) return `Out of Groq's free daily tokens (200k/day). Try again in ${wait ?? 'a while'}.`
  if (/rate limit/i.test(msg)) return `Groq is rate-limiting me. Try again in ${wait ?? 'a minute'}.`
  return `error: ${msg.slice(0, 300)}`
}

export function apply(ctx) {
  const chats = (() => { try { return JSON.parse(readFileSync(MAP_FILE, 'utf8')) } catch { return {} } })()
  const bySession = new Map([
    ...Object.entries(chats._old ?? {}),
    ...Object.entries(chats).filter(([k]) => k !== '_old').map(([chat, sid]) => [sid, chat]),
  ])
  const busy = new Set()
  const outbox = [] // local-test deliveries of agent-initiated turns
  const turnStart = new Map()
  const usage = new Map()

  async function resolve(sid) {
    const found = await ctx.sessionController.resolveAgent(sid)
    if ('error' in found) throw found.error
    return found.agent
  }

  // Groq free tier resends the whole chat every step, so keep sessions short:
  // start fresh after idle time or once a turn got heavy. Old sessions stay in
  // bySession so their reminders still reach the chat.
  // data/settings.json (written by the bot's `settings` tool) wins over env defaults.
  const setting = (key, env, dflt) => {
    try { const v = JSON.parse(readFileSync(join(ROOT, 'data', 'settings.json'), 'utf8'))[key]; if (v) return v } catch {}
    return Number(process.env[env] ?? dflt)
  }
  const idleMs = () => setting('idle_minutes', 'GROQBOT_IDLE_MINUTES', 30) * 60000
  const maxSteps = () => setting('max_steps', 'GROQBOT_MAX_STEPS', 6)
  const MAX_INPUT = Number(process.env.GROQBOT_MAX_TURN_INPUT ?? 4500)
  const lastUse = new Map()

  async function agentFor(chat) {
    const sid = chats[chat]
    // Unknown last use (e.g. after a restart) counts as stale: long, messy
    // contexts are where a 27B model starts inventing answers.
    const stale = !lastUse.has(sid) || Date.now() - lastUse.get(sid) > idleMs()
    const heavy = (usage.get(sid)?.input ?? 0) > MAX_INPUT
    if (sid && !stale && !heavy) {
      try { return await resolve(sid) } catch { /* recreate below */ }
    }
    const { sessionId } = await ctx.sessionController.create({ cwd: ROOT, agentPreset: PRESET })
    chats[chat] = sessionId
    bySession.set(sessionId, chat)
    lastUse.set(sessionId, Date.now())
    const old = chats._old ?? {}
    for (const [s, c] of bySession) if (Object.values(chats).indexOf(s) < 0) old[s] = c
    chats._old = old
    save()
    return resolve(sessionId)
  }

  function lastText(session, from) {
    let out = ''
    for (let seq = from; seq < session.seq; seq++) {
      const ev = session.eventAt(seq)
      if (ev?.type === 'assistant/message') {
        const t = ev.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (t) out = t
      }
      if (ev?.type === 'turn/end' && ev.data.reason?.kind === 'error') out ||= friendlyError(ev.data.reason.error?.message ?? '')
    }
    return out.trim()
  }

  // Per-turn stats: steps, input/output tokens, wall time.
  ctx.on('session/event', (session, event) => {
    if (!bySession.has(session.id)) return
    if (event.type === 'turn/start') {
      turnStart.set(session.id, { t: Date.now(), seq: event.seq })
      usage.set(session.id, { steps: 0, input: 0, output: 0, tools: [] })
    }
    const u = usage.get(session.id)
    // Step cap: on the free tier every extra step can cost a minute of rate limit.
    if (u && event.type === 'step/start' && event.data.step > maxSteps()) {
      u.capped = true
      ctx.agents.get(session.id)?.cancel({ kind: 'user' }, { keepInbox: true })
    }
    if (u && event.type === 'assistant/message') {
      u.steps++
      u.input += event.data.usage?.inputTokens ?? 0
      u.output += event.data.usage?.outputTokens ?? 0
    }
    if (u && event.type === 'tool/call') u.tools.push(event.data.name)
    if (event.type === 'turn/end') {
      const start = turnStart.get(session.id)
      const chat = bySession.get(session.id)
      const stats = { ...u, ms: start ? Date.now() - start.t : undefined }
      appendFileSync(LOG, `${new Date().toISOString()} chat=${chat} ${JSON.stringify(stats)}\n`)
      // Not a turn we are awaiting: the agent woke itself (reminder). Push it.
      if (!busy.has(session.id) && start) {
        const reply = lastText(session, start.seq)
        if (reply) deliver(chat, `⏰ ${reply}`)
      }
    }
  })

  // Show the model only the packs this message needs: deny every other pack's
  // tools for this agent and swap in a prompt built from just those packs.
  const routed = new Map() // agent id -> disposer of the current restriction
  const ALWAYS_HIDDEN = ['working_directory']
  async function applyRoute(agent, textIn) {
    const g = globalThis.groqbot
    if (!g) return undefined
    const r = await route(textIn)
    routed.get(agent.id)?.()
    const keep = new Set(['core', ...r.packs])
    const deny = [...ALWAYS_HIDDEN, ...[...g.packOf].filter(([, p]) => !keep.has(p)).map(([n]) => n)]
    const disposers = []
    try {
      disposers.push(agent.ctx.tools.restrict({ deny }))
    } catch (e) {
      // A name the agent cannot see (e.g. tool not loaded yet) — retry without it.
      const known = deny.filter((n) => !String(e.message).includes(`"${n}"`))
      if (known.length) disposers.push(agent.ctx.tools.restrict({ deny: known }))
    }
    disposers.push(agent.ctx.systemPrompt.variable('groqbot_prompt', () => g.composePrompt(r.packs)))
    routed.set(agent.id, () => disposers.forEach((d) => d()))
    return r
  }

  async function ask(chat, textIn) {
    const agent = await agentFor(chat)
    await agent.whenIdle()
    const routeInfo = await applyRoute(agent, textIn).catch((e) => ({ error: e.message }))
    const from = agent.session.seq
    busy.add(agent.id)
    const t = Date.now()
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: textIn }], source: { kind: 'user' } }))
      await new Promise((r) => setTimeout(r, 0))
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
    } finally {
      busy.delete(agent.id)
      lastUse.set(agent.id, Date.now())
    }
    const stats = usage.get(agent.id)
    const reply = lastText(agent.session, from)
    return {
      reply: stats?.capped ? `${reply ? `${reply}\n` : ''}(Stopped after ${maxSteps()} steps — try rephrasing or a simpler ask.)` : reply || '(no reply)',
      ms: Date.now() - t, stats: { ...stats, route: routeInfo },
    }
  }

  // ---- Slash commands (shared by Telegram and the local endpoint) ----
  // Custom commands are agent/commands/<name>.md: first line "# description",
  // the rest a prompt template where {args} is whatever follows the command.
  const CMD_DIR = join(ROOT, 'agent', 'commands')
  mkdirSync(CMD_DIR, { recursive: true })
  const prevSession = {}
  const lastQuestion = {}
  const save = () => writeFileSync(MAP_FILE, JSON.stringify(chats, null, 1))
  // Menu order = this order, custom commands after; /new is kept last.
  const BUILTIN = {
    help: 'list commands',
    continue: 'go back to the conversation before the last /new',
    retry: 'ask your last question again in a fresh conversation',
    usage: 'tokens and time of the last answer',
    commands: 'list your custom commands',
    cmd: '/cmd name prompt with {args} = make a command; /cmd name = delete it',
  }
  const NEW_CMD = ['new', 'start a fresh conversation']
  const menu = () => [...Object.entries(BUILTIN), ...Object.entries(customCommands()).map(([k, v]) => [k, v.desc]), NEW_CMD]
  const customCommands = () => Object.fromEntries(readdirSync(CMD_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const body = readFileSync(join(CMD_DIR, f), 'utf8')
    const desc = body.match(/^#\s*(.+)/)?.[1] ?? 'custom command'
    return [f.slice(0, -3), { desc, template: body.replace(/^#.*\n?/, '').trim() }]
  }))

  function forget(chat) {
    if (chats[chat]) prevSession[chat] = chats[chat]
    delete chats[chat]
    save()
  }

  async function handle(chat, textIn) {
    const m = textIn.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?\s*([\s\S]*)$/i)
    if (!m) {
      lastQuestion[chat] = textIn
      return ask(chat, textIn)
    }
    const [, cmd, args] = [m[0], m[1].toLowerCase(), m[2].trim()]
    const custom = customCommands()
    switch (cmd) {
      case 'start':
      case 'help':
        return { reply: menu().map(([k, v]) => `/${k} — ${v}`).join('\n') }
      case 'new':
        forget(chat)
        return { reply: 'Fresh conversation started.' }
      case 'continue': {
        const back = prevSession[chat]
        if (!back) return { reply: 'Nothing to go back to.' }
        prevSession[chat] = chats[chat]
        chats[chat] = back
        lastUse.set(back, Date.now())
        usage.delete(back) // let it resume even if its last turn was heavy
        save()
        return { reply: 'Back to the previous conversation.' }
      }
      case 'retry':
        if (!lastQuestion[chat]) return { reply: 'No question to retry.' }
        forget(chat)
        return ask(chat, lastQuestion[chat])
      case 'usage': {
        const u = usage.get(chats[chat])
        return { reply: u ? `Last answer: ${u.steps} model calls, ${u.input} tokens in, ${u.output} out, tools: ${u.tools.join(', ') || 'none'}. Free tier allows ~7000 tokens in per minute.` : 'No answers yet in this conversation.' }
      }
      case 'commands':
        return { reply: Object.entries(custom).map(([k, v]) => `/${k} — ${v.desc}`).join('\n') || 'No custom commands yet. Make one: /cmd name prompt with {args}' }
      case 'cmd': {
        const [, cname, template] = args.match(/^([a-z0-9_]+)\s*([\s\S]*)$/i) ?? []
        if (!cname) return { reply: BUILTIN.cmd }
        if (BUILTIN[cname.toLowerCase()] || cname.toLowerCase() === 'new') return { reply: `/${cname} is built in.` }
        const file = join(CMD_DIR, `${cname.toLowerCase()}.md`)
        if (!template) {
          if (!existsSync(file)) return { reply: `No /${cname}.` }
          unlinkSync(file); syncTelegramMenu()
          return { reply: `Deleted /${cname}.` }
        }
        writeFileSync(file, `# ${template.slice(0, 60)}\n${template}\n`); syncTelegramMenu()
        return { reply: `Made /${cname.toLowerCase()}. Try it.` }
      }
      default: {
        const c = custom[cmd]
        if (!c) return { reply: `Unknown command /${cmd}. Try /help.` }
        const prompt = c.template.includes('{args}') ? c.template.replaceAll('{args}', args) : `${c.template}\n${args}`.trim()
        lastQuestion[chat] = prompt
        return ask(chat, prompt)
      }
    }
  }

  // ---- Telegram ----
  // GROQBOT_NO_TELEGRAM=1 lets a second copy (e.g. testing on the Mac) run without stealing the bot's updates.
  const token = process.env.GROQBOT_NO_TELEGRAM ? '' : process.env.TELEGRAM_BOT_TOKEN
  // Show built-in + custom commands in Telegram's "/" menu.
  function syncTelegramMenu() {
    if (!token) return
    tg('setMyCommands', { commands: menu().slice(-100).map(([command, description]) => ({ command, description: description.slice(0, 256) })) }).catch(() => {})
  }
  const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const tg = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json())

  async function deliver(chat, msg) {
    msg = msg.replace(/\*\*(.+?)\*\*/g, '$1') // Telegram plain text would show the asterisks
    if (chat.startsWith('tg:') && token) {
      for (let i = 0; i < msg.length; i += 4000) await tg('sendMessage', { chat_id: chat.slice(3), text: msg.slice(i, i + 4000) })
    } else {
      outbox.push({ chat, msg, at: new Date().toISOString() })
    }
  }

  if (token) {
    let stopped = false
    ctx.effect(() => () => { stopped = true })
    ;(async () => {
      let offset = 0
      while (!stopped) {
        try {
          const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] })
          for (const u of r.result ?? []) {
            offset = u.update_id + 1
            const m = u.message
            if (!m?.text) continue
            const id = String(m.chat.id)
            if (allowed.length && !allowed.includes(id)) {
              await tg('sendMessage', { chat_id: id, text: `Not authorized. Your chat id is ${id}.` })
              continue
            }
            tg('sendChatAction', { chat_id: id, action: 'typing' })
            handle(`tg:${id}`, m.text)
              .then(({ reply }) => deliver(`tg:${id}`, reply))
              .catch((e) => deliver(`tg:${id}`, `Error: ${e.message}`))
          }
        } catch (e) {
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    })()
    syncTelegramMenu()
    console.log('[chat-bridge] Telegram polling started')
  }

  // ---- Local test endpoint (127.0.0.1 only) ----
  const port = Number(process.env.GROQBOT_LOCAL_PORT ?? 3999)
  const server = createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    try {
      if (req.method === 'GET' && req.url === '/outbox') return send(200, outbox.splice(0))
      if (req.method !== 'POST' || req.url !== '/chat') return send(404, { error: 'POST /chat or GET /outbox' })
      let body = ''
      for await (const c of req) body += c
      const { chat = 'local', text } = JSON.parse(body)
      send(200, await handle(chat, text))
    } catch (e) {
      send(500, { error: e.message })
    }
  })
  server.listen(port, '127.0.0.1', () => console.log(`[chat-bridge] local test endpoint http://127.0.0.1:${port}/chat`))
  ctx.effect(() => () => server.close())
}
