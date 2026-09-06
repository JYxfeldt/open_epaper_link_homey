// Cold-storage alarm for all seven fridges and freezers, replacing seven
// near-identical per-device Flows.
//
// Returns the alarm text, or an empty string when nothing should be sent. The
// Flow gates on that: empty means stay quiet.
//
// Why one script rather than seven Flows: the pause is global (one alarm at a
// time, not one per device) and the alarm has to name every device currently out
// of bounds, not just the one that happened to report. Both of those need a
// single place that can see all seven at once.

const COLD = [
  ['3753a84f-08e3-4bc3-a425-cfce430f2a8f', 'Kylskåp',       'fridge'],
  ['c0087978-e847-45ba-a6d9-b9f6923ff986', 'Kyl halv',      'fridge'],
  ['1a422bee-b496-416a-890e-29d47c4be9cf', 'Ölkyl',         'fridge'],
  ['df4dcf2d-d142-4d58-9f94-d171547328f6', 'Frys',          'freezer'],
  ['0e28a3d8-c82c-4385-9fc3-3ed0626f79ab', 'Frys halv',     'freezer'],
  ['592b5b19-eaba-4399-b415-1dd3242f6d7e', 'Frys stående',  'freezer'],
  ['b8612fd5-1ab1-4704-8b89-d26c1e44162a', 'Frys liggande', 'freezer'],
];

// The six thresholds live in Logic variables so they can be tuned in the app
// without editing code. One pair of numbers per category, shared by every unit
// in it - not per device. The values here are only a fallback for the case where
// a variable has been renamed or deleted.
//
// "Frys larm låg" is -31 rather than the -25 first proposed, because -25 turned
// out to sit inside normal operation: Frys halv runs below it for 55-64% of the
// time and reaches -28.8, and Frys stående dips to -26.4 on every compressor
// cycle. -31 gives zero hits for all four over both 6 and 24 hours. The cost of
// one shared number is that for Frys liggande, which floors at -23.3, -31 sits
// nearly 8 degrees below normal and will in practice never fire.
const FALLBACK = {
  fridge: { warn: 10, crit: 12, low: 1 },
  freezer: { warn: -12, crit: -6, low: -31 },
};
const VAR_NAMES = {
  fridge: { warn: 'Kyl larm hög', crit: 'Kyl larm kritisk', low: 'Kyl larm låg' },
  freezer: { warn: 'Frys larm hög', crit: 'Frys larm kritisk', low: 'Frys larm låg' },
};

const LIMITS = JSON.parse(JSON.stringify(FALLBACK));
try {
  const vars = Object.values(await Homey.logic.getVariables());
  const byName = new Map(vars.map((v) => [v.name, v]));
  for (const kind of Object.keys(VAR_NAMES)) {
    for (const key of Object.keys(VAR_NAMES[kind])) {
      const v = byName.get(VAR_NAMES[kind][key]);
      if (v && typeof v.value === 'number') LIMITS[kind][key] = v.value;
    }
  }
} catch (err) { /* fall back to the numbers above rather than stop alarming */ }

// A temperature has to stay outside the limit for this long before it alarms, so
// that opening a door does not wake anyone. It applies to every threshold -
// warning and critical, high and low - because the reasoning is the same for all
// of them: a brief excursion is not a fault.
const DELAY_MS = 5 * 60e3;

// Once a device is in alarm it stays in alarm until it comes back a full degree
// past the threshold. Without this a sensor sitting on the line would flip in
// and out, and since a change in the alarm set breaks through the pause, the
// flapping would defeat the pause entirely.
const HYST = 1;

// Escalation between repeats of the SAME situation: first repeat after a minute,
// then 5, 15, 30, and 30 from then on. A genuinely new problem ignores this.
const STEPS_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];

// A sensor that has not changed value in this long is almost certainly dead
// rather than stable. Frys temperatur has been frozen on -24.4 for 15 days.
// Reported in the text when an alarm goes out anyway; set ALARM_ON_STALE to true
// to make a dead sensor raise an alarm on its own.
const STALE_MS = 12 * 3600e3;
const ALARM_ON_STALE = false;

const STATE_KEY = 'kylfrys_larm_state';

const devices = await Homey.devices.getDevices();
const capObj = (id) => {
  const d = devices[id];
  if (!d || !d.capabilitiesObj || !d.capabilitiesObj.measure_temperature) return null;
  return d.capabilitiesObj.measure_temperature;
};

// Swedish decimal comma, and "minus" spelled out because this same string is
// read aloud by the speakers as well as pushed to the phone.
const say = (t) => `${t < 0 ? 'minus ' : ''}${String(Math.round(Math.abs(t) * 10) / 10).replace('.', ',')} grader`;

const RANK = { krit: 0, lag: 1, varn: 2, stale: 3 };

function levelOf(kind, t, wasActive) {
  const L = LIMITS[kind];
  // Widen the band by HYST while already in alarm - that is the hysteresis.
  const d = wasActive ? HYST : 0;
  if (t > L.crit - d) return 'krit';
  if (t > L.warn - d) return 'varn';
  if (L.low !== null && t < L.low + d) return 'lag';
  return null;
}

// ---- read previous state -------------------------------------------------
let prev = { active: {}, eligible: {}, count: 0, last: 0 };
try {
  const raw = await global.get(STATE_KEY);
  if (raw) prev = typeof raw === 'string' ? JSON.parse(raw) : raw;
} catch (err) { /* start clean rather than fail the alarm */ }
if (!prev || typeof prev !== 'object') prev = {};
if (!prev.active) prev.active = {};
if (!prev.eligible) prev.eligible = {};

