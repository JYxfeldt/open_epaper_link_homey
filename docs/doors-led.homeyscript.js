// Should the LED on Display 07 flash?
//
// Reads what the door board drew, not the sensors, so the lamp and the screen
// cannot drift apart. True when something is open or an outer door is unlocked.

const alert = await global.get('doors_alert');
if (alert) {
  console.log('öppet eller olåst enligt skärmen: ' + alert + ' -> LED tänd');
  return true;
}
console.log('allt stängt och låst -> LED släckt');
return false;
