// Day, date and slot labels for live-event summaries and notice text, in the
// server's time zone (TZ), like every other library time.

const meridiem = (d: Date) => (d.getHours() < 12 ? 'AM' : 'PM')

function clock(d: Date): string {
  const hour = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
  return d.getMinutes() === 0 ? String(hour) : `${hour}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "Thu, Oct 22" */
export function dayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Spelled out, not asked of Intl: a newer ICU writes September as "Sept" in some
// locales, and the student app's Fines page says "Sep".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "20 Nov 2026": the way the student app's Fines page writes a date (the year is shown, a fine can be months old). */
export function dateLabel(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** "2–3 PM", "11 AM–12 PM", "2:30–3:30 PM" */
export function slotLabel(start: Date, end: Date): string {
  return meridiem(start) === meridiem(end)
    ? `${clock(start)}–${clock(end)} ${meridiem(end)}`
    : `${clock(start)} ${meridiem(start)}–${clock(end)} ${meridiem(end)}`
}
