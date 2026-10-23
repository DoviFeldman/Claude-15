// Plain-English schedule -> dsh schedule selector, so the model just passes the
// user's words ("every weekday at 7:30am") and never builds cron or ISO itself.
// Returns { selector, summary } or throws with a hint the model can relay.

const DAY_NAMES = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const PARTS = { morning: '8:00', noon: '12:00', afternoon: '15:00', evening: '18:00', night: '21:00', tonight: '21:00', midnight: '0:00' }
const UNIT_SECONDS = { s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800 }
const ORD = /(\d{1,2})(?:st|nd|rd|th)?/
const TIME = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (w) => DAY_NAMES[w.slice(0, 3)]
const ISO_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function parseTime(text) {
  for (const [word, t] of Object.entries(PARTS)) if (new RegExp(`\\b${word}\\b`).test(text)) return t.split(':').map(Number)
  // Only treat a bare number as a time if it has am/pm, a colon, or "at".
  const m = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|\b(\d{1,2})(?::(\d{2}))\s*(am|pm|a\.m\.|p\.m\.)?|\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)/)
  if (!m) return null
  let h = Number(m[1] ?? m[4] ?? m[7])
  const min = Number(m[2] ?? m[5] ?? 0)
  const ap = (m[3] ?? m[6] ?? m[8])?.[0]
  if (ap === 'p' && h < 12) h += 12
  if (ap === 'a' && h === 12) h = 0
  if (h > 23 || min > 59) throw new Error(`bad time in "${text}"`)
  return [h, min]
}

const hhmmss = ([h, m]) => `${pad(h)}:${pad(m)}:00`
const say = ([h, m]) => `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`

// Today's date in tz as {y, mo, d, dow(ISO)}.
function today(tz, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]))
  return { y: +p.year, mo: +p.month, d: +p.day, dow: dayKey(p.weekday.toLowerCase()), h: +p.hour, mi: +p.minute }
}
const addDays = ({ y, mo, d }, n) => {
  const t = new Date(Date.UTC(y, mo - 1, d + n))
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
}
const ymd = ({ y, mo, d }) => `${y}-${pad(mo)}-${pad(d)}`
const later = (time, t) => time[0] > t.h || (time[0] === t.h && time[1] > t.mi)

export function parseWhen(input, tz, now = new Date()) {
  const text = ` ${input.toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim()} `
  const t = today(tz, now)

  // Raw cron passthrough: "cron 0 9 * * 1"
  const cron = text.match(/cron:?\s+((?:\S+\s+){4}\S+)/)
  if (cron) return { selector: { cron: { expression: cron[1].trim(), time_zone: tz } }, summary: `cron ${cron[1].trim()}` }

  // "in 10 minutes", "in 1 hour 30 min", "in 2 days"
  if (/^\s*in\s+\d/.test(text)) {
    let secs = 0
    for (const [, n, u] of text.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|[smhdw])\b/g)) {
      secs += Number(n) * UNIT_SECONDS[u.replace(/s$/, '')] || Number(n) * (UNIT_SECONDS[u] ?? 0)
    }
    if (!secs) throw new Error(`could not read a delay in "${input}"`)
    return { selector: { after_seconds: Math.round(secs) }, summary: `once, in ${input.trim().replace(/^in\s+/i, '')}` }
  }

  const recurring = /\b(every|everyday|each|daily|weekdays?|weekends?|nightly|mornings|evenings|monthly|yearly|annually)\b/.test(text)
  const time = parseTime(text)

  if (recurring) {
    // "every 2 hours", "every 30 minutes"
    const iv = text.match(/every\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/)
    if (iv && !time) {
      const secs = Number(iv[1]) * UNIT_SECONDS[iv[2].replace(/s$/, '')]
      if (secs < 60) throw new Error('shortest repeat is every 1 minute')
      return { selector: { every_seconds: secs }, summary: `every ${iv[1]} ${iv[2]}` }
    }
    if (/every\s+(hour|minute)\b/.test(text) && !time) {
      const secs = /hour/.test(text) ? 3600 : 60
      return { selector: { every_seconds: secs }, summary: `every ${secs === 3600 ? 'hour' : 'minute'}` }
    }
    const at = time ?? [9, 0]
    // "every month on the 1st", "monthly on the 15th"
    if (/\b(month|monthly)\b/.test(text)) {
      const dom = text.match(new RegExp(`(?:on\\s+)?(?:the\\s+)?${ORD.source}\\b(?!\\s*(?:am|pm|:))`))?.[1] ?? '1'
      return { selector: { cron: { expression: `${at[1]} ${at[0]} ${Number(dom)} * *`, time_zone: tz } }, summary: `monthly on day ${dom} at ${say(at)}` }
    }
    // "every year on march 3", "yearly on dec 24"
    if (/\b(year|yearly|annually)\b/.test(text)) {
      const md = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/)
      if (!md) throw new Error('say which date, e.g. "every year on March 3 at 9am"')
      return { selector: { cron: { expression: `${at[1]} ${at[0]} ${Number(md[2])} ${MONTHS[md[1]]} *`, time_zone: tz } }, summary: `yearly on ${md[1]} ${md[2]} at ${say(at)}` }
    }
    let days = null
    if (/\bweekdays?\b/.test(text)) days = [1, 2, 3, 4, 5]
    else if (/\bweekends?\b/.test(text)) days = [6, 7]
    else {
      const named = [...text.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g)].map((m) => DAY_NAMES[m[1]])
      if (named.length) days = [...new Set(named)].sort()
    }
    if (days && days.length < 7) {
      return { selector: { weekly: { time: hhmmss(at), time_zone: tz, weekdays: days } }, summary: `every ${days.map((d) => ISO_NAMES[d]).join('/')} at ${say(at)}` }
    }
    return { selector: { daily: { time: hhmmss(at), time_zone: tz } }, summary: `every day at ${say(at)}` }
  }

  // One-shot at a date/time.
  if (!time) throw new Error(`no time found in "${input}". Use e.g. "tomorrow at 5pm", "in 20 minutes", "every day at 8am"`)
  let date
  if (/\btomorrow\b/.test(text)) date = addDays(t, 1)
  else if (/\btoday\b|\btonight\b/.test(text)) date = t
  else {
    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
    const md = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\s*(?:am|pm|:))/)
    const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
    const wd = text.match(/\b(?:on\s+|next\s+|this\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/)
    if (iso) date = { y: +iso[1], mo: +iso[2], d: +iso[3] }
    else if (md || slash) {
      const mo = md ? MONTHS[md[1]] : +slash[1]
      const d = md ? +md[2] : +slash[2]
      let y = slash?.[3] ? (+slash[3] < 100 ? 2000 + +slash[3] : +slash[3]) : t.y
      if (!slash?.[3] && (mo < t.mo || (mo === t.mo && d < t.d))) y++
      date = { y, mo, d }
    } else if (wd) {
      let n = (DAY_NAMES[wd[1]] - t.dow + 7) % 7
      if (n === 0 && (/\bnext\b/.test(text) || !later(time, t))) n = 7
      date = addDays(t, n)
    } else {
      date = later(time, t) ? t : addDays(t, 1) // "at 5pm" = next 5pm
    }
  }
  return {
    selector: { at: { date: ymd(date), time: hhmmss(time), time_zone: tz } },
    summary: `once on ${ymd(date)} at ${say(time)}`,
  }
}
