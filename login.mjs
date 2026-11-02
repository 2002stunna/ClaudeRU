import { launchBrowser } from './browser.mjs';
const context = await launchBrowser();
const page = context.pages()[0] || await context.newPage();
await page.goto('https://claude.ai');
console.log('Войдите в Claude в открывшемся браузере вручную. Затем закройте окно браузера. Не запускайте login и сервер одновременно.');
await new Promise(resolve => context.on('close', resolve));
