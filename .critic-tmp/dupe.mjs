import { chromium } from 'playwright';
const OUT='/home/user/2nd/.critic-tmp';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', headless:true, args:['--no-sandbox','--use-gl=swiftshader']});
const page = await b.newPage({viewport:{width:1024,height:768}});
await page.goto('http://localhost:5188/?input=keyboard');
await page.waitForFunction(()=>!!window.__beatRehab);
// use the app's REAL label function via a dynamic import of the module graph
const built = await page.evaluate(async () => {
  const { movementLabel } = await import('/src/render/palette.ts');
  const lane = (i, movement, side, o={}) => ({
    lane:i, movement, side, label: movementLabel(movement, side),
    hits:40, perfects:25, goods:15, misses:8, judged:48, accuracy:o.acc??0.8, reps:52,
    timingBiasMs:10, timingBiasMadMs:20, romMean:o.rom??0.7, romBest:(o.rom??0.7)+0.1,
    romSamples:o.rom===null?0:40, romUncertain:0, calibratedMin:0, calibratedMax:1,
    calibrationManual:false, compensationKind:null, compensationMonitored:false,
    compensationFlags:0, compensationWorst:null, ...(o.fingertip?{fingertip:o.fingertip}:{}),
  });
  const mk=(n,at,lanes,patch={})=>({id:'s'+n,startedAt:at,endedAt:at+1e5,durationSec:97,mode:'hand',
    difficulty:'medium',windowScale:1,inputMode:'camera',songId:'demo-groove',songTitle:'Demo Groove',
    artist:'A',attribution:'x',score:1000,stars:3,accuracy:0.8,starAccuracy:0.78,maxCombo:10,
    totalNotes:100,hits:80,perfects:50,goods:30,misses:20,reps:104,health:0.8,timingBiasMs:10,
    timingBiasMadMs:20,latencyOffsetMs:120,suggestedLatencyMs:null,completed:true,lanes,...patch});
  const day=864e5, now=Date.now(); const h=[];
  const roms=[0.85,0.8,0.75,0.7,0.66];
  for(let k=0;k<5;k++){
    // k===1 is a KEYBOARD session (camera broken that day) — near-perfect accuracy on keys
    const kb = k===1;
    h.push(mk(k, now-k*3*day, [
      lane(0,'finger_opposition','left',{fingertip:'index', rom: kb?null:roms[k], acc: kb?0.99:0.72}),
      lane(1,'finger_opposition','left',{fingertip:'pinky', rom: kb?null:roms[k]*0.6, acc: kb?0.98:0.55}),
    ], kb?{inputMode:'keyboard'}:{}));
  }
  window.__beatRehab.store.setState({history:h});
  window.__beatRehab.store.getState().goto('history');
  return h[0].lanes.map(l=>l.label);
});
console.log('real labels for the two fingertip lanes:', JSON.stringify(built));
await page.waitForSelector('[data-testid="rom-trend"]');
await page.waitForTimeout(600);
await page.screenshot({path:`${OUT}/dupe-trend.png`, fullPage:true});
const cards = await page.$$eval('.trend-card', els=>els.map(e=>({title:e.querySelector('h4').textContent, testid:e.getAttribute('data-testid'), text:e.innerText.replace(/\n/g,' | ')})));
console.log(JSON.stringify(cards,null,1));
await b.close();
