#!/usr/bin/env node
//
// Live view of what the OpenEPaperLink AP is doing.
//
//   node docs/ap-watch.js               follow the websocket until Ctrl-C
//   node docs/ap-watch.js 120           follow for 120 seconds, then summarise
//   node docs/ap-watch.js --logs        download log.txt and logold.txt instead
//   node docs/ap-watch.js --tags        print the tag database and stop
//
// Why this exists: /log.txt records AP lifecycle only - reboots, WiFi loss,
// getJsonTemplateUrl - and nothing whatsoever about tags. The websocket carries
// per-tag check-ins, queueing events and AP health, and it is the only way to
// see any of that. See "Reading the AP" in README.md.
//
// No dependencies: the websocket client is hand-rolled RFC6455. Server-to-client
// frames are unmasked, so the parser is short. Continuation frames are not
// handled because the AP does not send them.

const net = require('net');
const http = require('http');
const crypto = require('crypto');

const AP = process.env.OEPL_AP || '192.168.111.179';

// Only for readability in the output; unknown MACs print as themselves.
const NAMES = {
  '000001814DDE3B39': 'Display 01', '0000018143733B30': 'Display 02',
  ABCD00000000010A: 'Display 03', ABCD0000000000B3: 'Display 04',
  ABCD000000000031: 'Display 05', ABCD000000000113: 'Display 06',
  '00007E23909BB293': 'Display 07', '00007E1FB84FB29F': 'Display 08',
  '0000057CCBB6B294': 'Display 09', '000004F16309B296': 'Display 10',
  '000004F01C38B29D': 'Display 11', F0CACAC80732E141: 'Display 12',
  F4CFC7CAE3320741: 'Display 13', F5CACAC83E325D41: 'Display 14',
  F5CFC7CA1332EB41: 'Display 15', F8CFC7CADB32B741: 'Display 16',
};
const name = (mac) => NAMES[mac] || mac;
const clock = (t) => (t ? new Date(t * 1000).toLocaleString('sv-SE') : '-');
const WAKEUP = {
  0: 'timer', 1: 'boot', 2: 'GPIO', 3: 'NFC', 4: 'HOGER KNAPP', 5: 'VANSTER KNAPP',
};

function fetch(path) {
  return new Promise((resolve) => {
    const r = http.get({ host: AP, path, timeout: 20000 }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(c) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ err: 'timeout' }); });
    r.on('error', (e) => resolve({ err: e.code || e.message }));
  });
}

// --- file mode -------------------------------------------------------------
// A plain GET on a stored path returns 404 with an empty body, which reads
// exactly like an empty file. The editor endpoint is what actually serves it.
async function download(file) {
  const r = await fetch(`/edit?download=${encodeURIComponent(file)}`);
  if (r.err) return `${file}: ${r.err}`;
  if (r.status !== 200) return `${file}: HTTP ${r.status}`;
  return `\n=== ${file} (${r.buf.length} B) ===\n${r.buf.toString('utf8')}`;
}

// --- tag database ----------------------------------------------------------
// get_db takes a *page* index, not a record offset. Walk pages until one adds
// nothing new, then dedupe by MAC.
async function tagDb() {
  const byMac = new Map();
  for (let pos = 0; pos < 12; pos++) {
    const r = await fetch(`/get_db?pos=${pos}`);
    let j; try { j = JSON.parse(r.buf.toString('utf8')); } catch (e) { break; }
    if (!j.tags || !j.tags.length) break;
    const before = byMac.size;
    for (const t of j.tags) byMac.set(t.mac, t);
    if (byMac.size === before && pos > 0) break;
  }
  return [...byMac.values()];
}

async function printTags() {
  const tags = await tagDb();
  const now = Math.floor(Date.now() / 1000);
  tags.sort((a, b) => (b.lastseen || 0) - (a.lastseen || 0));
  console.log(`${tags.length} taggar\n`);
  console.log('MAC              namn        hw  pend  lastseen             timmar');
  for (const t of tags) {
    const h = (now - (t.lastseen || 0)) / 3600;
    // Three hours is comfortably more than maxsleep plus the night sleep, so
    // anything past it has genuinely stopped talking rather than being asleep.
    const flag = h > 3 ? '  <== TYST' : '';
    console.log(`${t.mac} ${name(t.mac).padEnd(11)} ${String(t.hwType).padStart(3)} ${String(t.pending).padStart(5)}  ${clock(t.lastseen)}  ${h.toFixed(1).padStart(6)}${flag}`);
  }
}

