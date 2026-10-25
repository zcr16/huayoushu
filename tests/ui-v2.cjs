'use strict';
// Isolated, synthetic browser checks. All HTTP is intercepted; no real cloud,
// user profile, account token, microphone, screenshot or bank data is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { browserOptions } = require('./browser.cjs');
const C = require('../web/core.js');
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUTPUT = path.join(ROOT, 'work', 'ui-v2');
const KEY = 'huayoushu.ledger.v1';
const TODAY = C.today();
const OLD_DATE = C.addDays(TODAY, -40);
const LEGACY = { version: 1, transactions: [{ id: 'legacy-lunch', type: 'expense', amount: 2500, category: 'food', date: OLD_DATE, note: '历史午饭', createdAt: OLD_DATE + 'T04:00:00.000Z' }], budgets: { day: 500000, week: 1000000, month: 2000000 }, budgetReady: true };
const LEGACY_RAW = JSON.stringify(LEGACY);
let browser, context, page;
const errors = [];
const passed = [];

async function scenario(name, run) {
  await run();
  passed.push(name);
  process.stdout.write('PASS ' + name + '\n');
}
async function storage() { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function nav(name) { await page.locator('.nav [data-page="' + name + '"]').click(); }
async function closeModal() {
  if (await page.locator('#modal').evaluate(e => e.open)) await page.locator('#modal [data-action="close"]').first().click();
}
async function addAccount(name, type, amount) {
  await nav('accounts');
  await page.locator('[data-action="add-account"]').click();
  await page.locator('#account-name').fill(name);
  await page.locator('#account-type').selectOption(type);
  await page.locator('#opening-balance').fill(amount);
  await page.locator('#opening-date').fill(TODAY);
  await page.locator('#account-form button[type="submit"], #account-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
  return (await storage()).accounts.find(a => a.name === name).id;
}
async function addRecord(type, amount, source, target, note) {
  await page.locator('.topbar [data-action="add"]').click();
  await page.locator('#record-type').selectOption(type);
  await page.locator('#amount').fill(amount);
  await page.locator('#record-account').selectOption(source);
  if (target) await page.locator('#record-target').selectOption(target);
  await page.locator('#note').fill(note);
  await page.locator('#record-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
}
async function noOverflow(label) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(size.width <= size.viewport + 1, label + ': horizontal overflow ' + JSON.stringify(size));
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  browser = await chromium.launch(browserOptions());
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://hys.test') return route.abort();
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(WEB, relative);
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: mime, body: fs.readFileSync(file) });
  });
  await context.addInitScript(({ key, legacy, today }) => {
    if (!localStorage.getItem('__ui_v2_seeded')) {
      localStorage.setItem(key, legacy);
      localStorage.setItem('huayoushu.connection.v1', JSON.stringify({ mode: 'cloud', base: 'https://cloud.invalid', token: 'synthetic-test-token-only' }));
      localStorage.setItem('__ui_v2_seeded', '1');
    }
    window.HYS_NATIVE = true;
    window.__mock = { draftProtocolVersion: localStorage.getItem('__ui_v2_old_protocol') ? undefined : 2, parseRequests: [], receipts: [], captures: [], cancels: 0, stops: 0, holdParse: false, pendingParse: null, draft: { type: 'expense', amount: 2500, category: 'food', date: today, note: '合成午饭' } };
    const done = (id, value) => setTimeout(() => window.__hysBridgeResolve(id, JSON.stringify(value)), 0);
    window.HysNative = {
      httpJson(id, url, method, headers, body) {
        if (url.endsWith('/api/health')) return done(id, { status: 200, body: JSON.stringify({ provider: 'dashscope', configured: true, aiReady: false, receiptVision: true, draftProtocolVersion: window.__mock.draftProtocolVersion }) });
        if (url.endsWith('/api/parse')) {
          window.__mock.parseRequests.push(JSON.parse(body));
          const finish = () => done(id, { status: 200, body: JSON.stringify({ drafts: [window.__mock.draft], draftProtocolVersion: window.__mock.draftProtocolVersion }) });
          if (window.__mock.holdParse) window.__mock.pendingParse = finish; else finish();
          return;
        }
        if (url.endsWith('/api/receipt')) {
          window.__mock.receipts.push(JSON.parse(body));
          return done(id, { status: 200, body: JSON.stringify({ receiptProtocolVersion: 1, drafts: [{ ...window.__mock.draft, amount: 1800, note: '合成付款截图' }], warnings: [] }) });
        }
        done(id, { status: 404, body: '{}' });
      },
      pickReceiptImage(id) { window.__mock.captures.push({ id, kind: 'image' }); },
      recognizeScreenshot() { throw new Error('Whole-image capture must not call legacy OCR'); },
      recognizeVoice(id) { window.__mock.captures.push({ id, kind: 'voice' }); setTimeout(() => window.__hysCaptureState?.(id, 'listening'), 0); },
      stopVoice(id) { window.__mock.stops++; done(id, { ok: true }); },
      cancelVoice(id) { window.__mock.cancels++; done(id, { cancelled: true }); }
    };
    window.__resolveCapture = (index, payload) => window.__hysBridgeResolve(window.__mock.captures[index].id, JSON.stringify(payload));
  }, { key: KEY, legacy: LEGACY_RAW, today: TODAY });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://hys.test/', { waitUntil: 'networkidle' });

  let bank, credit, wallet;
  await scenario('V1 account opening retains old history, budget and exact migration backup', async () => {
    assert.equal((await storage()).version, 1, 'loading alone must not rewrite storage');
    bank = await addAccount('测试银行卡', 'asset', '1000');
    const state = await storage();
    assert.equal(state.version, 2);
    assert.equal(state.transactions.length, 1);
    assert.equal(state.transactions[0].id, 'legacy-lunch');
    assert.equal(state.transactions[0].legacy, true);
    assert.deepEqual(state.budgets, LEGACY.budgets);
    assert.equal(C.getAccountBalances(state)[0].balance, 100000);
    assert.equal(await page.evaluate(() => localStorage.getItem('huayoushu.ledger.pre-v2')), LEGACY_RAW);
    await noOverflow('accounts after migration');
  });
  await scenario('credit purchase and repayment do not double count consumption', async () => {
    credit = await addAccount('测试信用卡', 'liability', '0');
    await addRecord('expense', '200', credit, null, '测试信用卡购物');
    await addRecord('repayment', '200', bank, credit, '测试还款');
    const state = await storage();
    const values = Object.fromEntries(C.getAccountBalances(state).map(a => [a.id, a.balance]));
    assert.equal(values[bank], 80000);
    assert.equal(values[credit], 0);
    assert.equal(C.getSummary(state.transactions, 'month', TODAY).expense, 20000);
    assert.equal(C.getBudgetStatuses(state, TODAY).month.spent, 20000);
  });
  await scenario('asset transfer changes both balances without consuming budget', async () => {
    wallet = await addAccount('测试微信零钱', 'asset', '0');
    await addRecord('transfer', '100', bank, wallet, '测试自己转账');
    const state = await storage();
    const values = Object.fromEntries(C.getAccountBalances(state).map(a => [a.id, a.balance]));
    assert.equal(values[bank], 70000);
    assert.equal(values[wallet], 10000);
    assert.equal(C.getSummary(state.transactions, 'month', TODAY).expense, 20000);
    await noOverflow('account transfer');
  });
  await scenario('AI drafts cannot save without a funding account and save exactly once after selection', async () => {
    await nav('ai');
    await page.locator('#ai-input').fill('今天午饭25元');
    const before = (await storage()).transactions.length;
    await page.locator('[data-action="parse"]').click();
    await page.locator('#draft-form').waitFor();
    await page.locator('#draft-form button.primary').click();
    assert.match(await page.locator('#draft-error').innerText(), /选择实际资金账户/);
    assert.equal((await storage()).transactions.length, before);
    await page.locator('[name="account-0"]').selectOption(bank);
    await noOverflow('AI confirmation');
    await page.locator('#draft-form button.primary').click();
    await page.waitForFunction(() => !document.querySelector('#modal').open);
    assert.equal((await storage()).transactions.length, before + 1);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal((await storage()).transactions.length, before + 1);
  });
  await scenario('old cloud protocol is rejected before any model parse request', async () => {
    await page.evaluate(() => localStorage.setItem('__ui_v2_old_protocol', '1'));
    await page.reload({ waitUntil: 'networkidle' });
    await nav('ai');
    const before = JSON.stringify(await storage());
    const requests = await page.evaluate(() => window.__mock.parseRequests.length);
    await page.locator('#ai-input').fill('今天午饭25元');
    await page.locator('[data-action="parse"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="parse"]').disabled);
    assert.equal(await page.locator('#draft-form').count(), 0);
    assert.equal(await page.evaluate(() => window.__mock.parseRequests.length), requests);
    assert.match(await page.locator('#toast').innerText(), /升级|更新|版本/);
    assert.equal(JSON.stringify(await storage()), before);
    await page.evaluate(() => localStorage.removeItem('__ui_v2_old_protocol'));
    await page.reload({ waitUntil: 'networkidle' });
  });
  await scenario('parse response without V2 protocol cannot become a confirmable draft', async () => {
    await nav('ai');
    const before = JSON.stringify(await storage());
    await page.evaluate(() => window.__mock.draftProtocolVersion = undefined);
    await page.locator('#ai-input').fill('今天午饭25元');
    await page.locator('[data-action="parse"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-action="parse"]').disabled);
    assert.equal(await page.locator('#draft-form').count(), 0);
    assert.match(await page.locator('#toast').innerText(), /版本|升级/);
    assert.equal(JSON.stringify(await storage()), before);
    await page.reload({ waitUntil: 'networkidle' });
  });
  await scenario('selected image survives photo-picker background and goes directly to review without writing the ledger', async () => {
    const before = JSON.stringify(await storage());
    await page.locator('[data-action="capture-image"]').first().click();
    const index = await page.evaluate(() => window.__mock.captures.length - 1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    });
    await page.evaluate(i => window.__resolveCapture(i, { captureId: 'selected_test_image', mime: 'image/jpeg', imageBase64: '////syntheticjpeg000000000' }), index);
    await page.locator('#receipt-form').waitFor();
    assert.equal(await page.evaluate(() => window.__mock.parseRequests.length), 0);
    assert.equal(await page.evaluate(() => window.__mock.receipts.length), 1);
    assert.deepEqual(await page.evaluate(() => Object.keys(window.__mock.receipts[0]).sort()), ['imageBase64', 'mime', 'today']);
    assert.equal(JSON.stringify(await storage()), before);
    await page.locator('[data-action="discard-drafts"]').last().click();
  });
  await scenario('cancelled image callback cannot upload, overwrite text or write a transaction', async () => {
    const before = JSON.stringify(await storage());
    const previous = await page.locator('#ai-input').inputValue();
    const uploads = await page.evaluate(() => window.__mock.receipts.length);
    await page.locator('[data-action="capture-image"]').click();
    const index = await page.evaluate(() => window.__mock.captures.length - 1);
    await page.locator('[data-action="capture-cancel"]').click();
    await page.evaluate(i => window.__resolveCapture(i, { captureId: 'cancelled_test_image', mime: 'image/jpeg', imageBase64: '////syntheticjpeg000000000' }), index);
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#ai-input').inputValue(), previous);
    assert.equal(await page.evaluate(() => window.__mock.receipts.length), uploads);
    assert.equal(JSON.stringify(await storage()), before);
  });
  await scenario('voice stop returns editable text without invoking cloud automatically', async () => {
    const before = JSON.stringify(await storage());
    const parses = await page.evaluate(() => window.__mock.parseRequests.length);
    await page.locator('[data-action="capture-voice"]').click();
    const index = await page.evaluate(() => window.__mock.captures.length - 1);
    await page.locator('[data-action="capture-stop"]').click();
    await page.evaluate(i => window.__resolveCapture(i, { text: '合成语音午饭三十元' }), index);
    await page.waitForFunction(() => document.querySelector('#ai-input')?.value === '合成语音午饭三十元');
    assert.equal(await page.evaluate(() => window.__mock.parseRequests.length), parses);
    assert.equal(await page.evaluate(() => window.__mock.stops), 1);
    assert.equal(JSON.stringify(await storage()), before);
  });
  await scenario('late callback from cancelled voice session cannot cancel a newer recording', async () => {
    await page.locator('[data-action="capture-voice"]').click();
    const old = await page.evaluate(() => window.__mock.captures.length - 1);
    await page.locator('[data-action="capture-cancel"]').click();
    const cancels = await page.evaluate(() => window.__mock.cancels);
    await page.locator('[data-action="capture-voice"]').click();
    const fresh = await page.evaluate(() => window.__mock.captures.length - 1);
    await page.evaluate(i => window.__resolveCapture(i, { cancelled: true }), old);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__mock.cancels), cancels, 'old voice finally must not cancel newer session');
    await page.evaluate(i => window.__resolveCapture(i, { text: '新的语音午饭六元' }), fresh);
    await page.waitForFunction(() => document.querySelector('#ai-input')?.value === '新的语音午饭六元');
  });
  await scenario('AI response from previous ledger epoch cannot create draft or change real data', async () => {
    const before = JSON.stringify(await storage());
    await page.evaluate(() => window.__mock.holdParse = true);
    await page.locator('#ai-input').fill('今天午饭25元');
    await page.locator('[data-action="parse"]').click();
    await page.waitForFunction(() => !!window.__mock.pendingParse);
    await nav('settings');
    await page.locator('[data-action="demo"]').click();
    await page.evaluate(() => { window.__mock.holdParse = false; window.__mock.pendingParse(); });
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#draft-form').count(), 0);
    assert.equal(JSON.stringify(await storage()), before);
    await page.locator('[data-action="leave-demo"]').click();
  });
  await scenario('390px pages and entry modal have no horizontal overflow or JavaScript errors', async () => {
    for (const name of ['home', 'accounts', 'list', 'analysis', 'budget', 'ai', 'settings']) {
      await nav(name);
      await noOverflow(name);
    }
    await page.locator('.topbar [data-action="add"]').click();
    await noOverflow('manual record');
    await closeModal();
    await nav('accounts');
    await page.screenshot({ path: path.join(OUTPUT, 'accounts-390.png'), fullPage: true });
    assert.deepEqual(errors, []);
  });
  process.stdout.write(JSON.stringify({ passed: passed.length, scenarios: passed, screenshot: path.join(OUTPUT, 'accounts-390.png'), externalNetwork: false }, null, 2) + '\n');
})().catch(async error => {
  if (page) { try { await page.screenshot({ path: path.join(OUTPUT, 'failure.png'), fullPage: true }); } catch (_) {} }
  process.stderr.write((error.stack || String(error)) + '\n');
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close();
  if (browser) await browser.close();
});
