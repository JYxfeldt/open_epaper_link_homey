// Builds the OpenEPaperLink JSON template for the robot board on Display 08.
//
// Layout E, chosen after rendering five candidates on the real panel: three
// columns, each with the name on top, one key figure large, and the state in
// smaller text underneath where a long word can wrap without hurting.
//
// Geometry is measured, not estimated. On this panel (M3 2.9", 384x168 logical)
// bahnschrift30 runs about 14.8 px per character and bahnschrift20 about 9.2, so
// a 124 px column holds roughly 8 and 13 characters respectively. fit() enforces
// that, because a string that overruns is drawn straight through the divider.

const HUBERT = '99145c41-e510-4b2a-89dc-856a5540a29e';
const OLOF = '9ebb82a9-7267-422e-ab4c-356c3586c301';
const CHARGER = 'cd7433d7-d8ca-4f68-aa8d-81d4cae72e76';
const VAC_DATE_VAR = 'Senaste dammsugning övervåning';

const BLACK = 1, RED = 2;
const BIG = 'bahnschrift30', MID = 'bahnschrift20', SMALL = 't0_14b_tf';

// Three full-width rows rather than three columns. The columns were introduced
// to solve a width problem, but they solved it by shrinking the state name -
// and the state is the one thing worth reading. Stacked two lines each, the
// state gets 269 px, which holds "Parkerad i basen" comfortably.
// The detail line was set in bahnschrift20 two pixels below its own status and
// three above the next one, so it read as belonging to neither. In the small
// font it fits with a 3 px gap inside the block and 10 px between blocks, which
// is what makes the pairing legible.
const NAME_X = 6, VALUE_X = 110;
const ROW_Y = [34, 78, 122];
const MAX_NAME = 10, MAX_BIG = 18, MAX_MID = 28;

// HomeyScript runs in UTC; clock times must be formatted in Homey's timezone.
let TZ = 'Europe/Stockholm';
try {
  const info = await Homey.system.getInfo();
  if (info && info.timezone) TZ = info.timezone;
} catch (err) { /* keep the default */ }
const hhmm = (d) => d.toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const ymd = (d) => d.toLocaleDateString('sv-SE', { timeZone: TZ });

const devices = await Homey.devices.getDevices();
const capObj = (id, c) => {
  const d = devices[id];
  if (!d || !d.capabilitiesObj || !d.capabilitiesObj[c]) return null;
  return d.capabilitiesObj[c];
};
const cap = (id, c) => {
  const o = capObj(id, c);
  return o && o.value !== undefined ? o.value : null;
};
const fit = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : t.slice(0, n);
};

// ---- Hubert (Husqvarna Automower) ---------------------------------------
// state and activity together say more than either alone: state PAUSED with
// activity NOT_APPLICABLE is a paused mower, state IN_OPERATION with activity
// MOWING is a mowing one.
const MOWER_BY_ACTIVITY = {
  MOWING: 'Klipper',
  GOING_HOME: 'På väg hem',
  CHARGING: 'Laddar i basen',
  LEAVING: 'Lämnar basen',
  PARKED_IN_CS: 'Parkerad i basen',
  STOPPED_IN_GARDEN: 'Stannat i trädgården',
};
const MOWER_BY_STATE = {
  PAUSED: 'Pausad',
  IN_OPERATION: 'Kör',
  WAIT_UPDATING: 'Uppdaterar',
  WAIT_POWER_UP: 'Startar',
  RESTRICTED: 'Vilar',
  OFF: 'Avstängd',
  STOPPED: 'Stoppad',
  ERROR: 'FEL',
  FATAL_ERROR: 'FEL',
  ERROR_AT_POWER_UP: 'FEL',
};

// The mower reports its next start as free English text - "Tomorrow 5:50", not a
// time - so it has to be translated rather than concatenated. Truncating it blind
// produced "nästa Tomorr" on the panel.
function nextStart(raw) {
  if (!raw || raw === '---') return 'ingen start planerad';
  const m = String(raw).match(/^(Today|Tomorrow)\s+(\d{1,2}):(\d{2})$/i);
  if (m) {
    const when = m[1].toLowerCase() === 'today' ? 'idag' : 'imorgon';
    return `startar ${when} ${m[2].padStart(2, '0')}:${m[3]}`;
  }
  return fit(`nästa ${raw}`, MAX_MID);
}

function hubert() {
  const state = cap(HUBERT, 'mower_state_capability');
  const activity = cap(HUBERT, 'mower_activity_capability');
  const batt = cap(HUBERT, 'mower_battery_capability');
  const err = cap(HUBERT, 'mower_errorcode_capability');

  const hasError = ['ERROR', 'FATAL_ERROR', 'ERROR_AT_POWER_UP'].includes(state)
    || (err && err !== '---');
  const lowBattery = typeof batt === 'number' && batt < 20;

  let status = MOWER_BY_ACTIVITY[activity] || MOWER_BY_STATE[state] || 'Okänd';
  if (hasError) status = 'FEL';

  // The battery only earns a place when it says something: while mowing it is
  // being spent, and when it is low it is a problem. Parked at 100 % it is noise.
  let det;
  if (hasError && err && err !== '---') det = fit(`felkod ${err}`, MAX_MID);
  else if (lowBattery) det = `lågt batteri, ${batt} %`;
  else if (activity === 'MOWING') det = `${batt} % batteri`;
  else det = nextStart(cap(HUBERT, 'mower_nextstart_capability'));

  return { name: 'Hubert', status, det, red: hasError || lowBattery };
}

