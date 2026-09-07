// The one definition of the cold-storage thresholds.
//
// HomeyScript has no import, so this block is pasted verbatim into every script
// that needs the limits:
//
//   docs/status-for-vibble.homeyscript.js   the board on screens 9/10/11/14
//   docs/kylfrys-larm.homeyscript.js        the alarm
//   docs/vibble-andringsgrind.homeyscript.js  the change gate in front of 11/14
//
// docs/check-cold-limits.js fails if the three copies stop matching, which is
// the only thing standing between "one definition" and the drift this replaced.
// Nothing outside the markers may read a threshold literal.
//
// Everything between the BEGIN and END markers below is the block. Copy it
// including the markers.

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
