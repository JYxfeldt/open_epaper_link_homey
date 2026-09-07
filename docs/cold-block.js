#!/usr/bin/env node
// Keeps the three copies of the cold-storage block identical.
//
//   node docs/cold-block.js check    exit 1 if any copy has drifted (default)
//   node docs/cold-block.js expand   rewrite every copy from the snippet
//
// HomeyScript has no import, so the block genuinely has to be pasted into each
// script. This is what makes "pasted" safe: the copies are generated, never
// hand-edited, and check fails loudly the moment one of them differs.
//
// A script that wants the block carries either the marker line
//   // SHARED_COLD_BLOCK
// or an already-expanded block between the BEGIN and END markers.

const fs = require('fs');
const path = require('path');

const DOCS = __dirname;
const SNIPPET = path.join(DOCS, 'cold-limits.snippet.js');
const TARGETS = [
  'status-for-vibble.homeyscript.js',
  'kylfrys-larm.homeyscript.js',
  'vibble-andringsgrind.homeyscript.js',
];

const BEGIN = '// ==== BEGIN cold-limits';
const END = '// ==== END cold-limits ====';
const MARKER = '// SHARED_COLD_BLOCK';

function canonical() {
  const src = fs.readFileSync(SNIPPET, 'utf8');
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < 0) throw new Error('snippet saknar markorer');
  return src.slice(a, b + END.length);
}

// Any bare threshold literal outside the block is the bug this guards against.
// 7 and -16 are the values the change gate had drifted to; the rest are the six
// real limits. Seeing one of them in a cold-storage context outside the block
// means a fourth copy has appeared.
const STRAY = /(?:^|[^\w.])(?:>=?|<=?)\s*-?(?:7|16|10|12|31|6)\b/;

function split(text) {
  const a = text.indexOf(BEGIN);
  if (a < 0) return null;
  const b = text.indexOf(END, a);
  if (b < 0) throw new Error('BEGIN utan END');
  return { before: text.slice(0, a), block: text.slice(a, b + END.length), after: text.slice(b + END.length) };
}

const block = canonical();
const mode = process.argv[2] || 'check';
let bad = 0;

for (const name of TARGETS) {
  const file = path.join(DOCS, name);
  if (!fs.existsSync(file)) { console.log(`SAKNAS  ${name}`); bad += 1; continue; }
  const text = fs.readFileSync(file, 'utf8');
  const parts = split(text);

  if (mode === 'expand') {
    let next;
    if (parts) next = parts.before + block + parts.after;
    else if (text.includes(MARKER)) next = text.replace(MARKER, block);
    else { console.log(`SAKNAS MARKOR  ${name}`); bad += 1; continue; }
    if (next !== text) { fs.writeFileSync(file, next); console.log(`skrev   ${name}`); }
    else console.log(`ororda  ${name}`);
    continue;
  }

  if (!parts) { console.log(`SAKNAR BLOCK  ${name}`); bad += 1; continue; }
  if (parts.block !== block) { console.log(`AVVIKER  ${name}`); bad += 1; continue; }

  const stray = (parts.before + parts.after)
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*)/.test(l) && /fridge|freezer|kind ===|COLD_/.test(l) && STRAY.test(l));
  if (stray.length) {
    console.log(`TROSKEL UTANFOR BLOCKET  ${name}`);
    for (const [n, l] of stray) console.log(`    ${n}: ${l.trim()}`);
    bad += 1;
    continue;
  }
  console.log(`OK      ${name}`);
}

if (bad) { console.log(`\n${bad} fil(er) stammer inte. Kor: node docs/cold-block.js expand`); process.exit(1); }
console.log('\nAlla kopior identiska.');
