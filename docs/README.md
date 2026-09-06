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

## kylfrys-larm.homeyscript.js - the cold storage alarm

Seven near-identical Flows, one per fridge and freezer, replaced by one. They
were copies of two templates - the same card ids appear in all of them - and
between them they sent an alarm for **every reported value** over the threshold.
The Shelly Pill sensors change 70 to 320 times per six hours, and each alarm was
up to three notifications, which is where the storm came from.

### What the old ones did, and what came across

| | Fridges | Freezers |
|---|---|---|
| critical push | > 12 | > -6 |
| message + speech | > 10 | > -12 |
| low | < 0 | none |

The alarm paths are unchanged and still shared: `Skicka meddelande` (called by 41
Flows) and `Spela text i allmäna högtalare` (14 Flows, seven TTS speakers, and
still only between 08:00 and 19:00). The thresholds carried over as they were,
and the display boards were changed to match them rather than the other way
round - see below.

Four bugs were found in the old Flows while reading them. None came across:

- **Three Flows reported the wrong device's temperature.** Halv kyl and Ölkyl
  both embedded `Kylskåp`'s temperature token in their message text, and Halv
  frysbox embedded the cellar freezer's. An alarm about the beer fridge showed
  the kitchen fridge's degrees.
- **`Kyl - Kök` said "hög" in its low branch** - below 0 degrees reported
  "Temperatur i kökets kyl hög!".
- **`Frys - Förråd Stort` had a duplicated speech string**, repeating the whole
  phrase after the temperature.
- **The freezers had no low bound at all** while the fridges did.

### The thresholds live in Logic variables

Six of them, one pair per category shared by every unit in it - not per device:

| | `hög` (warning) | `kritisk` | `låg` |
|---|---|---|---|
| `Kyl larm ...` | 10 | 12 | 1 |
| `Frys larm ...` | -12 | -6 | -31 |

Both the alarm script and the display script read these, so tuning one in the app
moves the board and the notification together and they cannot drift apart. The
literals in the code are only a fallback for a renamed or deleted variable.

### The five minute delay

A temperature has to stay outside its limit for five minutes before anything is
sent, so that opening a door does not wake anyone. It applies to **every**
threshold - warning and critical, high and low - because the reasoning is the
same for all of them: a brief excursion is not a fault. That is an
interpretation, not something that was asked for explicitly.

Three things make it hold up:

- **Fluctuation does not restart the clock.** `since` is the moment a unit
  entered the band and is carried over untouched while it stays there, including
  when it moves between warning and critical.
- **Nor does a brief dip back inside.** A unit that drops back within limits is
  not forgotten immediately; the entry is kept, marked with when it left, and
  discarded only once it has stayed inside for a full five minutes. Without this,
  a unit oscillating around its threshold - which is exactly what a compressor
  cycle does - would never accumulate five continuous minutes and would never
  alarm however bad it got.
- **A unit that goes out of bounds and then stops reporting still alarms.** The
  periodic trigger re-evaluates every unit from its last known value regardless
  of whether anything reported, which is why that trigger is once a minute rather
  than once every five: at five, the worst case alarm latency would be ten.

The delay also gates the breakthrough rule below. A newly out-of-bounds unit has
to wait out its own five minutes before it can interrupt the pause - otherwise
the delay would do nothing whenever something else was already alarming.

### The pause

Global, not per device: one alarm at a time however many units are out of
bounds, and the message names all of them - "Kyl halv 11 grader och Frys stående
minus 5 grader" rather than two separate alarms, so a unit going warm can never
be silenced by another that alarmed a moment earlier.

Repeats of the same situation escalate: 1 minute, then 5, 15, 30, and 30 from
then on. A situation that gets **worse** ignores that entirely and alarms
immediately - a device newly out of bounds, or one crossing from warning to
critical. Getting better does not: a unit recovering, or dropping from critical
back to warning, is not worth waking anyone for, and letting it reset the timer
would mean a unit oscillating between two levels alarmed forever.

