import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

// Only claude.ai conversation URLs can enter the automation browser.
export function conversationURL(value) {
  if (!value) return 'https://claude.ai/new';
  const url = new URL(value);
  if (url.origin !== 'https://claude.ai' || !/^\/chat\/[a-zA-Z0-9-]+$/.test(url.pathname) || url.search || url.hash)
    throw new Error('Недопустимый адрес чата');
  return url.href;
}
export class ClaudeBridge {
  context; busy = false;
  async open() {
    await mkdir('.local/browser', {recursive:true, mode:0o700});
    this.context = await chromium.launchPersistentContext('.local/browser', { headless: false });
  }
  async close() { await this.context?.close(); }
  async send({ text, url, onUpdate }) {
    if (this.busy) throw new Error('Дождитесь завершения текущего ответа');
    this.busy = true;
    try {
      const destination = conversationURL(url);
      const page = this.context.pages()[0] || await this.context.newPage();
      if (page.url() !== destination || !url) await page.goto(destination, { waitUntil: 'domcontentloaded' });
      // These selectors reflect Claude's web UI and may need updating when it changes.
      const editor = page.locator('[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]').first();
      try { await editor.waitFor({state:'visible', timeout:20000}); }
      catch { throw new Error('Не найдено поле сообщения. Откройте браузер на Mac: проверьте вход, проверки сайта и доступный лимит.'); }
      const responses = page.locator('[data-is-streaming] .font-claude-response, .font-claude-response');
      const before = await responses.count();
      await editor.fill(text);
      await editor.press('Enter');
      let previous = '', stable = 0, seenStreaming = false;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(700);
        const count = await responses.count();
        const current = count > before ? await responses.last().innerText() : '';
        const stop = page.getByRole('button', {name:/stop response|stop generating|остановить/i});
        const streaming = await stop.count() > 0;
        if (streaming) seenStreaming = true;
        if (current && current !== previous) {
          previous = current; stable = 0;
          const currentURL = page.url();
          let chatURL = null;
          try { chatURL = conversationURL(currentURL); } catch {}
          onUpdate({text:current, url:chatURL});
        } else if (current) stable++;
        if (current && !streaming && stable >= (seenStreaming ? 3 : 10)) return;
      }
      throw new Error('Не удалось подтвердить завершение ответа за 3 минуты. Проверьте чат в браузере на Mac; сообщение могло быть отправлено.');
    } finally { this.busy = false; }
  }
}
