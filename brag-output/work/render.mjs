import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire('/home/stein/.npm/_npx/1722e863ebfd623b/node_modules/');
const puppeteer = require('puppeteer-core');
const dir = path.dirname(new URL(import.meta.url).pathname);
const exe = fs.readdirSync(process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1248').map((d) => `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1248/${d}/chrome-headless-shell`).find(fs.existsSync);
const [, , mode, ...times] = process.argv; // mode: stills|frames
const browser = await puppeteer.launch({ executablePath: exe, args: ['--allow-file-access-from-files', '--force-color-profile=srgb', '--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto('file://' + dir + '/index.html', { waitUntil: 'load' });
await page.evaluate(() => window.ready);
const FPS = 30, N = +(process.env.FRAMES || 1200);
if (mode === 'stills') {
  fs.mkdirSync(dir + '/stills', { recursive: true });
  for (const t of times) { await page.evaluate((t) => seek(+t), t); await page.screenshot({ path: `${dir}/stills/t${t}.png` }); }
} else {
  fs.mkdirSync(dir + '/frames', { recursive: true });
  for (let i = 0; i < N; i++) {
    const out = `${dir}/frames/f${String(i).padStart(4, '0')}.png`;
    if (fs.existsSync(out) && fs.statSync(out).size > 0) continue; // resume after an interrupted run
    await page.evaluate((t) => seek(t), i / FPS);
    await page.screenshot({ path: out });
  }
}
await browser.close();
