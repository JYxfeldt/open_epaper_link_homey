// The button on Display 11 acknowledges whatever the panel is showing.
//
// It reads the signature the template script drew rather than re-reading the
// sensors, so the acknowledgement always matches what was actually on the screen
// when the button was pressed - even if a sensor has moved since the last draw.
//
// This card runs before the redraw in the Flow, which is the order we want: it
// acknowledges the visible alarm, then the screen redraws, then the LED condition
// compares the fresh signature against this acknowledgement.

const sig = (await global.get('vibble_drawn_sig')) || '';
await global.set('vibble_ack_sig', sig);
console.log('kvitterat: ' + (sig || '(inget larm)'));
return sig || '(inget larm)';
