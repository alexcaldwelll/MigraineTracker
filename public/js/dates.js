// Calendar dates and times in the person's own time zone. Never use
// toISOString for these: it reports the UTC date, which is a different day for
// part of every day.

export function localDate(d = new Date()){
  const month = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function shiftDate(dateStr, days){
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate()+days);
  return localDate(d);
}

export function nowTime(){ return new Date().toTimeString().slice(0,5); }

// "Wed, Nov 4"
export function shortDate(dateStr){
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
}

export function dayTitle(dateStr, today = localDate()){
  if(dateStr===today) return 'Today';
  if(dateStr===shiftDate(today, -1)) return 'Yesterday';
  if(dateStr===shiftDate(today, 1)) return 'Tomorrow';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {weekday:'long'});
}
