/**
 * THE ENDING AND THE REPORT ARE THE SAME SESSION, TWO SECONDS APART.
 *
 * Drives a REAL session to the end of its chart in a real browser, reads the FinaleSpec out of the
 * running renderer, and compares every figure on it with the SessionResult the report is built
 * from. The session is the hard one on purpose: an autoplay run whose every movement is delivered
 * 240 ms late, which is the patient `answerRateOf` was written for — nothing scores, and the
 * patient performed every rep. Under the old card that read "0/N NOTES ANSWERED" beside a report
 * saying 94 %.
 *
 * Then it renders the WORST-CASE achievement note — the one the game shows when a movement reaches
 * the whole range calibrated for it, built through the real `sessionAchievement` — at all three
 * clinic sizes, and measures whether the clause that qualifies the percentage survived.
 *
 *   node critic/ending-figures.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = resolve(HERE, 'screenshots', 'ending');
const PORT = Number(process.env.PORT ?? 5471);
const BASE = `http://localhost:${PORT}`;
const log = (...m) => console.log('[ending]', ...m);
const failures = [];
const check = (ok, what) => { log(ok ? 'ok  ' : 'FAIL', what); if (!ok) failures.push(what); };

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server ${url} never came up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'inherit' });
  await waitForServer(BASE);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    // ---- A REAL RUN, ENDED AND REPORTED ------------------------------------------------------
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (m) => { if (m.type() === 'error') log('  page error:', m.text()); });
    await page.goto(`${BASE}/?input=autoplay&seed=7`);
    await page.waitForFunction(() => !!window.__beatRehab);
    await page.evaluate(() => window.__beatRehab.startPlayNow({ songId: 'demo-sunrise', difficulty: 'medium' }));
    await page.waitForSelector('canvas');
    await page.waitForFunction(() => !!window.__beatRehab.getRunner(), null, { timeout: 30_000 });

    // THE 240 ms-OUT PATIENT. Every scripted movement is delivered a quarter of a second late: far
    // outside any good window, well inside "the nearest note it answered".
    const shifted = await page.evaluate(() => {
      const runner = window.__beatRehab.getRunner();
      const evs = runner.input.events;
      for (const e of evs) e.songTime += 0.24;
      const hw = runner.highway;
      window.__specs = [];
      const start = hw.startFinale.bind(hw);
      const upd = hw.updateFinale.bind(hw);
      hw.startFinale = (s) => { window.__specs.push(s); start(s); };
      hw.updateFinale = (s) => { window.__specs.push(s); upd(s); };
      return evs.length;
    });
    log(`shifted ${shifted} scripted movements 240 ms late; playing the song out`);

    await page.waitForFunction(() => window.__beatRehab.getRunner()?.getPhase() === 'finale', null, { timeout: 180_000 });
    log('chart ended, the payoff is on screen');
    for (const at of [900, 1600, 2200]) {
      await page.waitForTimeout(at === 900 ? 900 : 700);
      const t = await page.evaluate(() => window.__beatRehab.getRunner()?.highway.finaleElapsed() ?? -1);
      const name = `live-1280-at-${t.toFixed(1).replace('.', 'p')}.png`;
      await page.screenshot({ path: resolve(SHOTS, name) });
      log(`  shot ${name}`);
    }
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(SHOTS, 'live-1280-late.png') });

    await page.waitForFunction(() => window.__beatRehab.getState().screen === 'results', null, { timeout: 30_000 });
    const seen = await page.evaluate(() => {
      const specs = window.__specs;
      const card = specs[specs.length - 1];
      const r = window.__beatRehab.getState().lastResult;
      const judged = r.hits + r.misses;
      const text = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        card: { stats: card.stats, achievement: card.achievement, note: card.achievementNote, score: card.score },
        report: {
          reps: r.reps, hits: r.hits, misses: r.misses, judged,
          attempted: r.lanes.reduce((n, l) => n + (l.attempted ?? 0), 0),
          answerRate: r.answerRate, score: r.score, durationSec: r.durationSec,
          laneReps: r.lanes.map((l) => l.reps),
        },
        dom: { reps: text('[data-testid="results-reps"]'), answered: text('[data-testid="results-consistency"]') },
      };
    });
    await page.screenshot({ path: resolve(SHOTS, 'live-1280-results.png'), fullPage: true });
    log('card  ', JSON.stringify(seen.card.stats));
    log('report', JSON.stringify(seen.report));
    log('dom   ', JSON.stringify(seen.dom));

    const { card, report } = seen;
    const byLabel = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
    check(byLabel.MOVEMENTS === String(report.reps), `MOVEMENTS ${byLabel.MOVEMENTS} == report's ${report.reps}`);
    check(
      byLabel['NOTES ANSWERED'] === `${report.attempted}/${report.judged}`,
      `NOTES ANSWERED ${byLabel['NOTES ANSWERED']} == the report's ${report.attempted}/${report.judged}`,
    );
    check(report.attempted > report.hits * 4 + 1, `the run really is the hard case: ${report.hits} hits, ${report.attempted} answered`);
    check(
      seen.dom.answered.includes(`for ${report.attempted} of the ${report.judged} notes offered`),
      `the Results screen prints the same count in words: "${seen.dom.answered.slice(0, 110)}"`,
    );
    check(seen.dom.reps.includes(String(report.reps)), `the Results headline prints ${report.reps} movements too`);
    const mm = Math.floor(report.durationSec / 60);
    const ss = String(Math.floor(report.durationSec % 60)).padStart(2, '0');
    check(byLabel['SONG LENGTH'] === `${mm}:${ss}`, `SONG LENGTH ${byLabel['SONG LENGTH']} == the report's ${mm}:${ss}`);
    check(card.achievement !== `${report.reps} movements performed`, 'the ribbon is not the hero figure again');
    check(!card.achievement.includes(byLabel.MOVEMENTS), `the ribbon "${card.achievement}" does not restate the hero`);
    await page.close();

    // ---- THE WORST-CASE NOTE, AT EVERY CLINIC SIZE -------------------------------------------
    for (const [w, h] of [[1024, 768], [1280, 800], [1920, 1080]]) {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.goto(`${BASE}/?input=autoplay&seed=7`);
      await p.waitForFunction(() => !!window.__beatRehab);
      await p.evaluate(() => window.__beatRehab.startPlayNow({ songId: 'demo-sunrise' }));
      await p.waitForSelector('canvas');
      await p.waitForTimeout(2500);
      const geom = await p.evaluate(() => {
        const c = document.querySelector('canvas');
        const b = c.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y), dpr: devicePixelRatio };
      });

      const drawn = await p.evaluate(async ({ g, at }) => {
        const hwMod = await import('/src/render/Highway.ts');
        const grMod = await import('/src/session/GameRunner.ts');
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(g.w * g.dpr);
        canvas.height = Math.round(g.h * g.dpr);
        canvas.style.cssText = `position:fixed;left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;z-index:99999;background:#05070f`;
        document.body.appendChild(canvas);
        const hw = new hwMod.Highway(canvas, { laneCount: 4 });
        hw.resize(g.w, g.h, g.dpr);
        // The longest note this card can be handed: the longest clinical lane names, both reaching
        // the whole range calibrated for them, two more movements behind them, and the clause.
        const ach = grMod.sessionAchievement({
          reps: 131, hits: 12, judged: 189, maxCombo: 3,
          lanes: [
            { name: 'Left Ankle dorsiflexion', bestPeak: 0.95 },
            { name: 'Right Ankle dorsiflexion', bestPeak: 0.92 },
            { name: 'Left Hip abduction', bestPeak: 0.91 },
            { name: 'Right Knee extension', bestPeak: 0.93 },
          ],
        });
        const spec = {
          title: 'SONG COMPLETE', subtitle: 'Demo Sunrise', score: 300,
          stats: [
            { value: '131', label: 'MOVEMENTS' }, { value: '178/189', label: 'NOTES ANSWERED' },
            { value: '3', label: 'LONGEST RUN' }, { value: '1:17', label: 'SONG LENGTH' },
          ],
          achievement: ach.text, achievementNote: ach.note,
          hint: 'Ease off when you’re ready · tap the screen or press any key for the report',
        };
        const frame = hwMod.makeFrame({
          lanes: [
            { movement: 'ankle_dorsiflexion', side: 'left' }, { movement: 'ankle_dorsiflexion', side: 'right' },
            { movement: 'hip_abduction', side: 'left' }, { movement: 'knee_extension', side: 'right' },
          ],
          songTime: 77, thresholdFraction: 0.5,
        });
        // Record every string the card rasterises, so the note can be reconstructed from the pixels.
        const drawnText = [];
        const proto = Object.getPrototypeOf(hw.text);
        const realGet = proto.get;
        proto.get = function patched(text, style) { drawnText.push({ text, font: style.font }); return realGet.call(this, text, style); };
        hw.startFinale(spec);
        while (hw.finaleElapsed() < at) { hw.advanceFinale(1 / 60); hw.draw(frame); }
        proto.get = realGet;
        return { ach, drawnText, u: hw.u ?? null };
      }, { g: geom, at: 5.0 });

      await p.screenshot({ path: resolve(SHOTS, `note-${w}x${h}.png`) });
      const note = drawn.ach.note;
      // Tile the note out of what actually reached the canvas.
      const uniq = [];
      for (const d of drawn.drawnText) if (!uniq.some((u) => u.text === d.text)) uniq.push(d);
      const lines = [];
      let rest = note;
      for (let i = 0; rest.length > 0 && i < 16; i++) {
        let best = null;
        for (const d of uniq) if ((rest === d.text || rest.startsWith(`${d.text} `)) && (!best || d.text.length > best.text.length)) best = d;
        if (!best) break;
        lines.push(best);
        rest = rest.slice(best.text.length).replace(/^ /, '');
      }
      const px = Math.min(...lines.map((l) => Number(/(\d+(?:\.\d+)?)px/.exec(l.font)?.[1] ?? 0)));
      log(`${w}x${h}: note in ${lines.length} line(s) at ${px}px`);
      for (const l of lines) log(`   | ${l.text}`);
      check(lines.map((l) => l.text).join(' ') === note, `${w}x${h}: the whole note reached the canvas, unellipsised`);
      check(!lines.some((l) => l.text.includes('…')), `${w}x${h}: no ellipsis in the note`);
      check(px >= 13, `${w}x${h}: the qualifier is drawn at ${px}px (>= 13)`);
      check(
        note.includes('of the range calibrated for THAT movement today'),
        `${w}x${h}: the clause that says what the percentage is OF is in the note at all`,
      );
      await p.close();
    }
  } finally {
    await browser.close();
    server?.kill('SIGTERM');
  }
  log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED`);
  for (const f of failures) log('  -', f);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