**Hysteresis is what makes the breakthrough safe.** A device enters alarm at the
threshold and only leaves it a full degree past, so a sensor sitting on the line
cannot flip in and out and break through the pause on every reading. Without it
the breakthrough rule would defeat the pause it is supposed to complement. This
matters here: Frys stående cycles across its threshold on a 45-minute compressor
rhythm.

State lives in `kylfrys_larm_state` in the global store, with `kylfrys_send` and
`kylfrys_kritisk` published alongside it. The Flow gates on those two rather than
on the returned string, because a condition card cannot read another card's
return value - only the global store is shared between them.

### Thresholds are now the same on the boards

The display used to use its own, tighter numbers - fridge >= 7, freezer > -16 -
which meant the panel called things deviations that never produced an alarm. It
now reads the same six Logic variables.

Note that the board has no delay: it shows a unit as deviating as soon as it is
outside the limits, while the alarm waits five minutes. That is deliberate - a
board is glanced at, not pushed at someone - but it does mean the panel can show
a deviation that never becomes a notification. Two levels: the warning level is what makes
a row red and counts towards the deviation total, and the critical level marks
the name with `!` and sorts it to the top, so that when the list is truncated the
worst survive. The summary line is left as a plain count deliberately - on
Display 14 that column is 143 px and "2 avvikelser, 1 kritisk" needs 168 px in
t0_14b_tf, so the `!` carries the severity in the space that exists.

The LED follows automatically: it reads what the board published, not the
sensors.

### Why the freezer low alarm is -31 and not -25

-25 was proposed first. Measurement said it sits **inside normal operation**:
Frys halv runs below it for 55-64% of the time and reaches -28.8, and Frys
stående dips to -26.4 on every compressor cycle - 31 separate excursions in 24
hours. It would have alarmed permanently.

-31 gives zero hits for all four, at both 6 and 24 hour resolution:

| | coldest in 24 h | margin to -31 | below -25 | below -31 |
|---|---|---|---|---|
| Frys halv | -28.8 | 2.2 | 55-64% of the time | never |
| Frys stående | -26.2 | 4.8 | 17%, 31 excursions | never |
| Frys (källare) | -24.4 | 6.6 | never | never |
| Frys liggande | -23.3 | 7.7 | never | never |

The cost of one shared number rather than one per unit: for Frys liggande, which
floors at -23.3, **-31 sits nearly eight degrees below normal and will in
practice never fire**. That unit has no meaningful low protection. It is a
deliberate trade for having one number per category.

The fridge low alarm at 1 degree is safe by a wider margin - the coldest fridge
reading in 24 hours was Ölkyl at 2.6.

### Two things this surfaced

**`Frys temperatur` has been frozen on -24.4 for 15 days** while reporting
`available: true`, exactly like the Easee charger. The cellar freezer has had no
working alarm for two weeks. The script reports a sensor that has not changed in
12 hours alongside any alarm it sends; setting `ALARM_ON_STALE` to true would
make a dead sensor raise an alarm on its own, which is off by default because it
would start nagging immediately.

**Frys stående reached -3.7 degrees for about three minutes** on 6 September,
well past the critical threshold, in the middle of an otherwise clean 45-minute
compressor cycle between -26 and -17. Most likely a door left open. Worth knowing
that it happens.

## The Shelly app migration

Shelly moved to a new Homey app and five devices were re-added under it. This is
not about the fridges and freezers, though it looked as if it might be.

### Which five, and how the pairing was proved

They are PM Mini G3 **energy meters**, not temperature sensors. The five Pill
sensors that the cold-storage system reads were already on the new app.

| MAC | Original (`cloud.shelly:shelly`) | New (`cloud.shelly.control:shellypmminig3_local`) |
|---|---|---|
| `54320453dd30` | Entre värmepump energi | 192.168.111.31 |
| `dcda0cb619d8` | Tvättmaskin energi | 192.168.110.64 |
| `dcda0ce98fe8` | Badrum golvvärme energi | 192.168.111.135 |
| `5432045af374` | Torktumlare energi | 192.168.110.69 |
| `54320452de50` | Gillestuga värmepump energi | 192.168.111.157 |

