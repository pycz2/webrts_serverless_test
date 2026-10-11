// E2E: два независимых окна Chrome проходят весь сценарий (ссылка -> код-ответ -> чат).
// Запуск: npm i --no-save playwright-core && node test.mjs   (нужен установленный Google Chrome)
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const html = await readFile(new URL('./index.html', import.meta.url));
const server = createServer((_, res) => res.end(html)).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  // Отдельные контексты = как два разных браузера, без общего состояния.
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();

  await host.goto(url);
  await host.click('#create');
  await host.waitForFunction(() => document.querySelector('#offerOut').value, null, { timeout: 15000 });
  const link = await host.locator('#offerOut').inputValue();
  assert.match(link, /#[\w-]+$/);
  console.log('offer link length:', link.length);

  // Публичный STUN должен вернуть внешний адрес (srflx) — значит, Google STUN доступен.
  const offer = await host.evaluate(async code => {
    const b = Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }, link.split('#')[1]);
  console.log('srflx candidate from STUN:', /typ srflx/.test(offer));

  // Гость открывает чистую страницу и вставляет ссылку в поле «Вас пригласили?».
  await guest.goto(url);
  await guest.fill('#joinIn', link);
  await guest.click('#joinBtn');
  await guest.waitForFunction(() => !document.querySelector('#answerOut').value.startsWith('Генерация'), null, { timeout: 15000 });
  const answer = await guest.locator('#answerOut').inputValue();
  assert.doesNotMatch(answer, /повреждена/);
  console.log('answer code length:', answer.length);

  await host.fill('#answerIn', answer);
  await host.click('#accept');
  await host.waitForSelector('#chat:not([hidden])', { timeout: 15000 });
  await guest.waitForSelector('#chat:not([hidden])', { timeout: 15000 });
  console.log('route:', await host.locator('#log .sys').first().textContent());

  await host.fill('#msg', 'привет от хоста');
  await host.press('#msg', 'Enter');
  await guest.waitForFunction(() => document.querySelector('#log').textContent.includes('Хост: привет от хоста'));

  await guest.fill('#msg', 'привет от гостя <b>x</b>');
  await guest.press('#msg', 'Enter');
  await host.waitForFunction(() => document.querySelector('#log').textContent.includes('Гость: привет от гостя <b>x</b>'));
  assert.equal(await host.locator('#log b').count(), 0, 'HTML из сообщения не должен рендериться');

  console.log('OK: сообщения дошли в обе стороны');
} finally {
  await browser.close();
  server.close();
}
