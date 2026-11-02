import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
await mkdir('.local/browser', {recursive:true, mode:0o700});
const context = await chromium.launchPersistentContext('.local/browser', { headless: false });
const page = context.pages()[0] || await context.newPage();
await page.goto('https://claude.ai');
console.log('Войдите в Claude в открывшемся браузере вручную. Затем закройте окно браузера. Не запускайте login и сервер одновременно.');
await new Promise(resolve => context.on('close', resolve));