Paired on hardware, not on names, and on three independent things:

- **MAC.** The old driver stores an mDNS host in `data.id`
  (`ShellyPMMiniG3-DCDA0CB619D8.local`); the new one stores
  `settings._shelly_device_id` (`shellypmminig3-dcda0cb619d8`). Same hex.
- **IP.** Old `settings.address` against new `settings._shelly_ip`.
- **Live reading.** Both report the same meter value to three decimals, e.g.
  3060.36 against 3060.356 kWh. They are reading the same physical meter.

Seven other Shelly devices have no new counterpart and were left alone.

### The cold storage system is not involved

Checked explicitly rather than assumed: all ten device ids, old and new, were
searched for in `Kyl och frys - larm`, `Status för Vibble`, `Robotstatus Display
08`, `Dörrstatus Display 07` and `Uppdatera displayer`. **Zero matches in all
five.** The overlap between the seven cold-storage devices and the migration is
nil.

Worth planning for separately: `Kylskåp temperatur` and `Frys temperatur` - two
of the seven - are BLE sensors still on the **old** app
(`cloud.shelly:shelly_bluetooth`). Uninstalling the old app would take them with
it, and the cold-storage alarm would lose two units.

### What depends on the old five

| | Count | Field |
|---|---|---|
| Power by the Hour "Totalpris" | 5 | `settings.homey_device_id` |
| Power Profiler | 3 | `settings.monitoredDeviceId` |
| Flow "Starta om Bosch-Siemens app" | 2 cards | trigger id |

No HomeyScript, no Logic variables, no name-based lookups, and nothing in this
repo. The trigger card `measure_power_threshold_above_duration` exists on the new
devices with identical arguments, so it swaps one for one.

### The risk: the new driver has no plain `meter_power`

It exposes `meter_power.total`, `.imported` and `.exported` instead. All five
Power by the Hour devices run with `use_measure_source: false`, meaning they read
the **cumulative meter**, and they carry years of cost history - Gillestuga alone
holds 7306.5 kWh as its year start and 5697 kr for the year.

Of the 27 Power by the Hour devices on this Homey, **26 source from a device that
has a plain `meter_power`**. There is no existing example proving the app can
read `meter_power.total`, which is why this is being done one device at a time.

### Badrum golvvärme: migrated, not yet confirmed

Done on 2026-09-06: Power by the Hour and the Power Profiler repointed, the new
device moved to Badrum and given the original's name, the original renamed
`Badrum golvvärme energi Legacy`. Nothing deleted.

Verified immediately: no other flow changed, no other device renamed or moved,
all four devices `available` with no warning, and **none of Power by the Hour's
accumulated counters moved** - meter starts and money totals identical before and
after, including across a deliberate restart of the app.

One reference to the old id remains, in the Power by the Hour device's own
`data.id` (`PH_power_f332f1a1-..._f9c96f`). That is its immutable identity from
when it was created, not a live lookup - `settings.homey_device_id` is what it
reads - and changing it would mean re-pairing and losing the history.

**What is not confirmed is whether Power by the Hour actually counts from the new
source**, and that is a flaw in the choice of test device: Badrum was picked for
having the least valuable history, without checking whether it produces
observable data. It draws 0 W, its meter last moved on 2026-09-03 22:00, and
Power by the Hour only writes `meter_latest` when the source meter changes -
restarting the app did not make it re-read. So the test subject cannot answer the
question until the bathroom floor next draws power.

The signal to watch is `meter_latest` on `Badrum golvvärme totalpris` changing
from `809.49` to a three-decimal value like `809.487`, or `kWh denna dag` leaving
zero. A device with a standing draw - Torktumlare at 1.6 W moves the fourth
decimal within the hour - would have answered the same question in an afternoon.

