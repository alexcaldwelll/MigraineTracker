// Headache rules with no DOM, so Today, the patterns code and the server can
// share them. An entry is { id, type, time, ...data }, as listAll returns it,
// plus a `date` ("YYYY-MM-DD") where the caller needs one. A day is
// { date, entries }.
import { localDate, shiftDate } from './dates.js';

const HOUR = 3600000;
const STALE_AFTER = 24 * HOUR;

export const isHeadacheEntry = entry => Boolean(entry) && entry.type === 'headache';

const hhmm = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

// When the headache began. Old entries have only a date and a time.
function startOf(entry){
  if(entry.start_at) return new Date(entry.start_at);
  return new Date(`${entry.date}T${entry.time || '00:00'}:00`);
}

// The open headache, or null. Old entries have no `open` field, so never match.
// The result carries the date of the day it was found on.
export function findOpenHeadache(days){
  let found = null;
  for(const day of days){
    for(const entry of day.entries){
      if(!isHeadacheEntry(entry) || entry.open !== true) continue;
      const candidate = { ...entry, date: day.date };
      if(!found || startOf(candidate) > startOf(found)) found = candidate;
    }
  }
  return found;
}

// The entry to save, or null when one is already open.
export function startHeadache(days, now){
  if(findOpenHeadache(days)) return null;
  return { type: 'headache', open: true, date: localDate(now), time: hhmm(now), start_at: now.toISOString() };
}

export function endHeadache(entry, endAt){
  const end = new Date(endAt);
  const hours = Math.max(0, (end - startOf(entry)) / HOUR);
  return { ...entry, open: false, duration: Math.round(hours * 10) / 10, end_at: end.toISOString() };
}

export function isStale(entry, now){
  if(entry.open !== true) return false;
  return new Date(now) - startOf(entry) >= STALE_AFTER;
}

// Every local calendar date the headache touches. An open one, and an old one
// with no end time, count only their start date.
export function headacheDates(entry){
  const start = localDate(startOf(entry));
  if(entry.open === true || !entry.end_at) return [entry.start_at ? start : entry.date];
  const last = localDate(new Date(entry.end_at));
  const dates = [start];
  for(let d = start; d < last; ) dates.push(d = shiftDate(d, 1));
  return dates;
}

// start_at, and end_at when the person gave a duration in hours, for a closed
// headache entered by hand.
export function closedHeadacheTimes(date, time, durationHours){
  const start = new Date(`${date}T${time}:00`);
  const times = { start_at: start.toISOString() };
  const hours = Number(durationHours);
  if(durationHours !== null && durationHours !== '' && Number.isFinite(hours) && hours > 0){
    times.end_at = new Date(start.getTime() + hours * HOUR).toISOString();
  }
  return times;
}
