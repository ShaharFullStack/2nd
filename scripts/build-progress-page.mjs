#!/usr/bin/env node
// Builds a self-contained progress page (progress/index.html data inlined) → argv[2] or progress/standalone.html
import fs from 'node:fs';
const log = JSON.parse(fs.readFileSync(new URL('../progress/log.json', import.meta.url), 'utf8'));
const out = process.argv[2] || new URL('../progress/standalone.html', import.meta.url).pathname;
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const pieces = Object.entries(log.pieces);
const statusClass = s => /pass|done|met/i.test(s) ? 'ok' : /fail|open|gap/i.test(s) ? 'bad' : 'run';
const html = `<title>Beat Rehab Build Log</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@500;700&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono&display=swap">
<style>
:root{--bg:#f3f1ec;--surface:#ffffff;--ink:#1a1b22;--muted:#5f6577;--line:#d9d6ce;--accent:#c77d10;--ok:#1f8f4e;--bad:#c0392b;--run:#2f6fd6}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1016;--surface:#171a22;--ink:#e9ebf2;--muted:#8b91a3;--line:#262a36;--accent:#f5b53f;--ok:#3ddc84;--bad:#ff5c5c;--run:#6ea8ff}}
:root[data-theme="dark"]{--bg:#0e1016;--surface:#171a22;--ink:#e9ebf2;--muted:#8b91a3;--line:#262a36;--accent:#f5b53f;--ok:#3ddc84;--bad:#ff5c5c;--run:#6ea8ff}
body{background:var(--bg);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;margin:0}
.wrap{max-width:960px;margin:0 auto;padding:32px 24px 64px}
h1{font:700 28px/1.1 Rubik,system-ui,sans-serif;margin:0;letter-spacing:-.01em;text-wrap:balance}
.sub{color:var(--muted);font:13px "IBM Plex Mono",monospace;margin-top:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:24px 0 32px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.tile b{font:600 14px "IBM Plex Sans",sans-serif}.tile .m{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font:600 11px "IBM Plex Mono",monospace;letter-spacing:.04em;text-transform:uppercase;padding:1px 7px;border-radius:999px;color:var(--bg)}
.pill.ok{background:var(--ok)}.pill.bad{background:var(--bad)}.pill.run{background:var(--run)}
h2{font:500 13px "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
.log{display:flex;flex-direction:column;gap:10px}
.e{display:grid;grid-template-columns:120px 1fr;gap:14px;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--run);border-radius:6px;padding:10px 14px}
.e.pass{border-left-color:var(--ok)}.e.fail{border-left-color:var(--bad)}.e.info{border-left-color:var(--line)}
.e .t{font:12px "IBM Plex Mono",monospace;color:var(--muted)}.e .p{font:600 12px "IBM Plex Mono",monospace;color:var(--accent);display:block;margin-top:4px}
.e img{max-width:100%;border:1px solid var(--line);border-radius:4px;margin-top:8px;display:block}
code{font:13px "IBM Plex Mono",monospace;background:var(--bg);padding:0 4px;border-radius:3px}
@media (max-width:600px){.e{grid-template-columns:1fr}}
</style>
<div class="wrap">
<h1>Beat Rehab build log</h1>
<div class="sub">camera-controlled rhythm rehab · last update ${esc(log.updated)} · ${log.entries.length} entries</div>
<div class="tiles">${pieces.map(([k,v])=>`<div class="tile"><b>${esc(k)}</b><span class="m">round ${v.round}</span><span><span class="pill ${statusClass(v.status)}">${esc(v.status)}</span></span></div>`).join('')||'<div class="tile"><b>no pieces judged yet</b><span class="m">critic loops start after the first build</span></div>'}</div>
<h2>Timeline, newest first</h2>
<div class="log">${log.entries.slice().reverse().map(e=>`<div class="e ${e.kind||'info'}"><div><div class="t">${esc(e.time)}</div><span class="p">${esc(e.piece)}</span></div><div>${e.text}${e.image?`<img src="${e.image}" alt="">`:''}</div></div>`).join('')}</div>
</div>`;
fs.writeFileSync(out, html);
console.log('wrote', out);
