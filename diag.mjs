import { chromium } from '@playwright/test';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:3000/', { waitUntil:'domcontentloaded' });
await p.waitForTimeout(6000);
const info = await p.evaluate(() => {
  const canvas = document.querySelector('.maplibregl-canvas');
  const ctrl = document.querySelector('.maplibregl-ctrl-top-left');
  const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
  return {
    canvasRect: canvas?.getBoundingClientRect().toJSON(),
    ctrlRect: ctrl?.getBoundingClientRect().toJSON(),
    hasGL: !!gl,
    glLost: gl ? gl.isContextLost() : null,
    markerCount: document.querySelectorAll('.maplibregl-marker').length,
  };
});
console.log(JSON.stringify(info));
await b.close();
