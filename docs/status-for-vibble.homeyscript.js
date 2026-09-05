// Builds the OpenEPaperLink JSON template for one of the "Status för Vibble"
// screens. Everything that needs computing is done here, because a static JSON
// template can only substitute tokens - it cannot branch, format times, or grow
// a variable number of rows.
//
// One script serves all four screens so the thresholds and the appliance rules
// cannot drift apart between copies. The first argument field picks the screen.
//
// Argument: nine fields separated by "|"
//   0 screen: "9" | "10" | "11" | "14"
//   1 namnsdag 1, 2 namnsdag 2, 3 dagar till post, 4 postdatum,
//   5 sopor idag (etikett), 6 sopor imorgon (etikett),
//   7 soluppgång, 8 solnedgång
// Fields 1-8 are only read by screens 9 and 14. The sun times come from
// [[homey:manager:cron|sunrise]] and |sunset, which Homey already delivers as
// local "HH:MM", so they need no timezone handling of their own.

const BLACK = 1, RED = 2;
const BIG = 'bahnschrift30', MID = 'bahnschrift20', F = 't0_14b_tf';

const A = (args[0] || '').split('|');
const pick = i => (A[i] || '').trim();
const SCREEN = pick(0) || '14';

// HomeyScript runs in UTC, so every clock time on a board has to be formatted in
// Homey's own timezone or it reads two hours early in the summer.
let TZ = 'Europe/Stockholm';
try {
  const info = await Homey.system.getInfo();
  if (info && info.timezone) TZ = info.timezone;
} catch (err) { /* keep the default */ }
const hhmm = d => d.toLocaleTimeString('sv-SE', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});
const stamp = hhmm(new Date());

const devices = await Homey.devices.getDevices();
function capObj(id, c) {
  const d = devices[id];
  if (!d || !d.capabilitiesObj || !d.capabilitiesObj[c]) return null;
  return d.capabilitiesObj[c];
}
function cap(id, c) {
  const o = capObj(id, c);
  if (!o) return null;
  return (o.value === undefined) ? null : o.value;
}

// ---- temperatures -------------------------------------------------------
const ALTAN = '56d0c0fb-9d99-44ac-8b5d-f467fe3a0503';
const POOL  = '26405739-85c2-4857-a567-9d1e4a23558a';
const VP_E  = '74c0d450-7f13-425a-b3cc-fd2e0bed0acc';
const VP_G  = '5ba80cad-900c-4178-a387-e1c9a24d6e9b';

const MODE = { heat:'Värme', cool:'Kyla', auto:'Auto', off:'Av', fan:'Fläkt', dry:'Avfukt' };
// Swedish uses a decimal comma. The boards were printing "15.6 °C" while the
// robot and energy boards printed "25,2 kWh", which looked like two systems.
const sv = v => String(v).replace('.', ',');
const deg = v => (v === null ? '-' : sv(v) + ' °C');
const pump = id => {
  const t = cap(id, 'target_temperature');
  const m = cap(id, 'thermostat_mode');
  if (t === null) return '-';
  return t + '° ' + (MODE[m] || m || '?');
};
// Both heat pumps report the room they sit in through measure_temperature, so
// the board can show what it is actually like next to the target.
const pumpDetail = id => {
  const now = cap(id, 'measure_temperature');
  const t = cap(id, 'target_temperature');
  const m = cap(id, 'thermostat_mode');
  if (t === null) return '-';
  const measured = (now === null) ? '?' : Math.round(now);
  return measured + '° nu, ' + t + '° ' + (MODE[m] || m || '?');
};

