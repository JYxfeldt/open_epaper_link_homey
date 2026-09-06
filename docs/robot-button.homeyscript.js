// May this button press start Olof?
//
// The Homey trigger fires for any button on Display 08, and the token syntax for
// reading which one is unproven here, so this asks the AP directly instead: the
// tag reports why it woke up, and a press is still visible in /get_db for a few
// seconds afterwards. Measured mapping on this panel:
//
//   wakeupReason 4 = BUTTON1 = right button   -> starts Olof
//   wakeupReason 5 = BUTTON2 = left button    -> reserved, does nothing
//
// Three guards on top of that, because a vacuum cleaner starting by accident is
// a genuinely unpleasant surprise:
//   1. Olof must be home (docked or charging), not stuck under a sofa
//   2. no alarm active
//   3. at least five minutes since the last accepted press
//
// The actual starting is left to Jonas's own "Starta Olof" flow, which already
// checks that the job mode is idle and records the date. This never duplicates
// that logic and never modifies that flow.

const AP = '192.168.111.179';
const MAC = '00007E1FB84FB29F';
const OLOF = '9ebb82a9-7267-422e-ab4c-356c3586c301';
const RIGHT_BUTTON = 4;
const PRESS_MAX_AGE_S = 45;
const COOLDOWN_MS = 5 * 60 * 1000;

const ALARMS = [
  'alarm_stuck', 'alarm_lost', 'alarm_bin_full', 'alarm_bin_missing',
  'alarm_tank_empty', 'alarm_tank_missing', 'alarm_tank_open',
  'alarm_cleaning_pad_missing',
];
// Docked or charging. Anything else means he is out on the floor somewhere.
const AT_HOME = ['65', '66'];

async function tagState() {
  let pos = 0;
  for (let i = 0; i < 10; i++) {
    const res = await fetch('http://' + AP + '/get_db?pos=' + pos);
    if (!res.ok) return null;
    const db = await res.json();
    const tags = db.tags || [];
    const hit = tags.find((t) => String(t.mac).toUpperCase() === MAC);
    if (hit) return hit;
    if (db.continu === undefined || tags.length === 0) return null;
    pos += tags.length;
  }
  return null;
}

const tag = await tagState();
if (!tag) {
  console.log('kunde inte läsa taggen från AP:n - trycket ignoreras');
  return false;
}

const age = Math.floor(Date.now() / 1000) - tag.lastseen;
console.log('Display 08: wakeupReason=' + tag.wakeupReason + ', incheckning ' + age + 's sedan');

if (tag.wakeupReason !== RIGHT_BUTTON) {
  console.log('inte höger knapp (väntade ' + RIGHT_BUTTON + ') - ignoreras');
  return false;
}
if (age > PRESS_MAX_AGE_S) {
  console.log('incheckningen är för gammal (' + age + 's) - troligen inte det här trycket');
  return false;
}

const last = Number(await global.get('robot_button_last')) || 0;
const since = Date.now() - last;
if (last && since < COOLDOWN_MS) {
  console.log('bara ' + Math.round(since / 1000) + 's sedan förra accepterade trycket - ignoreras');
  return false;
}

const devices = await Homey.devices.getDevices();
const olof = devices[OLOF];
const capsOf = (c) => {
  const o = olof && olof.capabilitiesObj && olof.capabilitiesObj[c];
  return o ? o.value : null;
};

const state = String(capsOf('operational_state'));
if (!AT_HOME.includes(state)) {
  console.log('Olof är inte hemma (operational_state=' + state + ') - startar inte');
  return false;
}

const active = ALARMS.filter((a) => capsOf(a) === true);
if (active.length) {
  console.log('larm aktivt på Olof (' + active.join(', ') + ') - startar inte');
  return false;
}

await global.set('robot_button_last', String(Date.now()));
console.log('höger knapp godkänd - startar Olof');
return true;