## Reading the AP

We have gone looking for this twice and got it wrong both times, so it is written
down here.

### Files: use the editor endpoint, not the path

A plain GET on a stored file returns **404 with a zero-length body**. That is not
"the file is empty" and not "the endpoint does not exist" - it reads exactly like
an empty file if you only look at the body length, which is how `/log.txt` got
reported as 0 bytes when the directory listing plainly showed 8 KB.

    curl "http://<ap>/log.txt"                      -> 404, 0 bytes
    curl "http://<ap>/edit?download=/log.txt"       -> 200, the file

`/edit?list=/` walks the filesystem and takes a directory (URL-encode the slash:
`/edit?list=%2Fcurrent`). Between them these reach everything: `/log.txt`,
`/logold.txt`, `/fonts/*.vlw`, `/current/*.json`, `/current/*.raw`,
`/tagtypes/*.json`. Always check the status code, not just the body length.

### `log.txt` is thinner than it sounds

It logs AP lifecycle only, and nothing about tags at all:

- `http getJsonTemplateUrl` - with no MAC, no URL and no result
- `Reboot. Reason: Panic | Task Watchdog | Software`, and `Nightly reboot`
- `WiFi connection lost` / `Unable to connect to WiFi` /
  `Starting configuration AP` / `Attempting to reconnect to WiFi.`

There are no check-ins, no renders, no queue events and no per-tag errors. It
could not have answered any of the questions we have actually had, except "did
the AP reboot or lose WiFi". Two further caveats: the level is **not adjustable**
- `/get_ap_config` exposes no log-level key - and the ordering is not reliable,
since a reboot line can appear timestamped before entries that precede it.

Rotation is `log.txt` -> `logold.txt` and then discard, at roughly 8-10 KB each,
so about 400 lines of history in total. That is bound by event count, not by
time: it happened to span five days here only because the AP was quiet.

### The websocket is the real instrument

`ws://<ap>/ws` is a live feed and carries considerably more than the file does.
Three kinds of message:

- `logMsg` - the whole render-and-deliver trace, none of which ever reaches
  `log.txt`:

      Updating ABCD0000000000B3
      new image: /current/ABCD0000000000B3_218908.pending
      ABCD0000000000B3 block request /current/..._218908.pending block 0, len 4096 checksum 17486
      ABCD0000000000B3 reports xfer complete

  plus the AP's own content generators (`get weather`, `get dayahead prices`).
- `tags` - the **complete tag record** on every check-in: `pending`, `LQI`,
  `RSSI`, `batteryMv`, `temperature`, `wakeupReason`, `nextcheckin`,
  `updatecount`, `updatelast`, `hash`.
- `upload` - `{"src":"<MAC>","current":1,"total":2}`, block-by-block transfer
  progress.
- `sys` - every few seconds: `heap`, `uptime`, `recordcount`, `dbsize`,
  `littlefsfree`, `psfree`, `apstate`, `runstate`, WiFi `rssi`/`ssid`/`status`,
  and periodically `lowbattcount` and `timeoutcount`. A drop in `uptime` is how
  an AP reboot was caught in the act.

### A `tags` broadcast is not a check-in

This one cost an hour and a wrong conclusion, so it is worth being blunt about. A
`tags` message is emitted whenever the AP's **record** for a tag changes - which
includes queueing an image for a tag that is not there - and the radio fields it
carries are the values stored at the tag's last real contact, not fresh readings.

After an AP reboot, Displays 07 and 08 both appeared in the feed with plausible
LQI, RSSI, battery and temperature, and `pending` climbing 0 -> 1 -> 2. It looked
exactly like two long-silent tags coming back to life. They had not: their
`lastseen` never moved, and every radio field in the broadcast was byte-identical
to what the database had held since 2026-09-03 and 09-04 respectively.