// ---- outdoor max/min over 24 h ------------------------------------------
// Three independent outdoor sources; the median of their maxima and of their
// minima, so one flaky sensor cannot skew the figure. Knolls grund is a sea buoy
// (water temperature) and the Trafikverket "Fjärryta" feed has been stuck at 0
// since 2024, so neither is used.
const OUTDOOR = [
  '9d5e8a41-5780-4bf0-979a-dcf5d704391b', // Poolhuset ute (Sonoff, pooldäck)
  'e5d77080-a0c8-46e9-8c2a-438fba267064', // Kneippbyn/Visby (temperatur.nu)
  'ef16bc61-24fb-4870-8afe-14d9a71e6134', // Hamnbacken Visby (Trafikverket)
];

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function outdoorRange() {
  const maxima = [], minima = [];
  for (const id of OUTDOOR) {
    const logId = 'homey:device:' + id + ':measure_temperature';
    try {
      const e = await Homey.insights.getLogEntries({
        id: logId, uri: 'homey:log:' + logId, resolution: 'last24Hours',
      });
      const nums = (e.values || []).map(v => v.v)
        .filter(n => typeof n === 'number' && isFinite(n));
      if (!nums.length) continue;
      maxima.push(Math.max(...nums));
      minima.push(Math.min(...nums));
    } catch (err) {
      // a missing log just means one fewer source in the median
    }
  }
  const one = v => (v === null ? null : Math.round(v * 10) / 10);
  const hi = one(median(maxima)), lo = one(median(minima));
  return { hi, lo };
}

// ---- appliances ---------------------------------------------------------
// Home Connect exposes no state capability here, only a remaining time and a
// progress string. Measured on a dryer mid-programme, progress froze at "0%" the
// moment the programme started while remaining_time counted down once a minute;
// a dishwasher that had only been selected still held a 21-hour-old
// remaining_time. So progress carries no information, and what separates running
// from selected is whether remaining_time is still being written.
const WASH = '1fd74279-7b1d-49fd-8844-5e4b7d6ba680';
const DRY  = 'd715027b-f2f4-4fdb-8067-2a70e17b28c8';
const DISH = 'ba61b0a6-8bb6-44f3-8d5a-530e1346660c';
const APPLIANCES = [[WASH, 'Tvätt'], [DRY, 'Tork'], [DISH, 'Disk']];

// A running machine writes remaining_time about once a minute, so anything this
// old means the value is a leftover from a selection that was never started.
const FRESH_MS = 20 * 60 * 1000;

function appliance(id) {
  const rt = capObj(id, 'bshc_string.remaining_time');
  if (!rt || rt.value === null || rt.value === undefined || rt.value === '') return 'Ingen körning';
  // "150:00" is minutes:seconds
  const mins = parseInt(String(rt.value).split(':')[0], 10);
  if (!isFinite(mins)) return 'Ingen körning';
  if (mins <= 0) return 'Färdig';
  const age = Date.now() - new Date(rt.lastUpdated).getTime();
  if (!isFinite(age) || age > FRESH_MS) return 'Vald, ej startad';
  return 'Klar ' + hhmm(new Date(Date.now() + mins * 60000));
}

// ---- cold storage -------------------------------------------------------
// Fridge at or above 7 C is a deviation; freezer warmer than -16 C is a
// deviation. -16 rather than -18 leaves room for the defrost cycle.
const COLD = [
  ['3753a84f-08e3-4bc3-a425-cfce430f2a8f', 'Kylskåp',       'fridge'],
  ['c0087978-e847-45ba-a6d9-b9f6923ff986', 'Kyl halv',      'fridge'],
  ['1a422bee-b496-416a-890e-29d47c4be9cf', 'Ölkyl',         'fridge'],
  ['df4dcf2d-d142-4d58-9f94-d171547328f6', 'Frys',          'freezer'],
  ['0e28a3d8-c82c-4385-9fc3-3ed0626f79ab', 'Frys halv',     'freezer'],
  ['592b5b19-eaba-4399-b415-1dd3242f6d7e', 'Frys stående',  'freezer'],
  ['b8612fd5-1ab1-4704-8b89-d26c1e44162a', 'Frys liggande', 'freezer'],
];

