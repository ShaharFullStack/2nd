#!/usr/bin/env node
// usage: node scripts/progress-log.mjs <piece> <kind:pass|fail|info> "<text>" [imagePath] [round] [status]
import fs from 'node:fs';
const [,, piece, kind, text, image, round, status] = process.argv;
const f = new URL('../progress/log.json', import.meta.url);
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
const time = new Date().toISOString().slice(0,16)+'Z';
d.updated = time;
d.entries.push({ time, piece, kind, text, image: image || undefined });
if (round || status) { d.pieces[piece] = { round: Number(round || (d.pieces[piece]?.round ?? 0)), status: status || d.pieces[piece]?.status || 'in progress', note: text.slice(0, 140) }; }
fs.writeFileSync(f, JSON.stringify(d, null, 1));
console.log('logged', piece, kind);
