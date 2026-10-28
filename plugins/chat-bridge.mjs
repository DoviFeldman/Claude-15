// Chat bridge: Telegram long-polling (when TELEGRAM_BOT_TOKEN is set) plus a
// localhost HTTP endpoint for testing. One dsh Session per chat, all on the
// groqbot preset. Turns the agent starts by itself (schedule reminders) are
// pushed back to the chat they belong to.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync, existsSync, unlinkSync, watch } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
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
        // Qwen occasionally leaks its reasoning; keep only what follows the last </think>.
        const t = ev.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').split('</think>').pop().trim()
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
        if (reply) deliver(chat, reply.startsWith('⏰') ? reply : `⏰ ${reply}`)
      }
    }
  })

  // Show the model only the packs this message needs: deny every other pack's
  // tools for this agent and swap in a prompt built from just those packs.
  const routed = new Map() // agent id -> disposer of the current restriction
  const lastRouted = new Map() // agent id -> previous message + packs, for follow-ups
  const ALWAYS_HIDDEN = ['working_directory']
  async function applyRoute(agent, textIn) {
    const g = globalThis.groqbot
    if (!g) return undefined
    const r = await route(textIn, lastRouted.get(agent.id))
    lastRouted.set(agent.id, { text: textIn.slice(0, 500), packs: r.packs })
    routed.get(agent.id)?.()
    // packs null = router had no answer: hide nothing, use the full prompt.
    const keep = new Set(['core', ...(r.packs ?? g.packOf.values())])
    const deny = [...ALWAYS_HIDDEN, ...[...g.packOf].filter(([, p]) => !keep.has(p)).map(([n]) => n)]
    const disposers = []
    try {
      disposers.push(agent.ctx.tools.restrict({ deny }))
    } catch (e) {
      // A name the agent cannot see (e.g. tool not loaded yet) — retry without it.
      const known = deny.filter((n) => !String(e.message).includes(`"${n}"`))
      if (known.length) disposers.push(agent.ctx.tools.restrict({ deny: known }))
    }
    disposers.push(agent.ctx.systemPrompt.variable('groqbot_prompt', () => g.composePrompt(r.packs ?? undefined)))
    routed.set(agent.id, () => disposers.forEach((d) => d()))
    return r
  }

  // ---- Model registry (data/models.json; loaded into dsh at startup) ----
  const MODELS_FILE = join(ROOT, 'data', 'models.json')
  const readModels = () => { try { return JSON.parse(readFileSync(MODELS_FILE, 'utf8')) } catch { return { default: '', roles: {}, models: {} } } }
  const writeModels = (reg) => writeFileSync(MODELS_FILE, JSON.stringify(reg, null, 1))
  async function useModel(agent, name) {
    const m = readModels().models[name]
    if (!m) throw new Error(`no model "${name}"`)
    await ctx.sessionController.selectModel({ sessionId: agent.id, provider: m.provider, model: m.model })
  }

  async function ask(chat, textIn) {
    const agent = await agentFor(chat)
    await agent.whenIdle()
    const routeInfo = await applyRoute(agent, textIn).catch((e) => ({ error: e.message }))
    // A role (e.g. roles.self = "grok") hands that kind of turn to another model, then switches back.
    const reg = readModels()
    const roleModel = (routeInfo?.packs ?? []).map((p) => reg.roles?.[p]).find((n) => n && reg.models[n])
    if (roleModel) await useModel(agent, roleModel).catch((e) => console.warn(`[chat-bridge] role model: ${e.message}`))
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
      if (roleModel) await useModel(agent, reg.default).catch(() => {})
    }
    const stats = usage.get(agent.id)
    const reply = lastText(agent.session, from)
    return {
      reply: stats?.capped ? `${reply ? `${reply}\n` : ''}(Stopped after ${maxSteps()} steps — try rephrasing or a simpler ask.)` : reply || '(no reply)',
      ms: Date.now() - t, stats: { ...stats, route: routeInfo, model: roleModel ?? reg.default },
    }
  }

  // ---- Claude Code mode (/claude) ----
  // The maintainer: Claude Code runs headless in the bot folder (it reads
  // CLAUDE.md), skips the router and Qwen's prompt, and may take its time.
  // Progress (tool use) is posted as it works; one run per chat at a time.
  const CLAUDE_FILE = join(ROOT, 'data', 'claude-sessions.json')
  const claudeState = (() => { try { return JSON.parse(readFileSync(CLAUDE_FILE, 'utf8')) } catch { return { mode: {}, session: {}, last: {} } } })()
  const saveClaude = () => writeFileSync(CLAUDE_FILE, JSON.stringify(claudeState, null, 1))
  const claudeRuns = new Map() // chat -> child process
  const CLAUDE_NOTE = 'You are talking to the owner through Telegram (/claude mode). Read CLAUDE.md before changing anything. Reply in short plain text. There is no time pressure.'
  const CLAUDE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite']
  const RESTART_FLAG = join(ROOT, 'data', 'restart-requested')

  function toolLine(use) {
    const i = use.input ?? {}
    const what = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? ''
    return `${use.name}${what ? `: ${String(what).replace(/\s+/g, ' ').slice(0, 90)}` : ''}`
  }

  function askClaude(chat, textIn) {
    if (claudeRuns.has(chat)) return Promise.resolve({ reply: 'Claude is still working on the last message. /stop cancels it.' })
    const sid = claudeState.session[chat]
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--append-system-prompt', CLAUDE_NOTE, ...(sid ? ['--resume', sid] : []), '--allowedTools', ...CLAUDE_TOOLS]
    const child = spawn('claude', args, { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    claudeRuns.set(chat, child)
    child.stdin.end(textIn)
    const t = Date.now()
    let buf = '', err = '', result, pending = [], lastSent = 0
    const flush = (force) => {
      if (!pending.length || (!force && Date.now() - lastSent < 15000)) return
      deliver(chat, `🔧 ${pending.join('\n🔧 ')}`.slice(0, 1500))
      pending = []; lastSent = Date.now()
    }
    const ticker = setInterval(() => { flush(false); if (chat.startsWith('tg:') && token) tg('sendChatAction', { chat_id: chat.slice(3), action: 'typing' }).catch(() => {}) }, 5000)
    const killer = setTimeout(() => child.kill('SIGTERM'), 30 * 60000)
    child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.session_id && ev.session_id !== claudeState.session[chat]) { claudeState.session[chat] = ev.session_id; saveClaude() }
        if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') pending.push(toolLine(b))
        if (ev.type === 'result') result = ev
      }
    })
    child.stderr.on('data', (d) => { err += d })
    return new Promise((resolve) => {
      child.on('close', (code) => {
        clearInterval(ticker); clearTimeout(killer); claudeRuns.delete(chat)
        flush(true)
        claudeState.last[chat] = { ms: Date.now() - t, turns: result?.num_turns, cost: result?.total_cost_usd, code }
        saveClaude()
        let reply = result?.result?.trim() || (code === null ? 'Stopped.' : `Claude exited (${code}). ${err.trim().slice(-500)}`)
        if (/not logged in|please run \/login|invalid api key|authentication/i.test(reply + err)) reply = 'Claude Code is not signed in yet (run claude auth login on the server).'
        appendFileSync(LOG, `${new Date().toISOString()} chat=${chat} ${JSON.stringify({ claude: true, ...claudeState.last[chat] })}\n`)
        if (existsSync(RESTART_FLAG)) {
          unlinkSync(RESTART_FLAG)
          reply += '\n(Restarting the bot to apply the changes, back in about 20 s.)'
          setTimeout(() => process.exit(0), 3000)
        }
        resolve({ reply, ms: Date.now() - t, stats: { claude: claudeState.last[chat] } })
      })
    })
  }

  // ---- OAuth sign-in (xAI device code) ----
  // dsh's authorization registry runs pi-ai's xAI flow and stores the token in
  // dsh's credential store, where the xai route reads (and refreshes) it. The
  // user approves in their own browser; the bot only relays the link and code.
  function startLogin(chat, auth, key) {
    auth.begin({
      key,
      method: 'oauth',
      interaction: {
        notify: (n) => deliver(chat, [n.message, n.code ? `Code: ${n.code}` : '', n.url ?? ''].filter(Boolean).join('\n')),
        prompt: () => Promise.reject(new Error('this sign-in cannot answer questions from chat')),
      },
    }).then((outcome) => {
      if (outcome.status !== 'authorized') return deliver(chat, 'Sign-in cancelled.')
      const reg = readModels()
      reg.models.grok = { provider: 'xai', model: process.env.GROK_MODEL ?? 'grok-4.3', auth: 'oauth', maxTokens: 4000 }
      reg.roles = { ...reg.roles, self: 'grok' }
      writeModels(reg)
      deliver(chat, 'Signed in to Grok. Edits to the bot now go to Grok; /model grok to chat with it, /model qwen to switch back. Restarting to load it (about 20 s)...')
      setTimeout(() => process.exit(0), 2000)
    }).catch((e) => deliver(chat, `Sign-in failed: ${e.message}`))
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
    model: '/model = list, /model name = switch, /model add name provider model-id',
    key: '/key NAME value = store an API key (your message is deleted)',
    restart: 'restart the bot to load new models or keys',
    login: '/login grok = sign in with your SuperGrok / X Premium account',
    claude: 'talk to Claude Code (the maintainer); /claude message sends one message',
    qwen: 'back to Qwen from /claude mode',
    stop: 'cancel a running Claude job',
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
      if (claudeState.mode[chat]) return askClaude(chat, textIn)
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
        if (claudeState.mode[chat]) {
          delete claudeState.session[chat]; saveClaude()
          return { reply: 'Fresh Claude conversation started.' }
        }
        forget(chat)
        return { reply: 'Fresh conversation started.' }
      case 'claude':
        claudeState.mode[chat] = true; saveClaude()
        return args ? askClaude(chat, args) : { reply: 'Claude Code mode: messages now go to Claude (it edits and tests the bot, and takes its time). /qwen to go back, /new for a fresh Claude conversation, /stop to cancel.' }
      case 'qwen':
        delete claudeState.mode[chat]; saveClaude()
        return { reply: 'Back to Qwen.' }
      case 'stop': {
        const run = claudeRuns.get(chat)
        if (!run) return { reply: 'Nothing running.' }
        run.kill('SIGTERM')
        return { reply: 'Stopping Claude...' }
      }
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
        if (claudeState.mode[chat]) {
          const l = claudeState.last[chat]
          return { reply: l ? `Last Claude run: ${Math.round(l.ms / 1000)} s, ${l.turns ?? '?'} turns${l.cost ? `, $${l.cost.toFixed(2)} (subscription usage)` : ''}.` : 'No Claude runs yet.' }
        }
        const u = usage.get(chats[chat])
        return { reply: u ? `Last answer: ${u.steps} model calls, ${u.input} tokens in, ${u.output} out, tools: ${u.tools.join(', ') || 'none'}. Free tier allows ~7000 tokens in per minute.` : 'No answers yet in this conversation.' }
      }
      case 'commands':
        return { reply: Object.entries(custom).map(([k, v]) => `/${k} — ${v.desc}`).join('\n') || 'No custom commands yet. Make one: /cmd name prompt with {args}' }
      case 'cmd': {
        const [, cname, template] = args.match(/^([a-z0-9_]+)\s*([\s\S]*)$/i) ?? []
        if (!cname) return { reply: BUILTIN.cmd }
        if (BUILTIN[cname.toLowerCase()] || ['new', 'start'].includes(cname.toLowerCase())) return { reply: `/${cname} is built in.` }
        const file = join(CMD_DIR, `${cname.toLowerCase()}.md`)
        if (!template) {
          if (!existsSync(file)) return { reply: `No /${cname}.` }
          unlinkSync(file); syncTelegramMenu()
          return { reply: `Deleted /${cname}.` }
        }
        writeFileSync(file, `# ${template.slice(0, 60)}\n${template}\n`); syncTelegramMenu()
        return { reply: `Made /${cname.toLowerCase()}. Try it.` }
      }
      case 'model': {
        const reg = readModels()
        const [sub, ...rest] = args.split(/\s+/).filter(Boolean)
        if (!sub) {
          const roles = Object.entries(reg.roles ?? {}).map(([r, n]) => `${r} -> ${n}`).join(', ')
          return { reply: Object.entries(reg.models).map(([n, m]) => `${n === reg.default ? '* ' : '  '}${n} (${m.provider} ${m.model})`).join('\n')
            + `${roles ? `\nroles: ${roles}` : ''}\nSwitch: /model name. Add: /model add name provider model-id. Role: /model role self name.` }
        }
        if (sub === 'add') {
          const [name, provider, model] = rest
          if (!name || !provider || !model) return { reply: 'Usage: /model add name provider model-id (providers: groq, xai, vercel, openai, openrouter)' }
          reg.models[name] = { provider, model }
          writeModels(reg)
          return { reply: `Added ${name}. Make sure its API key is set (/key), then /restart, then /model ${name}.` }
        }
        if (sub === 'role') {
          const [role, name] = rest
          if (!role) return { reply: 'Usage: /model role self name (or /model role self off)' }
          reg.roles ??= {}
          if (!name || name === 'off') delete reg.roles[role]
          else if (!reg.models[name]) return { reply: `No model ${name}.` }
          else reg.roles[role] = name
          writeModels(reg)
          return { reply: name && name !== 'off' ? `${role} turns now use ${name}.` : `${role} turns use the default model.` }
        }
        if (!reg.models[sub]) return { reply: `No model ${sub}. /model lists them.` }
        try {
          await useModel(await agentFor(chat), sub)
        } catch (e) {
          return { reply: `Could not switch: ${e.message}. If you just added it, /restart first.` }
        }
        reg.default = sub
        writeModels(reg)
        return { reply: `Now using ${sub}.` }
      }
      case 'key': {
        const [, name, value] = args.match(/^([A-Z][A-Z0-9_]+)\s+(\S+)$/) ?? []
        if (!name) return { reply: 'Usage: /key NAME value, e.g. /key XAI_API_KEY xai-...' }
        const file = join(ROOT, 'data', 'keys.env')
        let lines = []
        try { lines = readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${name}=`)) } catch {}
        writeFileSync(file, [...lines, `${name}='${value.replace(/'/g, '')}'`].join('\n') + '\n', { mode: 0o600 })
        process.env[name] = value
        return { reply: `Saved ${name}. /restart to be sure everything picks it up.` }
      }
      case 'login':
      case 'logout': {
        const provider = { grok: 'xai', xai: 'xai' }[(args || 'grok').toLowerCase()]
        if (!provider) return { reply: 'Usage: /login grok' }
        const auth = ctx.get('authorization')
        const flow = auth?.list().find((f) => String(f.key).endsWith(`/${provider}`))
        if (!flow) return { reply: 'Sign-in is not available in this build.' }
        if (cmd === 'logout') {
          await ctx.get('credentials')?.deleteRecord?.(flow.key)
          const reg = readModels()
          delete reg.models.grok
          for (const [r, n] of Object.entries(reg.roles ?? {})) if (n === 'grok') delete reg.roles[r]
          if (reg.default === 'grok') reg.default = 'qwen'
          writeModels(reg)
          return { reply: 'Signed out of Grok. /restart to finish.' }
        }
        if (flow.inFlight) return { reply: 'A sign-in is already waiting for you; use the link I sent.' }
        startLogin(chat, auth, flow.key)
        return { reply: 'Starting xAI sign-in (needs SuperGrok or X Premium)...' }
      }
      case 'restart':
        // In Docker (--restart unless-stopped) the container comes straight back up.
        setTimeout(() => process.exit(0), 1500)
        return { reply: 'Restarting, back in about 20 seconds.' }
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
            if (/^\/key\b/i.test(m.text)) tg('deleteMessage', { chat_id: id, message_id: m.message_id }).catch(() => {})
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
    // Commands made by the model (make_command) or by hand show up in the menu without a restart.
    let menuTimer
    const watcher = watch(CMD_DIR, () => { clearTimeout(menuTimer); menuTimer = setTimeout(syncTelegramMenu, 500) })
    ctx.effect(() => () => watcher.close())
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
