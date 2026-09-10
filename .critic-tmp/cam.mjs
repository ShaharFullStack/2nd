import { chromium } from 'playwright';
const OUT='/home/user/2nd/.critic-tmp';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', headless:true, args:['--no-sandbox','--use-gl=swiftshader']});
const ctx = await b.newContext({viewport:{width:1024,height:768}});
const page = await ctx.newPage();
page.on('console', m=>console.log('['+m.type()+']', m.text().slice(0,200)));
page.on('pageerror', e=>console.log('[pageerror]', String(e).slice(0,200)));
await page.goto('http://localhost:5188/?input=camera&screen=camera');
for (const t of [5,15,30,45]) {
  await page.waitForTimeout(t===5?5000:10000);
  const fb = await page.$('[data-testid="camera-fallback"]');
  console.log(`t=${t}s fallback=${!!fb}`);
  if (fb) { await page.screenshot({path:`${OUT}/cam-fallback.png`,fullPage:true}); console.log(await page.evaluate(()=>document.body.innerText.slice(0,1200))); break; }
}
const gum = await page.evaluate(async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({video:true}); return 'ok '+s.getTracks().length; }
  catch(e){ return 'err '+e.name+': '+e.message; }
});
console.log('direct getUserMedia ->', gum);
await page.screenshot({path:`${OUT}/cam-final.png`,fullPage:true});
await b.close();
