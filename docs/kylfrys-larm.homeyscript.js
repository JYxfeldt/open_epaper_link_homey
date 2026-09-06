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

// Same numbers as the display board, so the panel and the notification can never
// disagree about what counts as wrong.
const LIMITS = {
  fridge: { warn: 10, crit: 12, low: 1 },
  // The freezer low alarm is NOT settled. -25 was proposed, but measurement
  // showed it sits inside normal operation: Frys halv runs below -25 for 55-64%
  // of the time and reaches -28.8, and Frys stående dips to -26.4 on every
  // compressor cycle, roughly every 45 minutes. Set a value here once agreed;
  // null means the low check is skipped for freezers.
  freezer: { warn: -12, crit: -6, low: null },
};

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
let prev = { active: {}, count: 0, last: 0 };
try {
  const raw = await global.get(STATE_KEY);
  if (raw) prev = typeof raw === 'string' ? JSON.parse(raw) : raw;
} catch (err) { /* start clean rather than fail the alarm */ }
if (!prev || typeof prev !== 'object') prev = { active: {}, count: 0, last: 0 };
if (!prev.active) prev.active = {};

// ---- evaluate every device ----------------------------------------------
const now = Date.now();
const active = {};
const rows = [];
const stale = [];

for (const [id, name, kind] of COLD) {
  const o = capObj(id);
  if (!o || o.value === null || o.value === undefined) continue;
  const t = o.value;

  const age = o.lastUpdated ? now - new Date(o.lastUpdated).getTime() : 0;
  if (age > STALE_MS) stale.push({ name, hours: Math.round(age / 3600e3) });

  const level = levelOf(kind, t, prev.active[name] !== undefined);
  if (!level) continue;
  active[name] = level;
  rows.push({ name, level, t });
}

if (ALARM_ON_STALE) {
  for (const s of stale) {
    if (active[s.name]) continue;
    active[s.name] = 'stale';
    rows.push({ name: s.name, level: 'stale', t: null });
  }
}

// ---- decide whether to speak --------------------------------------------
// A device that got worse - newly in alarm, or escalated - breaks through the
// pause. A device recovering or dropping out does not: getting better is not
// worth waking anyone for, and letting it reset the timer would mean a device
// oscillating between two levels alarmed forever.
let worse = false;
for (const [name, level] of Object.entries(active)) {
  const before = prev.active[name];
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

const state = { active, count, last: send ? now : (prev.last || 0) };
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

console.log(`kyl/frys: ${rows.length} i larm${critical ? ' KRITISKT' : ''}, larm ${send ? 'skickas' : 'pausat'} (nr ${count}), ${stale.length} tysta givare`);

return send ? text : '';
