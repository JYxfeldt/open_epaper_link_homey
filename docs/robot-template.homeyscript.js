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
const CHARGER_STATE = {
  0: 'Offline', 1: 'Ingen bil', 2: 'Pausad', 3: 'Laddar',
  4: 'Klar', 5: 'FEL', 6: 'Bil ansluten',
  offline: 'Offline', standby: 'Ingen bil', paused: 'Pausad', charging: 'Laddar',
  completed: 'Klar', error: 'FEL', car_connected: 'Bil ansluten',
};

function charger() {
  const raw = cap(CHARGER, 'charger_status');
  const key = String(raw == null ? '' : raw).toLowerCase().replace(/\s+/g, '_');
  const status = CHARGER_STATE[key] || CHARGER_STATE[raw] || fit(raw || 'Okänd', MAX_BIG);
  const kwh = cap(CHARGER, 'meter_power.lastCharge');
  const charging = cap(CHARGER, 'evcharger_charging') === true || status === 'Laddar';
  const amps = cap(CHARGER, 'target_charger_current');
  // Above 99 kWh the decimal is dropped rather than the unit being truncated.
  const kwhText = kwh === null ? null
    : (kwh >= 100 ? String(Math.round(kwh)) : String(Math.round(kwh * 10) / 10).replace('.', ','));

  let det;
  if (charging && amps !== null) det = `laddar med ${amps} A`;
  else if (kwhText !== null) det = `senast ${kwhText} kWh`;
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

console.log('robotskärm: ' + cols.map((c) => c.name + '=' + c.hero + '/' + c.status + (c.red ? ' ROD' : '')).join('  '));
return JSON.stringify(t);
