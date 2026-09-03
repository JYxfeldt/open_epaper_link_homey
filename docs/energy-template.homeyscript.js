// Builds the JSON template for the energy and water board on Display 12.
// 400x300, TLSR BWR 4.2", rotatebuffer=0, so this one is authored upright.
//
// Cost comes from "Elmätare Totalpris" rather than "Elmätare Tibberpris":
// Totalpris includes grid fee and tax and is what actually leaves the account.
// The two differ by roughly 70 kr a day, so the choice matters.
//
// Peak power is not sampled here. Power-by-the-Hour already tracks
// measure_watt_max.day/.year and sees every meter reading, which a Flow polling
// on an interval could not. The time of the peak is the capability's
// lastUpdated: a maximum is only written when the record is beaten.

const ELEC = '88610442-531c-422b-a7b7-1d8ad63d96e7'; // Elmätare Totalpris
const PULSE = '1140733b-f2da-4558-bc55-7358cd59dfd0'; // Tibber Pulse, per phase
const WATER = 'af9aa272-06b2-41ce-9850-5e6ec060cc74'; // Quandify, note trailing space in its name
const WATER_PBTH = '1e1808ab-66ed-496a-99d0-db6b86704a81'; // for yesterday

const BLACK = 1, RED = 2;
const BIG = 'bahnschrift30', MID = 'bahnschrift20', SMALL = 't0_14b_tf';

let TZ = 'Europe/Stockholm';
try {
  const info = await Homey.system.getInfo();
  if (info && info.timezone) TZ = info.timezone;
} catch (err) { /* keep the default */ }
const hhmm = (d) => d.toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const devices = await Homey.devices.getDevices();
const capObj = (id, c) => {
  const d = devices[id];
  return (d && d.capabilitiesObj && d.capabilitiesObj[c]) || null;
};
const cap = (id, c) => {
  const o = capObj(id, c);
  return o && o.value !== undefined && o.value !== null ? o.value : null;
};
// Swedish decimal comma, and no decimals once a number is big enough not to need them.
const num = (v, dec = 1) => (v === null ? '-' : String(Math.round(v * 10 ** dec) / 10 ** dec).replace('.', ','));
const kw = (w) => (w === null ? '-' : `${num(w / 1000, 1)} kW`);

// ---- electricity ----
const kwhToday = cap(ELEC, 'meter_kwh_this_day');
const kwhYest = cap(ELEC, 'meter_kwh_last_day');
const costToday = cap(ELEC, 'meter_money_this_day');
const costYest = cap(ELEC, 'meter_money_last_day');

const peakDay = capObj(ELEC, 'measure_watt_max.day');
const peakYear = cap(ELEC, 'measure_watt_max.year');
let peakTime = '';
if (peakDay && peakDay.lastUpdated) {
  const t = new Date(peakDay.lastUpdated);
  if (!Number.isNaN(t.getTime())) peakTime = `kl ${hhmm(t)}`;
}

// ---- highest hourly mean this month ----
// kWh in one hour is the same number as the average kW over that hour, so the
// largest meter_kwh_last_hour of the month is the monthly peak hourly demand -
// the figure a Swedish effektavgift is based on, when one applies.
// Measured, not assumed: Insights buckets its answers by window length. For one
// day "thisMonth" returned 24 hourly points, but "last31Days" returned only 124
// points for 31 days - six-hour averages, which would understate an hourly peak
// badly. So Insights is used once to seed the month, and after that the running
// maximum is kept exactly, comparing meter_kwh_last_hour on every hourly run.
//
// kWh in one hour is the same number as the average kW across that hour, which
// is the quantity a Swedish effektavgift is based on where one applies.
const monthKey = new Date().toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 7);

async function seedFromInsights() {
  const logId = `homey:device:${ELEC}:meter_kwh_last_hour`;
  try {
    const e = await Homey.insights.getLogEntries({ id: logId, uri: `homey:log:${logId}`, resolution: 'thisMonth' });
    const vals = (e.values || []).filter((v) => typeof v.v === 'number' && isFinite(v.v));
    if (!vals.length) return null;
    const top = vals.reduce((a, v) => (v.v > a.v ? v : a), vals[0]);
    return { value: top.v, at: top.t };
  } catch (err) {
    return null;
  }
}

