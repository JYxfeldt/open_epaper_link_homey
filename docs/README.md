# docs

Notes and artefacts that belong to this Homey installation rather than to the
app itself. `.homeyignore` keeps this folder out of the app package.

## status-for-vibble.homeyscript.js

The HomeyScript that builds the JSON templates for the "Status för Vibble"
screens. The board is split across four panels, and one script serves all of them
so the thresholds and the appliance rules cannot drift apart between copies; the
first argument field picks the screen. It lives inside four flow cards in the
Advanced Flow of the same name, one per screen; this copy exists so the logic is
versioned somewhere other than the Homey database.

| Screen | Panel | MAC | Canvas | Contents | Written |
|---|---|---|---|---|---|
| 9  | Display 9  | `0000057CCBB6B294` | 384x168 | namnsdag, post, sopor | 04:00 daily |
| 10 | Display 10 | `000004F16309B296` | 384x168 | temperatures, heat pumps, outdoor 24 h | every 15 min |
| 11 | Display 11 | `8506bfa0` device, `000004F01C38B29D` | 384x168 | appliances, cold storage | on change |
| 14 | Display 14 | `F5CACAC83E325D41` | 400x300 | everything, as a summary | hourly and on change |

The three small panels are M3 2.9" with `rotatebuffer=3`: the framebuffer is
stored portrait and the AP turns it, so the templates are written in landscape.

Display 10 is laid out in two columns, outdoors on the left and the heat pumps on
the right, set in bahnschrift20 rather than the small built-in font. Both pumps
report the room they sit in through `measure_temperature`, so each shows what it
is like now next to its target and mode.

Display 11 is set in bahnschrift20 too, but full width rather than in columns:
its values run as long as "Vald, ej startad", and two columns would force
abbreviating them. It gains the height instead by tightening the row pitch to 22
pixels, which leaves four fixed rows and two for the alarm.

How the alarm rows degrade matters, because the alarm is the point of that
screen:

- one or two appliances out of bounds: a line each, name and temperature
- three or more: the temperatures are dropped and the names are packed across
  the same two lines, since which appliance is wrong matters more than by how
  much, and the summary row already gives the count
- more names than fit: the last line ends in "+N till"

All seven cold appliances fit in the packed form, so the last case is only a
safety net.

### Display 14's heading is the date

Screen 14 replaced the fixed "Status för Vibble" with the day, in Swedish, with
the weekday capitalised - "Lördag 5 september". Only screen 14; the other three
keep their own headings, and the timestamp at the foot of 14 is untouched.

Two things had to be got right, and both are measured rather than assumed (see
"Font geometry" below):

- **Centring.** A fixed `TITLE_X` cannot work when the text changes daily, so it
  is computed from a table of bahnschrift30 advance widths taken from the AP's
  own font file. Across all 2604 combinations of weekday, month and day the
  widest is "Torsdag 24 september" at 299 px, leaving 51 px each side on the
  400 px panel, and every character used is present in the font.
- **Vertical room.** The heading moved from `y=4` to `y=7`. `å` reaches 4 px
  above the draw point, so at `y=4` the ring in "Måndag" would have landed on
  row 0 - one day in seven, and not the day this was built.

`toLocaleDateString('sv-SE', ...)` was checked on the Homey itself rather than
trusted: the runtime has full ICU, resolves `sv-SE`, and honours the timezone
across midnight. Only the first letter is raised, so every diacritic stays
lowercase.

### Refuse collection

The trash app's own Flow card only answers today, tomorrow and the day after,
which is why the board said "ingen hämtning" for weeks at a stretch. The schedule
itself is fully specified in the app's settings under `manualEntryData`, so the
next date is computed from that instead:

| Bin | Fractions | Cycle |
|---|---|---|
| fyrfack 1 | kompost (GFT) + restavfall (REST) | every 2 weeks from 2026-05-04, Mondays |
| fyrfack 2 | plast (PLASTIC) + kartong (PAPIER) | every 4 weeks from 2026-05-11, Mondays |

Only the next collection is shown - "Sopor: fyrfack 1 om 4 dagar" - because
fyrfack 2 is often a month out and would be noise. The two never fall on the same
day, but if they ever did they are listed together as "fyrfack 1 + 2".

Doing this in the template script retired the two `days_to_collect` action cards
per screen, four in all, and the Flow went from 48 cards to 44.

One trap worth recording: the argument fields cannot be edited by splitting on
"|". The other token strings contain pipes of their own, as in
`[[homey:app:com.athom.homeyscript|DaysUntilPostalDelivery]]`, which is only safe
because Homey substitutes them before the script sees the argument. Removing the
two trash tokens by exact text leaves the separators intact.