**Only `lastseen` advancing proves a tag actually spoke.** A live tag also shows
`lastseen` ahead of `updatelast` once it has taken its image; on a silent tag the
two are frozen together. When it matters, confirm with the transfer trace - a
real fetch produces `Updating <MAC>`, then block requests, then
`<MAC> reports xfer complete`.

`docs/ap-watch.js` is a dependency-free client for all of this:

    node docs/ap-watch.js           follow the websocket until Ctrl-C
    node docs/ap-watch.js 120       follow for 120 s, then summarise
    node docs/ap-watch.js --tags    tag database, flagging anything gone quiet
    node docs/ap-watch.js --logs    download log.txt and logold.txt

Set `OEPL_AP` to point it at a different access point.

One more trap it works around: `/get_db?pos=` takes a **page index, not a record
offset**. Stepping it by 20 silently returns overlapping pages and drops half the
database - which briefly hid Display 11 from a listing that looked complete.

This is the tool we should have been using all along. It answers, directly and
live, most of what we have previously inferred by polling and guessing: whether a
tag checked in and exactly when, whether an image was queued and under what
filename, why a tag woke (`wakeupReason` 4 = right button, 5 = left - we built a
whole Homey test flow to learn this, and the websocket reports it in about a
second), and whether the AP itself is healthy.

## Stale panels: three tags have stopped talking

Displays 07, 08 and 11 - all M3 2.9" (`hwType` 51) - have gone silent, while
every other tag checks in within minutes. None of it is a render failure, a
template problem or anything in the Flow. For each of them `lastseen` and
`updatelast` are the same timestamp: the last time the tag spoke it took its
image, and then nothing.

| Tag | LQI at last contact | Silent for | Queue |
|---|---|---|---|
| Display 10 | 128 | checking in normally | |
| Display 09 | 116 | checking in normally | |
| Display 11 | 108 | 76.7 h | `pending` 0 |
| Display 08 | 88 | 13.2 h | `pending` 2 waiting |
| Display 07 | 80 | 38.9 h | `pending` 2 waiting |

Battery is not it - 2961 to 3060 mV at last contact - and the radio channel is
not it either, `ch` being 11 for the silent and the healthy alike. The split
falls neatly on signal strength, everything at LQI 116 and above healthy and
everything at 108 and below silent, but that is a line drawn through five points
and the order in which the three dropped out does not follow LQI. Treat it as a
hint about where to look, not a cause.

**There is no remote fix.** The protocol is tag-initiated: the AP never calls a
tag, it only answers one that wakes and polls, and `/tag_cmd` merely queues a
command for delivery at a check-in that is not happening. A stranded tag has to
be woken at the panel - a button press forces an immediate check-in - or have its
battery reseated. Two of the three already have an image queued and will take it
the moment they speak.

Worth recording separately, because it may or may not be related: the AP is not
healthy. Across the two log files, in five days, **four `Task Watchdog` reboots
and two `Panic` reboots**, plus two WiFi dropouts on 2026-09-02 where it fell
back to its configuration AP. The 03:56 nightly reboot is deliberate and not part
of that count. Whether the crashes and the silent tags share a cause is not
established.

If a panel looks stale again, the order is: `node docs/ap-watch.js --tags` for
`lastseen`, then `--logs` for reboot reasons, and only then suspect anything in
this repo.

## When the AP actually redraws a panel

Uploading a template does not redraw anything, and this is worth knowing before
trusting a board. Measured over a night and a morning:

- `/jsonupload` stores the template and the AP compares it with what the tag
  already holds. A materially different template is queued (`pending` becomes 1);
  one that differs only in, say, the clock line is dropped silently and `pending`
  stays 0.
- A queued update is rendered and delivered at the tag's **next check-in**, not
  on upload. `maxsleep` is 30 minutes in the current AP config (it was recorded
  as 60 here earlier; read `/get_ap_config` rather than trusting this line), so
  that is the worst-case lag, and between `sleeptime1` 23:00 and `sleeptime2`
  05:00 the tags sleep for hours.
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