// ---- evaluate every device ----------------------------------------------
const now = Date.now();
const active = {};    // in the band right now, with when it entered
const eligible = {};  // in the band, and has been for longer than DELAY_MS
const rows = [];
const stale = [];
const waiting = [];

for (const [id, name, kind] of COLD) {
  const o = capObj(id);
  if (!o || o.value === null || o.value === undefined) continue;
  const t = o.value;

  const age = o.lastUpdated ? now - new Date(o.lastUpdated).getTime() : 0;
  if (age > STALE_MS) stale.push({ name, hours: Math.round(age / 3600e3) });

  const was = prev.active[name] && typeof prev.active[name] === 'object' ? prev.active[name] : undefined;
  const inBandBefore = was !== undefined && !was.out;
  const level = levelOf(kind, t, inBandBefore);

  if (!level) {
    // Back inside the limits. Do NOT forget it straight away: a unit that dips
    // back in for a moment and goes straight out again must not restart its
    // five minutes, or one oscillating around the threshold - which is exactly
    // what a compressor cycle does - would never accumulate five continuous
    // minutes and would never alarm however bad it got. Keep the entry, marked
    // with when it left, and discard it once it has stayed in for a full delay.
    if (inBandBefore) active[name] = { ...was, out: now };
    else if (was && was.out && now - was.out < DELAY_MS) active[name] = was;
    continue;
  }

  // `since` is the moment this unit entered the band, carried over unchanged
  // while it stays there and across brief dips back in. Fluctuation within the
  // band, including moving between warning and critical, must not restart the
  // clock either.
  const since = was && was.since ? was.since : now;
  active[name] = { level, since };

  if (now - since >= DELAY_MS) {
    eligible[name] = level;
    rows.push({ name, level, t });
  } else {
    waiting.push(`${name} ${Math.round((DELAY_MS - (now - since)) / 1000)}s kvar`);
  }
}

if (ALARM_ON_STALE) {
  for (const s of stale) {
    if (eligible[s.name]) continue;
    eligible[s.name] = 'stale';
    active[s.name] = { level: 'stale', since: active[s.name] ? active[s.name].since : now };
    rows.push({ name: s.name, level: 'stale', t: null });
  }
}

// ---- decide whether to speak --------------------------------------------
// A unit that got worse - newly alarming, or escalated - breaks through the
// pause. A unit recovering or dropping out does not: getting better is not worth
// waking anyone for, and letting it reset the timer would mean a unit
// oscillating between two levels alarmed forever.
//
// The comparison is over the ELIGIBLE set, not everything in the band. If a new
// unit could break through the moment it crossed the line, the five minute delay
// would do nothing whenever something else was already alarming.
let worse = false;
for (const [name, level] of Object.entries(eligible)) {
  const before = prev.eligible[name];
  if (before === undefined || RANK[level] < RANK[before]) { worse = true; break; }
}

const anyActive = rows.length > 0;
let send = false;
let count = prev.count || 0;

if (!anyActive) {
  // Everything back to normal - forget the episode so the next one starts at
  // the top of the escalation again.
  count = 0;
} else if (worse) {
  send = true;
  count = 1;
} else {
  const wait = STEPS_MS[Math.min(Math.max(count, 1) - 1, STEPS_MS.length - 1)];
  if (now - (prev.last || 0) >= wait) { send = true; count += 1; }
}

const state = { active, eligible, count, last: send ? now : (prev.last || 0) };
try { await global.set(STATE_KEY, JSON.stringify(state)); } catch (err) { /* not fatal */ }

// The Flow gates on these rather than on the returned string, because a
// condition card cannot read another card's return value - only the global
// store is shared between them.
try {
  await global.set('kylfrys_send', send);
  await global.set('kylfrys_kritisk', rows.some((r) => r.level === 'krit'));
} catch (err) { /* the alarm still goes out; only the gate would misread */ }

// ---- build the text ------------------------------------------------------
rows.sort((a, b) => RANK[a.level] - RANK[b.level] || a.name.localeCompare(b.name, 'sv'));

const parts = rows.map((r) => {
  if (r.level === 'stale') return `${r.name} (ingen mätning)`;
  if (r.level === 'lag') return `${r.name} ${say(r.t)} (för kallt)`;
  return `${r.name} ${say(r.t)}`;
});
// "a, b och c" reads better aloud than a bare comma list.
const list = parts.length <= 1 ? (parts[0] || '')
  : `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}`;

const critical = rows.some((r) => r.level === 'krit');
let text = `${critical ? 'KRITISKT. ' : ''}Kyl och frys: ${list}`;
// Mention a dead sensor alongside a real alarm even when it is not alarming in
// its own right - it means that unit is unprotected.
if (!ALARM_ON_STALE && stale.length) {
  text += `. Ingen mätning från ${stale.map((s) => `${s.name} (${s.hours} h)`).join(', ')}`;
}

console.log(`kyl/frys: ${rows.length} i larm${critical ? ' KRITISKT' : ''}, larm ${send ? 'skickas' : 'pausat'} (nr ${count})`
  + `${waiting.length ? `, ${waiting.length} vantar pa fordrojningen: ${waiting.join('; ')}` : ''}`
  + `${stale.length ? `, ${stale.length} tysta givare` : ''}`);

return send ? text : '';
