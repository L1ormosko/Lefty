import { chromium } from '@playwright/test';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:3000/', { waitUntil:'domcontentloaded' });
await p.waitForTimeout(5000);
console.log(await p.evaluate(() => {
  const app = document.querySelector('[role="application"]');
  let el = app, chain = [];
  while (el && chain.length < 6) {
    const r = el.getBoundingClientRect();
    chain.push(`${el.tagName}.${(el.className||'').toString().slice(0,60)} => ${Math.round(r.width)}x${Math.round(r.height)}`);
    el = el.parentElement;
  }
  return chain.join('\n');
}));
await b.close();