Display 9 carries the sunrise and sunset times. They come from Homey's own cron
manager as `[[homey:manager:cron|sunrise]]` and `|sunset`, already formatted as
local `HH:MM`, so unlike times the script works out itself they need no timezone
handling. Note that those token strings contain a pipe, which is also the
argument separator: that is safe only because Homey substitutes the tokens before
the script sees the argument, and neither value ever contains a pipe.

Display 11 also drives its own LED. The Flow hangs an alarm check off the
Display 11 template card and sends the app's new "Flash the LED" action either
with a duration, when something is out of bounds, or with zero minutes to switch
it off.

That check used to evaluate the sensors a second time, and on 31 August it
produced exactly the contradiction it was supposed to prevent: the panel showed
an eleven minute old render saying "Alla OK" while the lamp flashed for a fridge
at 7.8 °C. The lamp was right and the screen was stale, but from the outside it
looked like the lamp was wrong.

It is now built the way Display 08 is. The template script publishes the
deviations it actually drew into `vibble_drawn_sig`, and both the LED condition
and the acknowledgement read that instead of the sensors. One source, so they
cannot drift apart - and the signature that gets acknowledged is by construction
the one that was on the screen when the button was pressed.

Do not expect the lamp to be prompt. Commands to a tag travel the same queue as
image data and are only handed over when the tag next checks in, which the AP's
`maxsleep` caps at sixty minutes. Measured here: 45 s to light and 30 s to
extinguish while the AP's web interface was open (which suspends tag sleep), but
an hour is the worst case with nobody watching.

## Acknowledging an alarm with the button

Display 11's tag type lists both `led` and `button`. Pressing the button wakes
the tag, so it checks in immediately and reports the press; that is the one path
that is not delayed by the sleep schedule.

The Flow treats a press as "I have seen this", not as "switch the lamp off". It
copies `vibble_drawn_sig` - the sorted names of whatever the panel last drew as
out of bounds - into `vibble_ack_sig`, and the condition that decides whether to
flash compares the newly drawn signature against it:

- signature empty: nothing is wrong, the acknowledgement is cleared so a later
  alarm counts as new, and the lamp is switched off
- signature equals the stored one: already acknowledged, do not flash
- anything else: a new alarm, or a different set of appliances, so flash

The flash pattern is short, twenty minutes, and is re-armed on every write to
Display 11. Acknowledging therefore stops the re-arming and the lamp dies out on
its own rather than depending on a prompt downlink.

What it does:

- reads the temperatures, heat pumps and Home Connect appliances straight from
  the device capabilities
- tells a running appliance from a merely selected one by whether
  `bshc_string.remaining_time` is still being written, not by
  `bshc_string.progress`; measured on a dryer mid-programme, progress froze at
  "0%" when the programme started while remaining_time counted down once a
  minute, and a dishwasher that was only selected still held a 21-hour-old
  remaining_time
- derives the 24 h outdoor max/min as the median across three independent
  outdoor sources, so one flaky sensor cannot skew it
- flags cold storage outside its limits (fridge at or above 7 °C, freezer warmer
  than −16 °C) and lists the offenders in red in the right-hand column
- formats every clock time in Homey's own timezone, because HomeyScript itself
  runs in UTC

The Flow updates the panel every 15 minutes, on a genuine cold-storage threshold
crossing in either direction, and when an appliance programme starts. Two
HomeyScript condition cards keep the e-paper from being rewritten too often: one
compares the current set of out-of-bounds appliances with the previous set and
passes only on a real change, the other enforces a minimum gap between
appliance-driven updates.

## When the AP actually redraws a panel

Uploading a template does not redraw anything, and this is worth knowing before
trusting a board. Measured over a night and a morning:

- `/jsonupload` stores the template and the AP compares it with what the tag
  already holds. A materially different template is queued (`pending` becomes 1);
  one that differs only in, say, the clock line is dropped silently and `pending`
  stays 0.
- A queued update is rendered and delivered at the tag's **next check-in**, not
  on upload. `maxsleep` is 60 minutes here, so that is the worst-case lag, and
  between `sleeptime1` 23:00 and `sleeptime2` 05:00 the tags sleep for hours.
- The `.raw` file's mtime, which the AP serves as its ETag, is therefore the only
  honest answer to "what is on the panel". The stored `.json` is what *will* be
  on it, eventually.

The practical consequence: a board can sit for hours showing an older render
while a newer template waits, and a small numeric change may never be drawn at
all. That is an accepted trade for battery life, but any verification has to read
the framebuffer rather than the template, and has to refuse to report on an
unchanged one.

