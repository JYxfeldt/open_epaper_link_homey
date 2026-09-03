// Should the LED on Display 08 be flashing?
//
// This deliberately does no evaluating of its own. The template script writes
// what it actually drew on the screen into robot_fault, and this only reads it,
// so the lamp and the board cannot disagree the way they did on Display 11.
//
// True -> arm a red flash. False -> send the stop pattern.

const faults = await global.get('robot_fault');
if (faults) {
  console.log('fel visas på skärmen: ' + faults + ' -> LED tänd');
  return true;
}
console.log('inga fel på skärmen -> LED släckt');
return false;