function coldDeviations() {
  const dev = [];
  for (const row of COLD) {
    const t = cap(row[0], 'measure_temperature');
    if (t === null) continue;
    const bad = row[2] === 'fridge' ? (t >= 7) : (t > -16);
    if (bad) dev.push({ name: row[1], temp: sv(t) + ' °C' });
  }
  return dev;
}
const coldSummary = n => (n ? n + ' avvikelse' + (n > 1 ? 'r' : '') : 'Alla OK');

// ---- general information ------------------------------------------------
// ---- refuse collection --------------------------------------------------
// The trash app's own Flow card only answers today, tomorrow and the day after,
// which is why the board used to say nothing but "ingen hämtning" for weeks at a
// time. The schedule itself is fully specified in the app's settings, so the
// next date is computed from that instead and the two action cards it needed are
// gone.
//
// Two four-compartment bins, each holding two fractions on its own cycle:
//   Fyrfack 1  kompost + restavfall   every 2 weeks from 2026-05-04, Mondays
//   Fyrfack 2  plast + kartong        every 4 weeks from 2026-05-11, Mondays
// They never fall on the same day, but if they ever did they are listed as one.
const BINS = [
  { name: 'fyrfack 1', types: ['GFT', 'REST'] },
  { name: 'fyrfack 2', types: ['PLASTIC', 'PAPIER'] },
];