## Font geometry, measured rather than estimated

Text placement used to be guessed from an average characters-per-pixel figure.
It no longer has to be: the AP serves its own font files, so the exact metrics
are readable.

Fetch them with `/edit?download=/fonts/bahnschrift30.vlw`. A plain GET on the
path returns **404 with a zero-length body**, which is the same trap that made
`/log.txt` look empty - the file is there, the direct path just is not served.

A `.vlw` is six big-endian int32 of header (glyph count, version, size, mbox
height, ascent, descent) then seven int32 per glyph: codepoint, height, width,
advance, topExtent, leftExtent, padding.

For **bahnschrift30**: ascent 21, descent 6. The renderer puts the baseline at
`y + ascent`, so a glyph's ink runs

    inkTop    = y + 21 - topExtent
    inkBottom = inkTop + height - 1

Two consequences that are easy to get wrong:

- **`y` is not the top of the ink.** Any glyph with a `topExtent` above 21
  reaches *above* `y`. `å` (topExtent 25) starts 4 px above it, `Ö` (26) starts
  5 px above. A heading at `y=4` therefore puts the ring of "Måndag" on row 0.
- **The font has no space glyph at all.** U+0020 is absent, and the renderer
  substitutes an advance of **7 px**. Solved by measuring the old
  "Status för Vibble" heading on the panel and subtracting the summed advances;
  the same measurement predicted the left side bearing to the pixel.

### Correction: bahnschrift30 does have Å, Ä and Ö

An earlier note here claimed capital Ö rendered as a bare O, and Display 07's
heading was written mixed-case as "Dörrar" to work around it. **That was wrong.**
The font carries Ö at 15x26 against O's 15x21, and on the glyph probe the Ö in
"DÖRRAR" began exactly 5 px above the D in the same string - dots present,
model confirmed on every one of the six glyphs.

What actually happened is the mechanism above: the dots sit 5 px above the draw
point, so in the probe they overlapped the label line drawn just above and my
crop cut them off. I read a clipped image as a missing glyph. Display 07 could
use full caps; it is left mixed-case only because nobody asked for it to change.

## Display 07 - the door board

Eight exterior doors in two columns of four, plus a summary line. Open is red and
closed is black, so the question the board exists to answer is legible from
across the room without reading a word.

The two doors that also have a lock report the lock instead of "Stängd": "Låst"
in black, "Olåst" in red, because an unlocked front door is worth noticing. The
toilet door has a contact too but is left out - it is an interior door that
stands open most of the time, which would make "1 öppen" permanent noise.

The LED reads `doors_alert`, published by the template script, on the same
principle as Displays 08 and 11.

`Uppdatera displayer` needed no change. Its Display 07 card turned out to be
unreachable: nothing feeds it and it feeds nothing, one of three orphaned cards
in that flow. Reachability was checked by walking the graph from every trigger
and the start card. So the board took the panel over without that flow being
touched at all.

## Display 12 - energy, water and today's cost

400x300 with `rotatebuffer=0`, so this one is authored upright rather than in
landscape like the 2.9" panels. Updated hourly.

Cost comes from "Elmätare Totalpris", not "Elmätare Tibberpris". Totalpris
includes grid fee and tax and is what actually leaves the account; the two differ
by roughly 70 kr a day, so it is not a detail.

### Peak power is already measured, and not by us

Power-by-the-Hour keeps `measure_watt_max.day/.month/.year`, and it sees every
reading the meter sends - the Tibber Pulse reports every few seconds, so a
ten-second spike is caught. A Flow polling on an interval would see less, not
more, and would run thousands of times a day to do it.

The *time* of the peak comes free: a maximum is only written when the record is
beaten, so the capability's `lastUpdated` is when it happened.

### The monthly peak hourly mean is tracked, not queried

kWh in one hour is the same number as the average kW across that hour, which is
what a Swedish effektavgift is based on where one applies.

Insights can answer this, but measurement showed it cannot be trusted to: asked
for `thisMonth` over one day it returned 24 hourly points, but asked for
`last31Days` it returned 124 points for 31 days - six-hour averages, which would
understate an hourly peak badly. So Insights seeds the figure once when the month
turns, and after that the running maximum is kept exactly in `vibble_peak_hour`,
compared against `meter_kwh_last_hour` on every hourly run.

Worth knowing: Gotlands Elnät has paused introducing an effektavgift, pending
Energimarknadsinspektionen, after the government stopped the 2027 requirement. So
this figure is a preparation rather than a bill today.

### Phases are shown in amperes

