// Builds the JSON template for the door board on Display 07.
//
// Two columns of four, because eight doors will not fit in one column at a
// readable size on a 384x168 panel. Open is red and closed is black, so the
// question the board exists to answer - is anything open - is legible from
// across the room without reading a single word.
//
// The two doors that also have a lock report the lock instead of "Stängd":
// "Låst" in black, "Olåst" in red. An unlocked front door is worth noticing.

const BLACK = 1, RED = 2;
const BIG = 'bahnschrift30', MID = 'bahnschrift20', SMALL = 't0_14b_tf';

// name, contact device, lock device (optional)
// Names are capped at nine characters: measured on the panel, bahnschrift20 runs
// about 9.7 px per character, so "Garagedörr" and "Redskapsbod" ran into the
// state column and rendered as "GaragedörrLåst" and "RedskapsboStängd".
const DOORS = [
  ['Ytterdörr', '78cbf17c-259d-4a76-8656-cfb35ff79a52', 'b18c6bf4-9708-4451-bed4-16cff0ea0baf'],
  ['Altandörr', 'b6df8bf4-f49e-411a-92c2-651a6aa9c9e6', null],
  ['Glasrum', '58584136-bf1c-4afe-9a66-849d3c2c9141', null],
  ['Garage', '85fdc1ae-1dd8-4f2f-97e3-f4c53a0e4f2d', '9c1111bc-d194-457e-a65a-fab06b156254'],
  ['Gästrum', '508b1b39-2d04-4799-90f0-3b3fb1b818d3', null],
  ['Gäststuga', '0a505a7d-6247-425b-a990-547ade1ced6b', null],
  ['Bod', 'cb1bdf5c-0bb6-4f14-be9b-8e603f000337', null],
  ['Soprum', 'a67e4d93-aeb8-4b93-a715-fac9a2783744', null],
];
// The toilet door is an interior door that stands open most of the time, which
// would make "1 öppen" permanent noise. Left out until Jonas says otherwise.
// ['Toalett', 'eb86b118-80e2-4bfb-b1c1-910a406d23af', null],

// Nine characters is about 87 px, so the state column starts at 104 and 296,
// leaving a real gap rather than the two pixels the first version had.
const COL_X = [[8, 104], [200, 296]];
const ROW_Y = [40, 64, 88, 112];

let TZ = 'Europe/Stockholm';
try {
  const info = await Homey.system.getInfo();
  if (info && info.timezone) TZ = info.timezone;
} catch (err) { /* keep the default */ }
const hhmm = (d) => d.toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const devices = await Homey.devices.getDevices();
const cap = (id, c) => {
  const d = devices[id];
  const o = d && d.capabilitiesObj && d.capabilitiesObj[c];
  return o && o.value !== undefined ? o.value : null;
};

const rows = DOORS.map(([name, contactId, lockId]) => {
  const open = cap(contactId, 'alarm_contact') === true;
  if (open) return { name, state: 'Öppen', red: true, open: true };
  if (!lockId) return { name, state: 'Stängd', red: false, open: false };
  const locked = cap(lockId, 'locked');
  if (locked === true) return { name, state: 'Låst', red: false, open: false };
  if (locked === false) return { name, state: 'Olåst', red: true, open: false };
  return { name, state: 'Stängd', red: false, open: false };
});

// bahnschrift30 rendered "DÖRRAR" as "DORRAR" - it has no capital Ö. Mixed case
// is the workaround; whether it carries a lower case ö is being probed on
// Display 06, and PORTAR is the fallback if it does not.
const t = [
  { text: [10, 2, 'Dörrar', BIG, BLACK] },
  { text: [330, 16, hhmm(new Date()), SMALL, BLACK] },
  { line: [5, 30, 379, 30, BLACK] },
  { line: [192, 34, 192, 130, BLACK] },
];

rows.forEach((r, i) => {
  const [nx, sx] = COL_X[i < 4 ? 0 : 1];
  const y = ROW_Y[i % 4];
  const colour = r.red ? RED : BLACK;
  t.push({ text: [nx, y, r.name, MID, colour] });
  t.push({ text: [sx, y, r.state, MID, colour] });
});

const open = rows.filter((r) => r.open);
const unlocked = rows.filter((r) => r.state === 'Olåst');
let summary = 'Allt stängt';
if (open.length) summary = `${open.length} öppen${open.length > 1 ? 'a' : ''}`;
if (open.length && unlocked.length) summary += `, ${unlocked.length} olåst`;
else if (unlocked.length) summary = `${unlocked.length} olåst${unlocked.length > 1 ? 'a' : ''}`;
t.push({ text: [8, 140, summary, MID, (open.length || unlocked.length) ? RED : BLACK] });

// The lamp reads what was drawn rather than the sensors, the same way Display 08
// and Display 11 do, so it cannot contradict the screen.
await global.set('doors_alert', open.concat(unlocked).map((r) => r.name).join(','));

console.log('dörrar: ' + rows.map((r) => r.name + '=' + r.state).join(', ') + '  -> ' + summary);
return JSON.stringify(t);
