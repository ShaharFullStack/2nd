import { chromium } from 'playwright';
const OUT='/home/user/2nd/.critic-tmp';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', headless:true, args:['--no-sandbox','--use-gl=swiftshader']});
async function run(name, suggested, latencyMs, tag) {
  const page = await b.newPage({viewport:{width:1024,height:768}});
  await page.goto('http://localhost:5188/?input=keyboard');
  await page.waitForFunction(()=>!!window.__beatRehab);
  await page.evaluate(({suggested, latencyMs, tag})=>{
    const lane=(i,m,s)=>({lane:i,movement:m,side:s,label:'L x',hits:40,perfects:25,goods:15,misses:28,
      judged:68,accuracy:0.59,reps:92,timingBiasMs:210,timingBiasMadMs:22,romMean:0.7,romBest:0.9,
      romSamples:60,romUncertain:1,calibratedMin:0,calibratedMax:55,calibrationManual:false,
      compensationKind:null,compensationMonitored:false,compensationFlags:0,compensationWorst:null});
    window.__beatRehab.store.setState({lastResult:{id:'x',startedAt:Date.now()-2e5,endedAt:Date.now(),
      durationSec:97,mode:'leg',difficulty:'medium',windowScale:1,inputMode:tag,songId:'demo-groove',
      songTitle:'Demo Groove',artist:'A',attribution:'x',score:900,stars:2,accuracy:0.59,starAccuracy:0.55,
      maxCombo:9,totalNotes:136,hits:80,perfects:50,goods:30,misses:56,reps:184,health:0.4,
      timingBiasMs:210,timingBiasMadMs:22,latencyOffsetMs:latencyMs,suggestedLatencyMs:suggested,
      completed:true,lanes:[lane(0,'knee_extension','left'),lane(1,'seated_march','right')]}});
    window.__beatRehab.store.getState().goto('results');
  },{suggested,latencyMs,tag});
  await page.waitForTimeout(500);
  const h = await page.$('[data-testid="latency-handover"]');
  console.log(name, 'handover present:', !!h, h? '| text: '+(await h.innerText()).replace(/\n/g,' | ').slice(0,260):'');
  if (h) { await h.scrollIntoViewIfNeeded(); await page.waitForTimeout(200); await page.screenshot({path:`${OUT}/${name}.png`}); }
  return page;
}
// significant, camera
const p1 = await run('res-significant', 330, 120, 'camera');
await p1.click('[data-testid="apply-latency"]');
await p1.waitForTimeout(400);
await p1.locator('[data-testid="latency-handover"]').scrollIntoViewIfNeeded();
await p1.screenshot({path:`${OUT}/res-applied.png`});
console.log('after apply store latency:', await p1.evaluate(()=>window.__beatRehab.store.getState().latencyOffsetSec));
await p1.close();
// non-significant
const p2 = await run('res-minor', 180, 120, 'camera'); await p2.close();
// KEYBOARD run -> should the handover offer to change the CAMERA offset?
const p3 = await run('res-keyboard', 330, 120, 'keyboard');
const before = await p3.evaluate(()=>window.__beatRehab.store.getState().latencyOffsetSec);
await p3.click('[data-testid="apply-latency"]').catch(()=>console.log('no apply button'));
await p3.waitForTimeout(300);
console.log('keyboard run: latency', before, '->', await p3.evaluate(()=>window.__beatRehab.store.getState().latencyOffsetSec));
await p3.close();
// AUTOPLAY run
const p4 = await run('res-autoplay', 0, 140, 'autoplay');
await p4.click('[data-testid="apply-latency"]').catch(()=>{});
await p4.waitForTimeout(300);
console.log('autoplay run: latency now', await p4.evaluate(()=>window.__beatRehab.store.getState().latencyOffsetSec));
await p4.close();
await b.close();