Only the Tibber Pulse measures per phase, and only current. Converting to watts
would mean inventing a power factor, so the amperes are shown as measured. The
imbalance is interesting in itself.

### Water

`meter_watertoday` in litres straight from the Quandify meter - note its Homey
name has a trailing space, `"Inkommande vatten "`, which is enough to make an
exact-name lookup fail. Yesterday comes from the Power-by-the-Hour companion in
cubic metres.

The companion's money fields are deliberately not shown: they read 363 kr for 172
litres against a 52,61 kr/m³ tariff, which cannot be right.

## Absence mode

Nothing is written to any panel while the house is empty. A "no one is at home"
condition sits between each template card and the card that writes to the panel:
five of them, four in "Status för Vibble" and one in "Robotstatus Display 08".
Nobody home is a dead end; someone home behaves exactly as before.

It goes *after* the template rather than before it for two reasons. One rewire
per screen instead of rewiring every trigger that feeds the template, and it also
catches the LED, which hangs off the write card on screens 08 and 11. The lamp is
therefore not armed while the house is empty either - which is deliberate. A
queued LED command would be delivered at the next check-in and flash at nobody,
for an hour, on battery.

"Hemkomst - uppdatera alla skärmar" fires on Homey's own "the first person came
home" and calls all four board flows. The start card in "Status för Vibble"
already fans out to its four screen chains, so one call refreshes 9, 10, 11 and
14; the door, robot and energy boards are called alongside it. The lamps are
armed in the same pass.

One honest caveat: the screen and the lamp still travel the normal queue, so they
land at the tag's next check-in rather than the moment the door opens.

A benign side effect worth knowing: if the lamp was flashing when the last person
left and the alarm clears while the house is empty, no "off" is sent - but the
pattern only runs twenty minutes and is not re-armed, so it dies out by itself.

## Display 08 - the robot board

Three columns: Hubert the mower, Olof the vacuum, and the car charger. Layout
chosen by rendering five candidates on the real panel and measuring the ink:

- one column with the state in bahnschrift30 fits every state name but wastes the
  width
- three columns with the state large clips "Parkerad i basen" and "Söker
  laddare"; at 384 px a column holds about eight characters of bahnschrift30
- three columns with the *name* large and the state smaller still clips the
  longest state names
- three columns with a **key figure** large, the name above it and the state
  below, fits everything with room to spare

So each robot shows one number that carries at a distance: battery percent for
Hubert, kWh for the charger, and when he last ran for Olof - in words, "idag" and
"igår", with a date before that. Olof has no battery capability at all, which is
why he gets a date rather than a percentage.

The charger deliberately shows `meter_power.lastCharge` in kWh rather than
`measure_power` in kW. The board updates rarely, so an instantaneous power reading
says little, while accumulated energy stays meaningful for hours.

`fit()` truncates every string to the measured column capacity, because an
overrun is drawn straight through the divider rather than clipped.

### The LED cannot disagree with the screen

On Display 11 the lamp and the board are computed by two separate scripts, and
when the panel showed a stale render the two contradicted each other - the lamp
was right and the screen was hours old. Display 08 avoids that by construction:
the template script writes what it actually drew into the `robot_fault` global,
and the LED condition only reads it. One source, no drift.

Red, and therefore flashing, when: Hubert reports ERROR/FATAL_ERROR, a non-`---`
error code or under 20 % battery; Olof is in state 3 or has any alarm set; the
charger is in Error or Offline.

### The right button starts Olof

The tag type lists both `led` and `button`, and Display 08 has two buttons.
Measured mapping, from presses timed against `/get_db` and the AP websocket:

| Button | `wakeupReason` | |
|---|---|---|
| Right | 4 | starts Olof |
| Left | 5 | unused, reserved |

End to end a press reaches a running Flow in well under two seconds: the press
wakes the tag, it checks in immediately, and the AP broadcasts it on the same
second. That is the one path not subject to the sleep schedule.

The Homey trigger fires for either button and the token syntax for reading which
one is unproven here, so the condition asks the AP directly instead: it reads
`wakeupReason` from `/get_db` and requires 4, on a check-in less than 45 seconds
old.

Three guards on top, because a vacuum cleaner starting by accident is an
unpleasant surprise:

1. Olof must be home - `operational_state` 65 (charging) or 66 (docked), so a
   press cannot restart him while he is stuck somewhere on the floor
2. no alarm active
3. at least five minutes since the last accepted press

The starting itself is delegated to the existing "Starta Olof" flow, which already
checks that the job mode is idle and records the date in "Senaste dammsugning
övervåning". None of that logic is duplicated and that flow is not modified.
