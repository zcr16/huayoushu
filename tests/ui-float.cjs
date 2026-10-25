'use strict';
// Isolated synthetic UI regression. Native screen capture, OCR, HTTP and all
// credentials are mocked. No cloud service, user profile or real screenshot is
// accessed. Only this test file is part of the floating-feature test change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { browserOptions } = require('./browser.cjs');
const C = require('../web/core.js');
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const OUTPUT = path.join(ROOT, 'work', 'ui-float');
const KEY = 'huayoushu.ledger.v1';
const TODAY = C.today();
const BANK = 'synthetic-bank';
const SEED = C.validateState({ ...C.createInitialState(), budgetReady: true,
  budgets: { day: 500000, week: 1000000, month: 2000000 },
  accounts: [
    { id: BANK, name: '合成银行卡', type: 'asset', currency: 'CNY', openingBalance: 100000, openingDate: TODAY },
    { id: 'synthetic-wallet', name: '合成微信零钱', type: 'asset', currency: 'CNY', openingBalance: 0, openingDate: TODAY }
  ]
});
const RAW = JSON.stringify(SEED);
const TEXT = `合成午饭\n支付成功\n原价￥30.00\n优惠￥5.00\n实付金额￥25.00\n交易时间 ${TODAY}`;
const passed = [];
let browser;

async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const errors = [], unexpectedNetwork = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://hys.test') { unexpectedNetwork.push(url.origin); return route.abort(); }
    const file = path.resolve(WEB, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: mime, body: fs.readFileSync(file) });
  });
  await context.addInitScript(({ key, raw, today, options }) => {
    localStorage.setItem(key, raw);
    localStorage.setItem('huayoushu.connection.v1', JSON.stringify({ mode: 'cloud', base: 'https://cloud.invalid', token: 'synthetic-test-token-only' }));
    window.HYS_NATIVE = true;
    const mock = window.__floatMock = {
      status: { supported: true, active: !!options.active, busy: false, permission: 'granted', capturePermission: 'granted', pending: false },
      calls: [], parseRequests: [], acknowledgements: [], held: [], hold: {}, overrides: {},
      capture: null, holdParse: false, pendingParse: null,
      draft: { type: 'expense', amount: 2500, category: 'food', date: today, note: '合成午饭' }
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    const reply = (id, payload) => setTimeout(() => window.__hysBridgeResolve(id, JSON.stringify(payload)), 0);
    const handle = (method, id, args, getDefault) => {
      mock.calls.push({ method, id, args });
      const value = Object.hasOwn(mock.overrides, method) ? clone(mock.overrides[method]) : getDefault();
      if (mock.hold[method]) mock.held.push({ method, id, value, delivered: false });
      else reply(id, value);
    };
    window.HysNative = {
      httpJson(id, url, method, headers, body) {
        mock.calls.push({ method: 'httpJson', endpoint: url.endsWith('/api/parse') ? 'parse' : 'health' });
        if (url.endsWith('/api/health')) return reply(id, { status: 200, body: JSON.stringify({ provider: 'dashscope', configured: true, aiReady: false, draftProtocolVersion: 2 }) });
        if (url.endsWith('/api/parse')) {
          mock.parseRequests.push(JSON.parse(body));
          const finish = () => reply(id, { status: 200, body: JSON.stringify({ drafts: [clone(mock.draft)], draftProtocolVersion: 2 }) });
          if (mock.holdParse) mock.pendingParse = finish; else finish();
          return;
        }
        reply(id, { status: 404, body: '{}' });
      },
      getFloatingStatus(id) { handle('getFloatingStatus', id, [], () => ({ ...mock.status, pending: !!mock.capture })); },
      startFloatingBall(id) { handle('startFloatingBall', id, [], () => { mock.status.active = true; return { ...mock.status, pending: !!mock.capture }; }); },
      stopFloatingBall(id) { handle('stopFloatingBall', id, [], () => { mock.status.active = false; return { ...mock.status, pending: !!mock.capture }; }); },
      getFloatingCapture(id) { handle('getFloatingCapture', id, [], () => mock.capture ? clone(mock.capture) : { empty: true }); },
      ackFloatingCapture(id, captureId) {
        handle('ackFloatingCapture', id, [captureId], () => {
          mock.acknowledgements.push(captureId);
          if (mock.capture?.captureId === captureId) mock.capture = null;
          return { acknowledged: true };
        });
      },
      recognizeScreenshot(id) { handle('recognizeScreenshot', id, [], () => ({ cancelled: true })); },
      recognizeVoice(id) { handle('recognizeVoice', id, [], () => ({ cancelled: true })); },
      cancelVoice(id) { reply(id, { cancelled: true }); }
    };
    if (options.missingBridge) {
      for (const name of ['getFloatingStatus', 'startFloatingBall', 'stopFloatingBall', 'getFloatingCapture', 'ackFloatingCapture']) delete window.HysNative[name];
    }
    window.__emitFloating = payload => {
      mock.capture = clone(payload);
      if (typeof window.__hysFloatingCaptureReady !== 'function') throw new Error('Missing floating notification callback');
      window.__hysFloatingCaptureReady();
    };
    window.__deliverFloating = (method, override) => {
      const pending = mock.held.find(item => item.method === method && !item.delivered);
      if (!pending) throw new Error('No held native response: ' + method);
      pending.delivered = true;
      reply(pending.id, override === undefined ? pending.value : override);
    };
  }, { key: KEY, raw: RAW, today: TODAY, options });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://hys.test/', { waitUntil: 'networkidle' });
  return { page, context, errors, unexpectedNetwork };
}