let peakState = {};
try { peakState = JSON.parse((await global.get('vibble_peak_hour')) || '{}'); } catch (err) { peakState = {}; }
if (peakState.month !== monthKey) {
  const seed = await seedFromInsights();
  peakState = { month: monthKey, value: seed ? seed.value : 0, at: seed ? seed.at : null };
}
const lastHour = cap(ELEC, 'meter_kwh_last_hour');
if (typeof lastHour === 'number' && lastHour > (peakState.value || 0)) {
  peakState.value = lastHour;
  peakState.at = new Date().toISOString();
}
try { await global.set('vibble_peak_hour', JSON.stringify(peakState)); } catch (err) { /* not fatal */ }

const peakHour = peakState.value || null;
let peakHourWhen = '';
if (peakState.at) {
  const d = new Date(peakState.at);
  if (!Number.isNaN(d.getTime())) {
    peakHourWhen = `${d.toLocaleDateString('sv-SE', { timeZone: TZ, day: 'numeric', month: 'numeric' })} ${hhmm(d)}`;
  }
}

// ---- phases ----
// Only current is measured per phase, in amperes. Converting to watts would mean
// inventing a power factor, so the amperes are shown as measured.
const phases = ['L1', 'L2', 'L3'].map((p) => {
  const a = cap(PULSE, `measure_current.${p}`);
  return `${p} ${a === null ? '-' : num(a, 1)}`;
}).join('  ');

// ---- water ----
// meter_watertoday is litres straight from the meter; yesterday only exists as
// cubic metres on the Power-by-the-Hour companion. The companion's money fields
// are left alone: they read 363 kr for 172 litres against a 52,61 kr/m3 tariff,
// which cannot be right.
const waterToday = cap(WATER, 'meter_watertoday');
const waterYestM3 = cap(WATER_PBTH, 'meter_m3_last_day');
const waterYest = waterYestM3 === null ? null : Math.round(waterYestM3 * 1000);

const t = [
  { text: [12, 4, 'ENERGI & VATTEN', BIG, BLACK] },
  { text: [340, 20, hhmm(new Date()), SMALL, BLACK] },
  { line: [8, 36, 392, 36, BLACK] },

  { text: [12, 44, 'EL IDAG', MID, BLACK] },
  { text: [12, 66, kwhToday === null ? '-' : `${num(kwhToday, 1)} kWh`, BIG, BLACK] },
  { text: [210, 66, costToday === null ? '-' : `${Math.round(costToday)} kr`, BIG, BLACK] },
  { text: [12, 94, kwhYest === null ? '' : `igår ${num(kwhYest, 1)}`, MID, BLACK] },
  { text: [210, 94, costYest === null ? '' : `igår ${Math.round(costYest)} kr`, MID, BLACK] },

  { line: [8, 118, 392, 118, BLACK] },
  { text: [12, 126, 'TOPPEFFEKT', MID, BLACK] },
  { text: [12, 148, kw(peakDay ? peakDay.value : null), BIG, BLACK] },
  { text: [175, 152, peakTime, MID, BLACK] },
  { text: [12, 176, 'Årets topp', MID, BLACK] },
  { text: [250, 176, kw(peakYear), MID, BLACK] },
  { text: [12, 198, 'Timmedel mån', MID, BLACK] },
  { text: [160, 198, peakHour === null ? '-' : `${num(peakHour, 1)} kW`, MID, BLACK] },
  { text: [250, 198, peakHourWhen, MID, BLACK] },
  { text: [12, 220, phases + ' A', MID, BLACK] },

  { line: [8, 242, 392, 242, BLACK] },
  { text: [12, 254, 'VATTEN', MID, BLACK] },
  { text: [110, 250, waterToday === null ? '-' : `${Math.round(waterToday)} liter`, BIG, BLACK] },
  { text: [290, 254, waterYest === null ? '' : `igår ${waterYest} l`, MID, BLACK] },
];

console.log(`el ${num(kwhToday, 1)} kWh / ${Math.round(costToday)} kr, topp ${kw(peakDay ? peakDay.value : null)} ${peakTime}`
  + `, timmedel ${num(peakHour, 1)} kW ${peakHourWhen}, faser ${phases}, vatten ${waterToday} l`);
return JSON.stringify(t);