// ---- Olof (Dreame) -------------------------------------------------------
// The driver exposes no battery capability, so the key figure is when he last
// ran, taken from the logic variable that "Starta Olof" already maintains.
const VAC_STATE = {
  0: 'Stoppad', 1: 'Städar', 2: 'Pausad', 3: 'FEL',
  64: 'Söker laddaren', 65: 'Laddar i dockan', 66: 'Dockad',
};
const VAC_ALARMS = [
  ['alarm_stuck', 'Fastnat'],
  ['alarm_lost', 'Vilse'],
  ['alarm_bin_full', 'Full påse'],
  ['alarm_bin_missing', 'Påse borta'],
  ['alarm_tank_empty', 'Tank tom'],
  ['alarm_tank_missing', 'Tank borta'],
  ['alarm_tank_open', 'Tanklucka'],
  ['alarm_cleaning_pad_missing', 'Dyna borta'],
];

// Name matching is exact on purpose but tolerant of stray whitespace: several
// devices here carry a trailing space in their name, which has already cost us
// one failed lookup.
async function lastVacuum() {
  try {
    const vars = await Homey.logic.getVariables();
    const v = Object.values(vars).find((x) => String(x.name).trim() === VAC_DATE_VAR);
    if (!v || !v.value) return 'ingen uppgift om städning';
    const today = ymd(new Date());
    const yesterday = ymd(new Date(Date.now() - 86400000));
    if (v.value === today) return 'städat idag';
    if (v.value === yesterday) return 'städat igår';
    const parts = String(v.value).split('-');
    if (parts.length === 3) return `städat ${Number(parts[2])}/${Number(parts[1])}`;
    return fit(`städat ${v.value}`, MAX_MID);
  } catch (err) {
    return 'ingen uppgift om städning';
  }
}

async function olof() {
  const state = String(cap(OLOF, 'operational_state'));
  const alarm = VAC_ALARMS.find(([c]) => cap(OLOF, c) === true);
  const isError = state === '3' || Boolean(alarm);
  return {
    name: 'Olof',
    status: alarm ? alarm[1] : (VAC_STATE[state] || 'Okänd'),
    det: await lastVacuum(),
    red: isError,
  };
}

// ---- The car charger (Easee) --------------------------------------------
// kWh rather than kW: the board updates rarely, so an instantaneous power
// reading says little while accumulated energy stays meaningful for hours.
//
// Whether a car is connected comes from evcharger_charging_state, NOT from
// charger_status. This row used to read charger_status alone and map "Standby"
// to "Ingen bil", which is wrong: Standby means the charger is idle, and it is
// idle both when nothing is plugged in and when a car is connected but waiting -
// finished, or scheduled for later. That is how the board came to say "Ingen
// bil" with the car sitting in the charger. Only the charging state
// distinguishes plugged_out from the four plugged_in variants.
//
// Measured with the car plugged in and waiting: charger_status "Paused",
// evcharger_charging_state "plugged_in_paused". So charger_status still refines
// what kind of connected this is, but it may not decide whether a cable is in.
const PLUG_STATE = {
  plugged_out: { status: 'Ingen bil', connected: false },
  plugged_in: { status: 'Ansluten', connected: true },
  plugged_in_paused: { status: 'Ansluten, väntar', connected: true },
  plugged_in_charging: { status: 'Laddar', connected: true, charging: true },
  plugged_in_discharging: { status: 'Urladdar', connected: true, charging: true },
};
// These describe the charger itself and outrank anything about the cable.
const CHARGER_FAULT = { offline: 'Offline', error: 'FEL', 5: 'FEL', 0: 'Offline' };
// Fallback only, for the case where evcharger_charging_state is missing. It
// deliberately does not claim "Ingen bil" for standby, because it cannot know.
const CHARGER_STATE = {
  0: 'Offline', 1: 'Laddare ledig', 2: 'Pausad', 3: 'Laddar',
  4: 'Fulladdad', 5: 'FEL', 6: 'Ansluten',
  offline: 'Offline', standby: 'Laddare ledig', paused: 'Pausad',
  charging: 'Laddar', completed: 'Fulladdad', error: 'FEL', car_connected: 'Ansluten',
};