const storageRaw = page => page.evaluate(key => localStorage.getItem(key), KEY);
const storage = async page => JSON.parse(await storageRaw(page));
const mockState = page => page.evaluate(() => ({ calls: window.__floatMock.calls, parses: window.__floatMock.parseRequests, acknowledgements: window.__floatMock.acknowledgements }));
async function nav(page, name) { await page.locator('.nav [data-page="' + name + '"]').click(); }
async function settle(page) { await page.waitForTimeout(70); }
async function emit(page, payload = {}) {
  await page.evaluate(({ text, payload }) => window.__emitFloating({ captureId: 'capture-1', text, source: 'floating', createdAt: Date.now(), ...payload }), { text: TEXT, payload });
  await settle(page);
}
async function review(page) {
  await page.locator('[data-action="float-review"]').first().click();
  await settle(page);
}
async function closeModal(page) {
  const close = page.locator('#modal [data-action="close"]').first();
  if (await page.locator('#modal').evaluate(el => el.open)) await close.click();
}
async function acceptReplacement(page) {
  const replace = page.locator('#modal [data-action="float-replace"]');
  if (await replace.count()) await replace.click();
  await page.locator('#ai-input').waitFor();
}
async function assertNoUploadOrWrite(page, before = RAW) {
  assert.equal((await mockState(page)).parses.length, 0);
  assert.equal(await storageRaw(page), before);
}
async function saveManual(page, note = '合成手工账') {
  await page.locator('.topbar [data-action="add"]').click();
  await page.locator('#amount').fill('1');
  await page.locator('#record-account').selectOption(BANK);
  await page.locator('#note').fill(note);
  await page.locator('#record-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#modal').open);
}
async function hasUsableReview(page) {
  return page.locator('[data-action="float-review"]').evaluateAll(elements => elements.some(el => !el.disabled && el.getClientRects().length));
}
async function scenario(name, run, options) {
  const f = await fixture(options);
  try {
    await run(f.page);
    assert.deepEqual(f.errors, [], 'JavaScript or console error');
    assert.deepEqual(f.unexpectedNetwork, [], 'Unexpected attempted network request');
    passed.push(name);
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    await f.page.screenshot({ path: path.join(OUTPUT, 'failure-' + (passed.length + 1) + '.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await f.context.close(); }
}

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  browser = await chromium.launch(browserOptions());

  await scenario('floating start/stop uses explicit native actions without upload or ledger mutation', async page => {
    await nav(page, 'settings');
    await page.locator('[data-action="float-start"]').first().click();
    await page.waitForFunction(() => window.__floatMock.calls.some(c => c.method === 'startFloatingBall'));
    await settle(page);
    await page.locator('[data-action="float-stop"]').first().click();
    await page.waitForFunction(() => window.__floatMock.calls.some(c => c.method === 'stopFloatingBall'));
    await settle(page);
    const data = await mockState(page);
    assert.equal(data.calls.filter(c => c.method === 'startFloatingBall').length, 1);
    assert.equal(data.calls.filter(c => c.method === 'stopFloatingBall').length, 1);
    await assertNoUploadOrWrite(page);
  });

  await scenario('successful start refreshes a stale busy snapshot after the native control lock clears', async page => {
    await nav(page, 'settings');
    await settle(page);
    const before = (await mockState(page)).calls.filter(c => c.method === 'getFloatingStatus').length;
    await page.evaluate(() => {
      const mock = window.__floatMock;
      // runStart constructs its response before its finally block clears
      // starting. A subsequent status read must observe the settled state.
      mock.status.active = true;
      mock.status.busy = false;
      mock.overrides.startFloatingBall = { ...mock.status, busy: true };
    });
    await page.locator('[data-action="float-start"]').first().click();
    await page.waitForFunction(count => window.__floatMock.calls.filter(c => c.method === 'getFloatingStatus').length > count, before);
    await page.waitForFunction(() => document.querySelector('[data-floating-status]')?.textContent.includes('已开启 · 点击人物打开菜单'));
    assert.equal(await page.locator('[data-action="float-stop"]').first().isEnabled(), true);
    assert.equal((await mockState(page)).calls.filter(c => c.method === 'startFloatingBall').length, 1);
    await assertNoUploadOrWrite(page);
  });

  await scenario('legacy floating text remains compatible: local review, explicit upload and account-confirmed save', async page => {
    await emit(page);
    await assertNoUploadOrWrite(page);
    assert.equal((await mockState(page)).acknowledgements.length, 0, 'get must not consume the native pending capture');
    await review(page);
    await page.waitForFunction(text => document.querySelector('#ai-input')?.value === text, TEXT);
    await assertNoUploadOrWrite(page);
    assert.ok((await mockState(page)).acknowledgements.includes('capture-1'));
    const edited = '今天午饭25元，合成银行卡付款';
    await page.locator('#ai-input').fill(edited);
    await page.locator('[data-action="parse"]').click();
    await page.locator('#draft-form').waitFor();
    const requests = (await mockState(page)).parses;
    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(requests[0]).sort(), ['inputSource', 'text', 'today']);
    assert.equal(requests[0].inputSource, 'ocr');
    assert.equal(requests[0].text, edited);
    assert.equal(await storageRaw(page), RAW);
    await page.locator('#draft-form button.primary').click();
    assert.match(await page.locator('#draft-error').innerText(), /账户/);
    assert.equal(await storageRaw(page), RAW);
    await page.locator('[name="account-0"]').selectOption(BANK);
    await page.locator('#draft-form button.primary').click();
    await page.waitForFunction(() => !document.querySelector('#modal').open);
    const after = await storageRaw(page);
    assert.equal(JSON.parse(after).transactions.length, 1);
    await emit(page); // Native notification may be repeated after acknowledgement.
    assert.equal(await hasUsableReview(page), false);
    assert.equal(await storageRaw(page), after);
    assert.equal((await mockState(page)).parses.length, 1);
  });

  await scenario('duplicate ready notifications do not replace later edits or re-offer the same capture', async page => {
    await emit(page);
    await page.evaluate(() => { window.__hysFloatingCaptureReady(); window.__hysFloatingCaptureReady(); });
    await settle(page);
    await review(page);
    await page.waitForFunction(() => !!document.querySelector('#ai-input'));
    await page.locator('#ai-input').fill('用户核对后的午饭26元');
    await emit(page);
    assert.equal(await page.locator('#ai-input').inputValue(), '用户核对后的午饭26元');
    assert.equal(await hasUsableReview(page), false);
    await assertNoUploadOrWrite(page);
  });

  await scenario('expired, future, malformed and overlong captures never become reviewable input', async page => {
    const cases = [
      { captureId: 'expired', createdAt: Date.now() - 301000 },
      { captureId: 'future', createdAt: Date.now() + 45000 },
      { captureId: 'empty', text: '  ' },
      { captureId: 'overlong', text: '字'.repeat(4001) },
      { captureId: 'wrong-type', text: { amount: 25 } },
      { captureId: '', text: TEXT }
    ];
    for (const payload of cases) {
      await emit(page, payload);
      assert.equal(await hasUsableReview(page), false, payload.captureId);
      const input = page.locator('#ai-input');
      if (await input.count()) assert.equal(await input.inputValue(), '');
      await assertNoUploadOrWrite(page);
      const discard = page.locator('[data-action="float-discard"]').first();
      if (await discard.isVisible().catch(() => false)) { await discard.click(); await settle(page); }
    }
  });

  await scenario('native capture error stays a local notice until explicit discard acknowledgement', async page => {
    await emit(page, { captureId: 'capture-error', text: undefined, error: 'capture_permission_denied' });
    assert.equal(await hasUsableReview(page), false);
    await assertNoUploadOrWrite(page);
    assert.equal((await mockState(page)).acknowledgements.includes('capture-error'), false);
    await page.locator('[data-action="float-discard"]').first().click();
    await settle(page);
    assert.ok((await mockState(page)).acknowledgements.includes('capture-error'));
    await assertNoUploadOrWrite(page);
  });

  await scenario('restore_failed retains valid OCR text as a locally reviewable warning without upload or save', async page => {
    await emit(page, { captureId: 'restore-failed', text: TEXT, error: 'restore_failed' });
    assert.equal(await hasUsableReview(page), true);
    assert.match(await page.locator('#floating-pending').innerText(), /未能自动返回花有数/);
    assert.equal((await mockState(page)).acknowledgements.includes('restore-failed'), false);
    await assertNoUploadOrWrite(page);
    await review(page);
    await page.waitForFunction(text => document.querySelector('#ai-input')?.value === text, TEXT);
    assert.equal(await page.locator('#draft-form').count(), 0);
    assert.ok((await mockState(page)).acknowledgements.includes('restore-failed'));
    assert.equal(await hasUsableReview(page), false);
    await assertNoUploadOrWrite(page);
  });

  await scenario('incoming capture preserves an existing manual-entry modal and unsaved fields', async page => {
    await page.locator('.topbar [data-action="add"]').click();
    await page.locator('#amount').fill('18.50');
    await page.locator('#note').fill('尚未保存的合成备注');
    await emit(page);
    assert.equal(await page.locator('#modal').evaluate(el => el.open), true);
    assert.equal(await page.locator('#record-form').count(), 1);
    assert.equal(await page.locator('#amount').inputValue(), '18.50');
    assert.equal(await page.locator('#note').inputValue(), '尚未保存的合成备注');
    assert.equal((await mockState(page)).acknowledgements.length, 0);
    await closeModal(page);
    await review(page);
    await page.waitForFunction(text => document.querySelector('#ai-input')?.value === text, TEXT);
    await assertNoUploadOrWrite(page);
  });

  await scenario('existing AI text needs explicit replacement and cancel does not consume native pending data', async page => {
    await nav(page, 'ai');
    await page.locator('#ai-input').fill('保留这段未发送的文字');
    await emit(page);
    await review(page);
    await page.locator('#modal [data-action="float-replace"]').waitFor();
    assert.equal(await page.locator('#ai-input').inputValue(), '保留这段未发送的文字');
    await closeModal(page);
    assert.equal((await mockState(page)).acknowledgements.length, 0);
    assert.equal(await page.locator('#ai-input').inputValue(), '保留这段未发送的文字');
    await review(page);
    await acceptReplacement(page);
    await page.waitForFunction(text => document.querySelector('#ai-input')?.value === text, TEXT);
    await assertNoUploadOrWrite(page);
  });

  await scenario('a new floating result cannot close or overwrite an existing AI draft confirmation modal', async page => {
    await nav(page, 'ai');
    await page.locator('#ai-input').fill('今天午饭25元');
    await page.locator('[data-action="parse"]').click();
    await page.locator('#draft-form').waitFor();
    await page.locator('[name="account-0"]').selectOption(BANK);
    await emit(page, { captureId: 'during-draft', text: '下一笔合成午饭18元' });
    assert.equal(await page.locator('#draft-form').count(), 1);
    assert.equal(await page.locator('[name="account-0"]').inputValue(), BANK);
    assert.equal(await storageRaw(page), RAW);
    assert.equal((await mockState(page)).parses.length, 1);
    await closeModal(page);
    await review(page);
    await acceptReplacement(page);
    await page.waitForFunction(() => document.querySelector('#ai-input')?.value === '下一笔合成午饭18元');
    assert.equal((await mockState(page)).parses.length, 1);
    assert.equal(await storageRaw(page), RAW);
  });

  await scenario('capture response crossing into the demonstration ledger is discarded and cannot reappear on return', async page => {
    await nav(page, 'settings');
    await page.evaluate(() => window.__floatMock.hold.getFloatingCapture = true);
    await emit(page, { captureId: 'in-flight-before-demo' });
    await page.waitForFunction(() => window.__floatMock.held.some(item => item.method === 'getFloatingCapture'));
    await page.locator('[data-action="demo"]').click();
    await page.evaluate(() => { window.__floatMock.hold.getFloatingCapture = false; window.__deliverFloating('getFloatingCapture'); });
    await settle(page);
    assert.equal(await hasUsableReview(page), false);
    await assertNoUploadOrWrite(page);
    await page.locator('[data-action="leave-demo"]').click();
    await settle(page);
    assert.equal(await hasUsableReview(page), false);
    await assertNoUploadOrWrite(page);
  });

  await scenario('accepted pending capture is invalidated by an external ledger epoch change', async page => {
    await emit(page, { captureId: 'before-ledger-change' });
    assert.equal(await hasUsableReview(page), true);
    await page.evaluate(key => {
      const next = JSON.parse(localStorage.getItem(key));
      next.budgets.day = 12345;
      const value = JSON.stringify(window.LedgerCore.validateState(next));
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
    }, KEY);
    await settle(page);
    assert.equal(await hasUsableReview(page), false);
    assert.equal((await storage(page)).budgets.day, 12345);
    assert.equal((await storage(page)).transactions.length, 0);
    assert.equal((await mockState(page)).parses.length, 0);
    await emit(page, { captureId: 'before-ledger-change' });
    assert.equal(await hasUsableReview(page), false);
  });

  await scenario('late AI response after a ledger switch cannot save a floating capture into another ledger', async page => {
    await emit(page);
    await review(page);
    await page.waitForFunction(() => !!document.querySelector('#ai-input'));
    await page.evaluate(() => window.__floatMock.holdParse = true);
    await page.locator('[data-action="parse"]').click();
    await page.waitForFunction(() => typeof window.__floatMock.pendingParse === 'function');
    await nav(page, 'settings');
    await page.locator('[data-action="demo"]').click();
    await page.evaluate(() => { window.__floatMock.holdParse = false; window.__floatMock.pendingParse(); });
    await settle(page);
    assert.equal(await page.locator('#draft-form').count(), 0);
    assert.equal(await storageRaw(page), RAW);
    await page.locator('[data-action="leave-demo"]').click();
    assert.equal(await storageRaw(page), RAW);
  });

  await scenario('stale status cannot re-enable the ball after stop; serializing actions is also safe', async page => {
    await nav(page, 'settings');
    await page.locator('[data-action="float-stop"]').first().waitFor();
    await page.evaluate(() => window.__floatMock.hold.getFloatingStatus = true);
    await page.locator('[data-action="float-refresh"]').first().click();
    await page.waitForFunction(() => window.__floatMock.held.some(item => item.method === 'getFloatingStatus' && !item.delivered));
    const stop = page.locator('[data-action="float-stop"]').first();
    const serialized = await stop.isDisabled();
    if (!serialized) await stop.click();
    await page.evaluate(() => { window.__floatMock.hold.getFloatingStatus = false; window.__deliverFloating('getFloatingStatus'); });
    await settle(page);
    if (serialized) await page.locator('[data-action="float-stop"]').first().click();
    await settle(page);
    await page.locator('[data-action="float-start"]').first().waitFor();
    assert.equal(await page.locator('[data-action="float-start"]').first().isDisabled(), false);
    assert.equal((await mockState(page)).calls.filter(c => c.method === 'stopFloatingBall').length, 1);
    await assertNoUploadOrWrite(page);
  }, { active: true });

  await scenario('permission and status errors do not claim enabled state or break manual bookkeeping', async page => {
    await nav(page, 'settings');
    await page.evaluate(() => window.__floatMock.overrides.startFloatingBall = { error: 'permission_denied' });
    await page.locator('[data-action="float-start"]').first().click();
    await settle(page);
    assert.equal(await page.locator('[data-action="float-start"]').first().isDisabled(), false);
    assert.notEqual((await page.locator('#toast').innerText()).trim(), '');
    await page.evaluate(() => window.__floatMock.overrides.getFloatingStatus = { error: 'unavailable' });
    await page.locator('[data-action="float-refresh"]').first().click();
    await settle(page);
    await assertNoUploadOrWrite(page);
    await saveManual(page);
    assert.equal((await storage(page)).transactions.length, 1);
    assert.equal((await mockState(page)).parses.length, 0);
  });

  await scenario('missing native floating bridge degrades without changing data or blocking manual entry', async page => {
    await nav(page, 'settings');
    const start = page.locator('[data-action="float-start"]').first();
    if (await start.isVisible().catch(() => false) && !(await start.isDisabled())) await start.click();
    await settle(page);
    assert.equal((await mockState(page)).calls.filter(c => /Floating/.test(c.method)).length, 0);
    await assertNoUploadOrWrite(page);
    await saveManual(page);
    assert.equal((await storage(page)).transactions.length, 1);
  }, { missingBridge: true });

  await scenario('floating status and pending banners fit a 390px viewport', async page => {
    await nav(page, 'settings');
    await emit(page, { captureId: 'layout', text: '<img src=x onerror=alert(1)>合成付款文字25元' });
    for (const name of ['settings', 'home', 'ai']) {
      await nav(page, name);
      const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      assert.ok(layout.width <= layout.viewport + 1, name + ' horizontal overflow');
    }
    assert.equal(await page.locator('img[src="x"]').count(), 0, 'recognized text must not become executable HTML');
    await assertNoUploadOrWrite(page);
    await page.screenshot({ path: path.join(OUTPUT, 'floating-pending-390.png'), fullPage: true });
  });

  process.stdout.write(JSON.stringify({ passed: passed.length, scenarios: passed, externalNetwork: false,
    nativeCapture: 'mocked', screenshot: path.join(OUTPUT, 'floating-pending-390.png') }, null, 2) + '\n');
})().catch(error => {
  process.stderr.write((error.stack || String(error)) + '\n');
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
