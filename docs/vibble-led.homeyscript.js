// Should the LED on Display 11 be flashing?
//
// This does no evaluating of its own any more. The template script publishes the
// deviations it actually drew into vibble_drawn_sig, and this only reads that, so
// the lamp and the board cannot drift apart.
//
// The acknowledgement still works the same way: a press stores the drawn
// signature in vibble_ack_sig, and an alarm that matches it is not flashed again.

const sig = (await global.get('vibble_drawn_sig')) || '';
const ack = (await global.get('vibble_ack_sig')) || '';

if (!sig) {
  // Nothing is out of bounds any more, so a later alarm counts as new.
  if (ack) await global.set('vibble_ack_sig', '');
  console.log('inget larm ritat pa skarmen -> LED slackt, kvittering nollstalld');
  return false;
}
if (sig === ack) {
  console.log('larmet ar kvitterat: ' + sig + ' -> LED slackt');
  return false;
}
console.log('larm ritat pa skarmen: ' + sig + (ack ? ' (kvitterat var ' + ack + ')' : '') + ' -> LED tand');
return true;