// --- websocket -------------------------------------------------------------
function follow(seconds) {
  const seen = new Map();      // counted check-ins, i.e. lastseen actually moved
  const lastseen = new Map();  // last value per MAC, to tell those apart
  const kinds = new Map();
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(80, AP, () => {
    sock.write([
      'GET /ws HTTP/1.1', `Host: ${AP}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
  });

  const stamp = () => new Date().toLocaleTimeString('sv-SE');
  let buf = Buffer.alloc(0);
  let up = false;

  function text(s) {
    let j; try { j = JSON.parse(s); } catch (e) { console.log(`${stamp()} [icke-json] ${s.slice(0, 200)}`); return; }
    for (const k of Object.keys(j)) kinds.set(k, (kinds.get(k) || 0) + 1);
    if (j.tags) {
      for (const t of j.tags) {
        // A tags message fires on any record change, including queueing an image
        // for a tag that is not there, and its radio fields are the values from
        // the last real contact. Only lastseen advancing proves the tag spoke.
        const prev = lastseen.get(t.mac);
        const fresh = prev === undefined ? null : t.lastseen > prev;
        lastseen.set(t.mac, t.lastseen);
        if (fresh) seen.set(t.mac, (seen.get(t.mac) || 0) + 1);
        const w = WAKEUP[t.wakeupReason] || t.wakeupReason;
        const tag = fresh === null ? 'TAGG ?' : (fresh ? 'INCHK ' : 'poster');
        const note = fresh === false ? '  (ingen kontakt - bara postandring)' : '';
        console.log(`${stamp()} ${tag} ${name(t.mac).padEnd(11)} pending=${t.pending} wake=${w} LQI=${t.LQI} RSSI=${t.RSSI} batt=${t.batteryMv}mV ${t.temperature}C sedd=${clock(t.lastseen).slice(11)}${note}`);
      }
      return;
    }
    if (j.logMsg !== undefined) { console.log(`${stamp()} LOGG  ${j.logMsg}`); return; }
    if (j.errMsg !== undefined) { console.log(`${stamp()} FEL   ${j.errMsg}`); return; }
    if (j.sys) {
      const s2 = j.sys;
      // once a minute is plenty for the housekeeping counters
      if (!follow.lastSys || Date.now() - follow.lastSys > 60000) {
        follow.lastSys = Date.now();
        console.log(`${stamp()} SYS   uptime=${s2.uptime}s heap=${s2.heap} wifi=${s2.wifissid}@${s2.rssi}dBm taggar=${s2.recordcount}${s2.timeoutcount !== undefined ? ` timeouts=${s2.timeoutcount}` : ''}${s2.lowbattcount !== undefined ? ` lagbatt=${s2.lowbattcount}` : ''}`);
      }
      return;
    }
    console.log(`${stamp()} ANNAT ${s.slice(0, 300)}`);
  }

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!up) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.slice(0, i).toString('utf8');
      if (!/ 101 /.test(head)) { console.log(head); process.exit(1); }
      console.log(`ansluten till ws://${AP}/ws`);
      up = true;
      buf = buf.slice(i + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const l0 = buf[1] & 0x7f;
      let off = 2; let len = l0;
      if (l0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (l0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 1) text(payload.toString('utf8'));
      else if (op === 8) { console.log('servern stangde'); summarise(); }
    }
  });
  sock.on('error', (e) => { console.log(`socketfel ${e.code || e.message}`); process.exit(1); });

  function summarise() {
    console.log('\n=== sammanfattning ===');
    console.log(`meddelandetyper: ${[...kinds].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log('(raknar bara incheckningar dar lastseen faktiskt flyttade sig)');
    const macs = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    for (const [mac, n] of macs) console.log(`  ${name(mac).padEnd(11)} ${n} incheckningar`);
    const quiet = Object.keys(NAMES).filter((m) => !seen.has(m));
    if (quiet.length) console.log(`  ingen kontakt: ${quiet.map(name).join(', ')}`);
    process.exit(0);
  }

  if (seconds) setTimeout(summarise, seconds * 1000);
  process.on('SIGINT', summarise);
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--logs') {
    console.log(await download('/log.txt'));
    console.log(await download('/logold.txt'));
    return;
  }
  if (arg === '--tags') { await printTags(); return; }
  follow(arg ? Number(arg) : 0);
})();
