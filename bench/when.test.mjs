// node bench/when.test.mjs — parser checks pinned to Fri 2026-10-23 15:10 New York.
import { parseWhen } from '../plugins/when.mjs'
const now = new Date('2026-10-23T19:10:00Z'), tz = 'America/New_York'
const cases = {
  'in 10 minutes': { after_seconds: 600 },
  'in 1 hour 30 min': { after_seconds: 5400 },
  'every day at 8am': { daily: { time: '08:00:00', time_zone: tz } },
  'everyday at 7:30 pm': { daily: { time: '19:30:00', time_zone: tz } },
  'every morning': { daily: { time: '08:00:00', time_zone: tz } },
  'every weekday at 7:30am': { weekly: { time: '07:30:00', time_zone: tz, weekdays: [1, 2, 3, 4, 5] } },
  'every monday and thursday at 6pm': { weekly: { time: '18:00:00', time_zone: tz, weekdays: [1, 4] } },
  'every 2 hours': { every_seconds: 7200 },
  'every month on the 1st at 9am': { cron: { expression: '0 9 1 * *', time_zone: tz } },
  'every year on March 3 at 9am': { cron: { expression: '0 9 3 3 *', time_zone: tz } },
  'tomorrow at 5pm': { at: { date: '2026-10-24', time: '17:00:00', time_zone: tz } },
  'at 2pm': { at: { date: '2026-10-24', time: '14:00:00', time_zone: tz } },
  'at 9pm': { at: { date: '2026-10-23', time: '21:00:00', time_zone: tz } },
  'on friday at 3pm': { at: { date: '2026-10-30', time: '15:00:00', time_zone: tz } },
  'next monday at noon': { at: { date: '2026-10-26', time: '12:00:00', time_zone: tz } },
  'dec 24 at 10am': { at: { date: '2026-12-24', time: '10:00:00', time_zone: tz } },
  'tonight': { at: { date: '2026-10-23', time: '21:00:00', time_zone: tz } },
}
let fail = 0
for (const [q, want] of Object.entries(cases)) {
  let got, sum
  try { ({ selector: got, summary: sum } = parseWhen(q, tz, now)) } catch (e) { got = e.message }
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${q.padEnd(34)} ${ok ? sum : JSON.stringify(got)}`)
}
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0)