That last one shipped first and was wrong. The columns existed to solve a width
problem, and they solved it by shrinking the state name - but the state is the
one thing worth reading. As Jonas put it, if the key figures are not the
interesting part then we had solved the wrong problem.

So the board is now **three full-width rows**, one per machine: the name small on
the left, the state large beside it, and a detail line small underneath. The
state gets 269 px, which holds "Parkerad i basen" comfortably. The detail line
carries what the key figure used to: when Olof last ran, in words ("idag",
"igår", a date before that) since he exposes no battery capability at all, when
Hubert next starts, and the charger's energy.

The charger deliberately shows `meter_power.lastCharge` in kWh rather than
`measure_power` in kW. The board updates rarely, so an instantaneous power reading
says little, while accumulated energy stays meaningful for hours.

`fit()` truncates every string to the measured column capacity, because an
overrun is drawn straight through the divider rather than clipped.

### The charger row: read the cable, not the status

The board once showed "Ingen bil" with the car sitting in the charger. Two
separate faults produced that, and both are worth writing down.

**The mapping was wrong.** The row read `charger_status` alone and mapped
`Standby` to "Ingen bil". Standby means the charger is *idle*, and it is idle
both when nothing is plugged in and when a car is connected but waiting -
finished, or scheduled for later. The status cannot tell those apart. Only
`evcharger_charging_state` can, with `plugged_out` against the four `plugged_in*`
variants, so that is now what decides whether a car is there:

| `evcharger_charging_state` | shown |
|---|---|
| `plugged_out` | Ingen bil |
| `plugged_in` | Ansluten (Fulladdad if the status says Completed) |
| `plugged_in_paused` | Ansluten, väntar (Fulladdad if Completed) |
| `plugged_in_charging` | Laddar |
| `plugged_in_discharging` | Urladdar |

`charger_status` still refines the wording and still wins outright for `Offline`
and `Error`, which describe the charger itself and say nothing trustworthy about
the cable. Measured with the car plugged in and waiting: `charger_status`
"Paused", `evcharger_charging_state` "plugged_in_paused". All 48 combinations of
the two fields were swept before deploying; none now claims "Ingen bil" while a
cable is in.

`meter_power.lastCharge` is the running total of the *current* session while one
is open and the previous session's total once it closes, resetting to 0 when a
car is plugged in. So "senast 0 kWh" would be a lie about a car that has just
been connected; the row says "inget laddat än" instead.

**The data was also frozen.** The Easee app had stopped delivering four days
earlier while Homey still reported the device `available: true`, with no warning
and the app "running". `charger_status` sat on "Standby" and
`evcharger_charging_state` on "plugged_out" since 1 September, and the board
faithfully drew what it was given. The giveaway was that
`meter_power.lastCharge` had changed to 25.16 kWh two days *after* those froze -
a charge session had completed while the charger never reported charging.
Restarting the app (`no.easee`) restored it immediately.

### Detecting that the charger data has gone stale

The row now refuses to assert when the integration is not delivering, and says
"Okänd / laddardata gammal" instead.

Getting this right needed a fact about Homey that is easy to assume wrongly:
**`lastUpdated` moves only when a capability's value CHANGES**, not on every poll.
Measured directly - two reads six minutes apart, `charger_status` unchanged and
its stamp unchanged, while `measure_voltage` moved 230 -> 232 in the same window.
So the age of a state field proves nothing: an unplugged charger legitimately
reports `plugged_out` for days.

`measure_voltage` is the usable heartbeat, because mains voltage genuinely
fluctuates. The threshold is six hours, not one: the reading is an integer and
could plausibly hold one value for a while, while the failure being guarded
against lasted four days. Verified against both - fresh data passes, a stamp from
1 September trips it, five hours passes, seven hours trips, and a missing
capability does not cry wolf.

The stale state is deliberately **not** red. `red` feeds `robot_fault`, which
drives the LED, and a quiet cloud integration is not a robot fault worth flashing
a lamp for.

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
