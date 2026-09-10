import { chromium } from 'playwright';
const OUT='/home/user/2nd/.critic-tmp';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', headless:true,
  args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-gl=swiftshader']});
const page = await b.newPage({viewport:{width:1024,height:768}});
page.on('console', m=>{ if(m.type()==='error') console.log('[err]', m.text().slice(0,160)); });
await page.goto('http://localhost:5188/?input=keyboard&screen=setup');
await page.waitForSelector('[data-testid="setup-start"]');
await page.waitForTimeout(1200);
const songs = await page.$$eval('[data-testid^="song-"]', els=>els.map(e=>e.getAttribute('data-testid')));
console.log('songs:', songs);
const id = songs[0].replace('song-','');
await page.screenshot({path:`${OUT}/prev-before.png`});
await page.click(`[data-testid="preview-${id}"]`);
await page.waitForTimeout(2500);
const st = await page.evaluate(()=>{
  const m = window.__beatRehab.runtime.peekAudio()?.mixer;
  return { previewing: window.__beatRehab.runtime.previewingSongId(), isPreviewing: m?.isPreviewing,
           songTime: m?.songTime?.(), state: m?.state ?? null, loaded: m?.isLoaded };
});
console.log('during preview:', JSON.stringify(st));
await page.screenshot({path:`${OUT}/prev-playing.png`});
const btn = await page.$eval(`[data-testid="preview-${id}"]`, e=>e.textContent+' pressed='+e.getAttribute('aria-pressed'));
console.log('button:', btn);
// now press start and check song time 0
await page.click('[data-testid="setup-start"]');
await page.waitForTimeout(4000);
const play = await page.evaluate(()=>{
  const m = window.__beatRehab.runtime.peekAudio()?.mixer;
  const hud = window.__beatRehab.getScore?.();
  return { isPreviewing: m?.isPreviewing, songTime: m?.songTime?.(), hud };
});
console.log('after start:', JSON.stringify(play));
await page.screenshot({path:`${OUT}/prev-playing2.png`});
// test the auto-stop
const page2 = await b.newPage({viewport:{width:1024,height:768}});
await page2.goto('http://localhost:5188/?input=keyboard&screen=setup');
await page2.waitForSelector('[data-testid="setup-start"]');
await page2.waitForTimeout(1200);
await page2.click(`[data-testid="preview-${id}"]`);
await page2.waitForTimeout(1500);
console.log('t=1.5s previewing:', await page2.evaluate(()=>window.__beatRehab.runtime.previewingSongId()));
await page2.waitForTimeout(13000);
console.log('t=14.5s previewing:', await page2.evaluate(()=>window.__beatRehab.runtime.previewingSongId()));
console.log('button after auto-stop:', await page2.$eval(`[data-testid="preview-${id}"]`, e=>e.textContent+' pressed='+e.getAttribute('aria-pressed')));
await b.close();
