// Change gate in front of Display 11 and Display 14 in "Status för Vibble".
// Condition card e488517d. Returns true only when something a board actually
// renders has changed, so a fifteen minute cron and fourteen threshold triggers
// do not repaint an e-paper panel that would look identical.
//
// Why this file exists at all: the gate carried its own copies of the device
// list and of the cold-storage thresholds, and the thresholds had drifted to
// fridge >= 7 and freezer > -16 while the board rendered 10 and -12. That was
// not merely untidy, it was a hole:
//
//   A fridge crossing 7 entered the signature, the gate fired, and the board was
//   repainted with nothing on it - correctly, since 7 is below the warning
//   limit. When the same fridge later climbed past 10 and became a real
//   deviation, the signature did not change, because it only carried the name.
//   The gate returned false, and Display 11 - which has no cron of its own, only
//   this gate - kept showing "Alla OK" while the alarm was firing.
//
// So the signature now carries the level, from the same coldLevel() the board
// uses, on the same Logic variables the alarm uses.

const APPL = [
  ['1fd74279-7b1d-49fd-8844-5e4b7d6ba680', 'Tvätt'],
  ['d715027b-f2f4-4fdb-8067-2a70e17b28c8', 'Tork'],
  ['ba61b0a6-8bb6-44f3-8d5a-530e1346660c', 'Disk'],
];

// A remaining_time that has not been updated for this long is a leftover from a
// finished programme rather than a running one.
const FRESH_MS = 20 * 60 * 1000;

// ==== BEGIN cold-limits (delad kod - se docs/cold-limits.snippet.js) ====
// The seven units, in one place. It used to be three copies, which is why
// repointing the freezer sensor in September had to touch three scripts.
const COLD = [
  ['3753a84f-08e3-4bc3-a425-cfce430f2a8f', 'Kylskåp', 'fridge'],
  ['c0087978-e847-45ba-a6d9-b9f6923ff986', 'Kyl halv', 'fridge'],
  ['1a422bee-b496-416a-890e-29d47c4be9cf', 'Ölkyl', 'fridge'],
  // Re-added under the Shelly Control app on 2026-09-06; same physical sensor,
  // same MAC 7C:C6:B6:74:D4:6D, new device id. The old one is the Legacy entry.
  ['fdf3a2bd-8c82-4a00-ba60-8b1752f16b4d', 'Frys', 'freezer'],
  ['0e28a3d8-c82c-4385-9fc3-3ed0626f79ab', 'Frys halv', 'freezer'],
  ['592b5b19-eaba-4399-b415-1dd3242f6d7e', 'Frys stående', 'freezer'],
  ['b8612fd5-1ab1-4704-8b89-d26c1e44162a', 'Frys liggande', 'freezer'],
];

// The six limits live in Logic variables so the board, the alarm and the change
// gate move together and cannot drift apart. The numbers here are a fallback for
// a renamed or deleted variable and nothing else. Using one is logged loudly:
// a silent fallback is how the copies drifted apart in the first place.
const COLD_FALLBACK = {
  fridge: { warn: 10, crit: 12, low: 1 },
  freezer: { warn: -12, crit: -6, low: -31 },
};
const COLD_VARS = {
  fridge: { warn: 'Kyl larm hög', crit: 'Kyl larm kritisk', low: 'Kyl larm låg' },
  freezer: { warn: 'Frys larm hög', crit: 'Frys larm kritisk', low: 'Frys larm låg' },
};
const COLD_LIMITS = JSON.parse(JSON.stringify(COLD_FALLBACK));
const COLD_FALLBACK_USED = [];
try {
  const byName = new Map(Object.values(await Homey.logic.getVariables()).map((v) => [v.name, v]));
  for (const kind of Object.keys(COLD_VARS)) {
    for (const key of Object.keys(COLD_VARS[kind])) {
      const varName = COLD_VARS[kind][key];
      const v = byName.get(varName);
      if (v && typeof v.value === 'number') COLD_LIMITS[kind][key] = v.value;
      else COLD_FALLBACK_USED.push(`${varName} ${v ? `= ${JSON.stringify(v.value)} (inte ett tal)` : 'saknas'}, anvander ${COLD_FALLBACK[kind][key]}`);
    }
  }
} catch (err) {
  COLD_FALLBACK_USED.push(`kunde inte lasa Logic-variablerna (${err.message}), anvander alla sex inbyggda varden`);
}
if (COLD_FALLBACK_USED.length) {
  console.log(`VARNING kyl/frys-trosklar: fallback for ${COLD_FALLBACK_USED.length} av 6 - ${COLD_FALLBACK_USED.join('; ')}`);
}

// The one place a temperature is turned into a level. `slack` widens the band
// while a unit is already alarming - the alarm passes its hysteresis here, the
// board and the gate pass nothing.
function coldLevel(kind, t, slack) {
  const L = COLD_LIMITS[kind];
  const d = slack || 0;
  if (t > L.crit - d) return 'krit';
  if (t > L.warn - d) return 'varn';
  if (L.low !== null && t < L.low + d) return 'lag';
  return null;
}
// ==== END cold-limits ====

const devices = await Homey.devices.getDevices();
const capObj = (id, c) => {
  const d = devices[id];
  if (!d || !d.capabilitiesObj || !d.capabilitiesObj[c]) return null;
  return d.capabilitiesObj[c];
};

const parts = [];
for (const [id, name] of APPL) {
  const rt = capObj(id, 'bshc_string.remaining_time');
  let state = 'idle';
  if (rt && rt.value !== null && rt.value !== undefined && rt.value !== '') {
    const mins = parseInt(String(rt.value).split(':')[0], 10);
    if (!isFinite(mins)) state = 'idle';
    else if (mins <= 0) state = 'done';
    else {
      const age = Date.now() - new Date(rt.lastUpdated).getTime();
      // Quantised to five minutes so a countdown ticking down does not repaint
      // the panel every single minute.
      state = (isFinite(age) && age <= FRESH_MS)
        ? 'run' + Math.round((Date.now() + mins * 60000) / 300000)
        : 'sel';
    }
  }
  parts.push(name + ':' + state);
}

// name:level, not name. A unit escalating from warning to critical changes what
// the board draws - it gains a leading "!" and sorts to the top - so it has to
// change the signature too.
const bad = [];
for (const [id, name, kind] of COLD) {
  const o = capObj(id, 'measure_temperature');
  if (!o || o.value === null || o.value === undefined) continue;
  const level = coldLevel(kind, o.value);
  if (level) bad.push(name + ':' + level);
}
parts.push('cold:' + bad.sort().join(','));

const sig = parts.join('|');
const prev = await global.get('vibble_appl_sig');
if (sig === prev) { console.log('no change: ' + sig); return false; }
await global.set('vibble_appl_sig', sig);
console.log('changed: ' + (prev === undefined ? '(unknown)' : prev) + ' -> ' + sig);
return true;