// The Easee app can stop delivering while Homey still reports the device as
// available, with no warning and the app "running". It did exactly that for four
// days: charger_status froze on "Standby" and the board confidently drew "Ingen
// bil" with the car plugged in.
//
// Detecting that is not as simple as looking at how old the state fields are.
// Homey's lastUpdated moves only when a value CHANGES - measured directly, two
// reads six minutes apart with charger_status unchanged and its stamp unchanged
// - so a state field sitting still is normal and proves nothing. measure_voltage
// is the exception: it tracks mains voltage and moved 230 -> 232 within those
// same six minutes. If it has not moved for hours, nothing is being delivered.
//
// Six hours, not one: the reading is an integer, so it could plausibly hold one
// value for a while, and the failure this guards against lasted four days.
const CHARGER_STALE_MS = 6 * 3600 * 1000;
function chargerDataStale() {
  const o = capObj(CHARGER, 'measure_voltage');
  if (!o || !o.lastUpdated) return false; // cannot tell; do not cry wolf
  return Date.now() - new Date(o.lastUpdated).getTime() > CHARGER_STALE_MS;
}

function charger() {
  // Say "unknown" rather than assert a four-day-old state as current fact.
  // Deliberately not red: a quiet integration is not a robot fault, and the LED
  // reads the same flags.
  if (chargerDataStale()) {
    return { name: 'Laddare', status: 'Okänd', det: 'laddardata gammal', red: false };
  }
  const rawStatus = cap(CHARGER, 'charger_status');
  const statusKey = String(rawStatus == null ? '' : rawStatus).toLowerCase().replace(/\s+/g, '_');
  const rawPlug = cap(CHARGER, 'evcharger_charging_state');
  const plugKey = String(rawPlug == null ? '' : rawPlug).toLowerCase();
  const plug = PLUG_STATE[plugKey] || null;

  let status;
  let connected = false;
  let charging = false;
  const fault = CHARGER_FAULT[statusKey] || CHARGER_FAULT[rawStatus] || null;

  if (fault) {
    // Offline or a fault says nothing trustworthy about the cable, so say that
    // and nothing more.
    status = fault;
  } else if (plug) {
    connected = plug.connected;
    charging = plug.charging === true;
    status = plug.status;
    // A connected car that is done is worth distinguishing from one still
    // waiting to start.
    if (connected && !charging && (statusKey === 'completed' || rawStatus === 4)) status = 'Fulladdad';
  } else {
    // No charging state at all - fall back, but do not invent "Ingen bil".
    status = CHARGER_STATE[statusKey] || CHARGER_STATE[rawStatus] || fit(rawStatus || 'Okänd', MAX_BIG);
    charging = statusKey === 'charging' || rawStatus === 3;
  }
  // evcharger_charging is a separate boolean and can lag; treat it as corroboration.
  if (cap(CHARGER, 'evcharger_charging') === true) charging = true;

  // meter_power.lastCharge is the running total of the CURRENT session while one
  // is open, and the previous session's total once it closes. It resets to 0
  // when a new session starts, so "senast 0 kWh" would be a lie about a car that
  // has just been plugged in.
  const kwh = cap(CHARGER, 'meter_power.lastCharge');
  // Above 99 kWh the decimal is dropped rather than the unit being truncated.
  const kwhText = kwh === null ? null
    : (kwh >= 100 ? String(Math.round(kwh)) : String(Math.round(kwh * 10) / 10).replace('.', ','));
  const amps = cap(CHARGER, 'target_charger_current');

  let det;
  if (charging && kwh !== null && kwh > 0) det = `${kwhText} kWh hittills`;
  else if (charging && amps !== null) det = `laddar med ${amps} A`;
  else if (kwh !== null && kwh > 0) det = `senast ${kwhText} kWh`;
  else if (connected) det = 'inget laddat än';
  else det = '';

  return { name: 'Laddare', status, det, red: status === 'FEL' || status === 'Offline' };
}

// ---- draw ----------------------------------------------------------------
const cols = [hubert(), await olof(), charger()];

const t = [
  { text: [10, 2, 'ROBOTAR', BIG, BLACK] },
  { text: [330, 16, hhmm(new Date()), SMALL, BLACK] },
  { line: [5, 30, 379, 30, BLACK] },
];

cols.forEach((c, i) => {
  const y = ROW_Y[i];
  const colour = c.red ? RED : BLACK;
  t.push({ text: [NAME_X, y + 4, fit(c.name, MAX_NAME), MID, colour] });
  t.push({ text: [VALUE_X, y, fit(c.status, MAX_BIG), BIG, colour] });
  // t0_14b_tf takes a baseline, not a top: ink runs y-11..y-1.
  if (c.det) t.push({ text: [VALUE_X, y + 35, fit(c.det, MAX_MID), SMALL, colour] });
});

// The LED must never contradict the screen. On Display 11 the lamp and the board
// were computed by two separate scripts, and when the panel showed a stale
// render the two disagreed. Here the screen publishes what it drew and the LED
// condition only reads that, so they cannot drift apart.
const faults = cols.filter((c) => c.red).map((c) => c.name);
await global.set('robot_fault', faults.join(','));

// c.hero was a leftover from the key-figure layout that this board replaced, so
// the log line used to read "Laddare=undefined/...".
console.log('robotskärm: ' + cols.map((c) => `${c.name}=${c.status}${c.det ? ` (${c.det})` : ''}${c.red ? ' ROD' : ''}`).join('  '));
return JSON.stringify(t);
