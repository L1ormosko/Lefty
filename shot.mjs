import { chromium } from '@playwright/test';
const url = process.argv[2] || 'http://localhost:3000/';
const tag = process.argv[3] || 'home';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--enable-unsafe-swiftshader','--use-gl=swiftshader'] });
const errors = new Set();
for (const [name, w, h] of [['desktop',1440,900],['mobile',390,844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', e => errors.add(`${name}: ${e.message.slice(0,140)}`));
  p.on('console', m => { if (m.type()==='error' && !/Failed to fetch|ERR_TUNNEL|status of 404/.test(m.text())) errors.add(`${name}: ${m.text().slice(0,140)}`); });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `/tmp/velto-${tag}-${name}.png` });
  await p.close();
}
await b.close();
console.log(errors.size ? [...errors].join('\n') : 'no page errors');
