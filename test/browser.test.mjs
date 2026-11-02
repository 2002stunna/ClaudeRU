import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSettings } from '../browser.mjs';
test('Yandex uses macOS application and a separate automation profile', () => {
  const settings = browserSettings('yandex', 'darwin');
  assert.equal(settings.options.executablePath, '/Applications/Yandex.app/Contents/MacOS/Yandex');
  assert.notEqual(settings.profile, browserSettings('chromium', 'darwin').profile);
  assert.equal(settings.options.headless, false);
  assert.throws(() => browserSettings('yandex', 'linux'), /macOS/);
  assert.throws(() => browserSettings('unknown', 'darwin'), /Неизвестный/);
});