async function nextCollection() {
  let manual;
  try {
    const s = await Homey.apps.getAppSettings({ id: 'com.trashchecker' });
    manual = s && s.manualEntryData;
  } catch (err) {
    return null;
  }
  if (!manual) return null;

  const midnight = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  midnight.setHours(0, 0, 0, 0);

  const nextFor = (type) => {
    const e = manual[type];
    if (!e || e.option === '-1' || !e.startdate) return null;
    const weeks = Number(e.option);
    if (!isFinite(weeks) || weeks <= 0) return null;
    const start = new Date(`${e.startdate}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const step = weeks * 7 * 86400000;
    if (start >= midnight) return start;
    return new Date(start.getTime() + Math.ceil((midnight - start) / step) * step);
  };

  const due = [];
  for (const b of BINS) {
    const dates = b.types.map(nextFor).filter(Boolean).sort((a, z) => a - z);
    if (dates.length) due.push({ name: b.name, at: dates[0] });
  }
  if (!due.length) return null;

  due.sort((a, b) => a.at - b.at);
  const soonest = due[0].at.getTime();
  const together = due.filter((d) => d.at.getTime() === soonest);
  // "fyrfack 1 + 2" rather than repeating the word when they coincide.
  const label = together.length > 1
    ? `fyrfack ${together.map((d) => d.name.replace('fyrfack ', '')).join(' + ')}`
    : together[0].name;
  return { label, days: Math.round((soonest - midnight.getTime()) / 86400000) };
}

async function generalRows() {
  const namnsdag = [pick(1), pick(2)].filter(Boolean).join(' och ') || 'ingen';
  const postDays = pick(3), postDate = pick(4);
  let post;
  if (!postDays && postDays !== '0') post = 'okänt';
  else if (postDays === '0') post = 'idag';
  else if (postDays === '1') post = 'imorgon';
  else post = 'om ' + postDays + ' dagar';
  if (post !== 'okänt' && postDate && postDays !== '0' && postDays !== '1') post += ' (' + postDate + ')';

  const next = await nextCollection();
  let sopor;
  if (!next) sopor = 'okänt';
  else if (next.days === 0) sopor = `${next.label} idag`;
  else if (next.days === 1) sopor = `${next.label} imorgon`;
  else if (next.days === 2) sopor = `${next.label} i övermorgon`;
  else sopor = `${next.label} om ${next.days} dagar`;

  return { namnsdag, post, sopor };
}

// ---- small-panel helpers (M3 2.9", 384 x 168 landscape) -----------------
// The buffer is stored portrait and rotatebuffer=3 makes the AP turn it, so the
// template itself is written in landscape.
// The two font families anchor differently, measured off real renders:
//   t0_14b_tf     y is the baseline, ink runs from y-11 to y-1
//   bahnschrift*  y is the top, ink runs downwards
// so anything set in t0_14b_tf needs y >= 12 or it is clipped by the top edge.
const S_W = 384;
const S_TITLE_Y = 2, S_RULE_Y = 26, S_STAMP_X = 340, S_STAMP_Y = 16;

// Screens whose body text is also bahnschrift20 need a bigger heading, or the
// title does not read as a title at all.
function smallHeader(title, font, ruleY) {
  const y = ruleY || S_RULE_Y;
  return [
    { text: [10, S_TITLE_Y, title, font || MID, BLACK] },
    { text: [S_STAMP_X, S_STAMP_Y, stamp, F, BLACK] },
    { line: [5, y, S_W - 5, y, BLACK] },
  ];
}

// ---- the four screens ---------------------------------------------------
let t;

if (SCREEN === '10') {
  // Two columns: what it is like outside on the left, what the heat pumps are
  // doing on the right. Set in bahnschrift20 rather than the small built-in
  // font, which the 384x168 panel has room for once the board is only about
  // temperatures.
  const { hi, lo } = await outdoorRange();
  const LL = 10, LV = 110, RL = 210;
  const DIV_X = 196;
  t = smallHeader('TEMPERATURER', BIG, 32);
  t.push({ line: [DIV_X, 38, DIV_X, 166, BLACK] });

  const left = [
    ['Altan', deg(cap(ALTAN, 'measure_temperature'))],
    ['Pool', deg(cap(POOL, 'measure_temperature'))],
    ['Ute max', hi === null ? '-' : deg(hi)],
    ['Ute min', lo === null ? '-' : deg(lo)],
  ];
  left.forEach((r, i) => {
    const y = 48 + i * 26;
    t.push({ text: [LL, y, r[0], MID, BLACK] });
    t.push({ text: [LV, y, r[1], MID, BLACK] });
  });

  const right = ['VP Entré', pumpDetail(VP_E), 'VP Gillest.', pumpDetail(VP_G)];
  right.forEach((s, i) => {
    t.push({ text: [RL, 48 + i * 26, s, MID, BLACK] });
  });

} else if (SCREEN === '11') {
  // Set in bahnschrift20 like the other boards. The appliance states are long
  // enough ("Vald, ej startad") that two columns would force abbreviating them,
  // so this one stays full width and gains height by tightening the row pitch.
  // Four fixed rows plus two for the alarm, which is the point of this screen.
  const LL = 10, LV = 110;
  const DEV_Y = [126, 148];
  const dev = coldDeviations();

  // Publish what this screen is about to draw. The lamp reads this rather than
  // re-reading the sensors, so it cannot contradict the panel the way it did on
  // 31 August, when an eleven minute old render still said "Alla OK" while the
  // lamp correctly flashed for a fridge at 7.8 C.
  try {
    await global.set('vibble_drawn_sig', dev.map(d => d.name).sort().join(','));
  } catch (err) { /* not fatal, the board still draws */ }
  t = smallHeader('VITVAROR', BIG, 30);
  APPLIANCES.forEach((a, i) => {
    const y = 38 + i * 22;
    t.push({ text: [LL, y, a[1], MID, BLACK] });
    t.push({ text: [LV, y, appliance(a[0]), MID, BLACK] });
  });
  t.push({ text: [LL, 104, 'Kyl/frys', MID, BLACK] });
  t.push({ text: [LV, 104, coldSummary(dev.length), MID, dev.length ? RED : BLACK] });

  // One or two offenders get a line each with their temperature. Beyond that
  // there is no room for the degrees, so the names are packed across the same
  // two lines instead: which appliance is wrong matters more than by how much,
  // and the summary row above already gives the count.
  if (dev.length <= DEV_Y.length) {
    dev.forEach((d, i) => {
      t.push({ text: [20, DEV_Y[i], d.name, MID, RED] });
      t.push({ text: [210, DEV_Y[i], d.temp, MID, RED] });
    });
  } else {
    // Measured: 37 characters of these names come to 331 px, so roughly 9 px
    // per character once the capitals are counted. From x=20 to the right edge
    // there are 359 px, which is 38 characters with a little to spare.
    const PER_LINE = 38;
    const lines = [];
    let line = '';
    let left = 0;
    dev.forEach((d, i) => {
      const piece = d.name + (i < dev.length - 1 ? ',' : '');
      const candidate = line ? line + ' ' + piece : piece;
      if (candidate.length <= PER_LINE) {
        line = candidate;
      } else if (lines.length < DEV_Y.length - 1) {
        lines.push(line);
        line = piece;
      } else {
        left += 1;
      }
    });
    if (line) lines.push(line);
    if (left) {
      const tail = ' +' + left + ' till';
      const last = lines.length - 1;
      lines[last] = lines[last].slice(0, PER_LINE - tail.length) + tail;
    }
    lines.slice(0, DEV_Y.length).forEach((s, i) => {
      t.push({ text: [20, DEV_Y[i], s, MID, RED] });
    });
  }

} else if (SCREEN === '9') {
  // general information, three lines only, so they can be set larger
  const g = await generalRows();
  const sunrise = pick(7), sunset = pick(8);
  // a plain hyphen, because t0_14b_tf and bahnschrift have no en dash glyph
  const sun = (sunrise && sunset) ? sunrise + ' - ' + sunset : 'okänt';
  t = smallHeader('IDAG', BIG, 38);
  t.push({ text: [10, 48, 'Namnsdag: ' + g.namnsdag, MID, BLACK] });
  t.push({ text: [10, 78, 'Post: ' + g.post, MID, BLACK] });
  t.push({ text: [10, 108, 'Sopor: ' + g.sopor, MID, BLACK] });
  t.push({ text: [10, 138, 'Sol: ' + sun, MID, BLACK] });

} else {
  // the 400 x 300 summary board, unchanged
  const LL = 10, LV = 100, DIV = 178, RL = 188, RV = 252;
  const DEV_NAME = RL, DEV_TEMP = 300, DEV_Y0 = 174, DEV_STEP = 20, DEV_MAX = 3;
  // The heading is the date, so its width changes daily and the centring cannot
  // stay a hard-coded 88. These are bahnschrift30's own advance widths, read out
  // of the AP's /fonts/bahnschrift30.vlw (fetch it with /edit?download=, a plain
  // GET on the path 404s). The font carries no U+0020 glyph at all; 7 px is what
  // the renderer actually steps for a space, solved by measuring the old heading
  // on the panel. The table covers every character the date can produce - all 7
  // weekdays, all 12 months, days 1-31 - and all 2604 combinations were checked
  // against the font, so nothing falls through to the default.
  const W30 = {
    ' ': 7, 'i': 8, 'j': 8, 'l': 9, '1': 10, 'f': 10, 't': 10, 'r': 13, 'T': 14,
    '6': 15, '7': 15, '9': 15, 'c': 15, 'v': 15,
    '2': 16, '3': 16, '5': 16, 'a': 16, 'b': 16, 'd': 16, 'e': 16, 'g': 16,
    'k': 16, 'o': 16, 'p': 16, 's': 16, 'å': 16, 'ö': 16,
    '0': 17, '4': 17, '8': 17, 'F': 17, 'L': 17, 'n': 17, 'u': 17,
    'S': 18, 'O': 19, 'M': 23, 'm': 26,
  };
  const w30 = s => [...s].reduce((w, ch) => w + (W30[ch] === undefined ? 16 : W30[ch]), 0);
  // sv-SE gives "lördag 5 september"; only the weekday's first letter is raised.
  // That keeps every diacritic lowercase, which matters: bahnschrift30 renders
  // å ä ö correctly, and no Swedish weekday or month name starts with one.
  const dateStr = new Date().toLocaleDateString('sv-SE', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
  });
  const TITLE = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
  const TITLE_X = Math.max(0, Math.round((400 - w30(TITLE)) / 2));
  const LINE_TOP = 38, LINE_BOT = 232;
  const { hi, lo } = await outdoorRange();
  const outdoor = (hi === null || lo === null) ? '-' : `${sv(hi)}/${sv(lo)}`;
  const dev = coldDeviations();
  const g = await generalRows();

  // y=7, not the old 4. bahnschrift30 puts the baseline at y+21 and draws each
  // glyph up from there by its own topExtent, so anything taller than a capital
  // reaches ABOVE y: 'å' has topExtent 25, i.e. its ring starts at y-4. At y=4
  // that ring lands on row 0, hard against the panel edge - every Monday, and
  // only on Mondays. Measured, not assumed: on the glyph probe 'Ö' (topExtent
  // 26) began exactly 5 px above 'D' in the same string, matching this model.
  // y=7 puts the worst case ('å' ring) at row 3 and the deepest descender
  // ('g', 'j') at row 33, five clear of the rule at 38.
  t = [
    { text: [TITLE_X, 7, TITLE, BIG, BLACK] },
    { line: [5, LINE_TOP, 395, LINE_TOP, BLACK] },
    { text: [LL, 52, 'TEMPERATURER', F, BLACK] },
    { text: [RL, 52, 'VITVAROR', F, BLACK] },
    { line: [DIV, 46, DIV, 226, BLACK] },

    { text: [LL, 78,  'Altan', F, BLACK] },       { text: [LV, 78,  deg(cap(ALTAN,'measure_temperature')), F, BLACK] },
    { text: [LL, 102, 'Pool', F, BLACK] },        { text: [LV, 102, deg(cap(POOL,'measure_temperature')), F, BLACK] },
    { text: [LL, 126, 'VP Entré', F, BLACK] },    { text: [LV, 126, pump(VP_E), F, BLACK] },
    { text: [LL, 150, 'VP Gillest.', F, BLACK] }, { text: [LV, 150, pump(VP_G), F, BLACK] },
    { text: [LL, 174, 'Ute 24h', F, BLACK] },     { text: [LV, 174, outdoor, F, BLACK] },

    { text: [RL, 78,  'Tvätt', F, BLACK] },    { text: [RV, 78,  appliance(WASH), F, BLACK] },
    { text: [RL, 102, 'Tork', F, BLACK] },     { text: [RV, 102, appliance(DRY), F, BLACK] },
    { text: [RL, 126, 'Disk', F, BLACK] },     { text: [RV, 126, appliance(DISH), F, BLACK] },
    { text: [RL, 150, 'Kyl/frys', F, BLACK] }, { text: [RV, 150, coldSummary(dev.length), F, dev.length ? RED : BLACK] },
  ];

  const shown = dev.length > DEV_MAX ? dev.slice(0, DEV_MAX - 1) : dev.slice(0, DEV_MAX);
  shown.forEach((d, i) => {
    const y = DEV_Y0 + i * DEV_STEP;
    t.push({ text: [DEV_NAME, y, d.name, F, RED] });
    t.push({ text: [DEV_TEMP, y, d.temp, F, RED] });
  });
  if (dev.length > DEV_MAX) {
    t.push({ text: [DEV_NAME, DEV_Y0 + (DEV_MAX - 1) * DEV_STEP, '+' + (dev.length - (DEV_MAX - 1)) + ' till', F, RED] });
  }

  t.push({ line: [5, LINE_BOT, 395, LINE_BOT, BLACK] });
  t.push({ text: [LL, 248, 'Namnsdag: ' + g.namnsdag, F, BLACK] });
  t.push({ text: [LL, 268, 'Post: ' + g.post, F, BLACK] });
  t.push({ text: [LL, 288, 'Sopor: ' + g.sopor, F, BLACK] });
  t.push({ text: [310, 288, 'Uppd ' + stamp, F, BLACK] });
}

// The event-driven branch of the Flow reads this to enforce a cooldown, so the
// panel cannot be rewritten repeatedly by a burst of threshold crossings.
try { await global.set('vibble_last_write', Date.now()); } catch (err) { /* not fatal */ }

return JSON.stringify(t);
