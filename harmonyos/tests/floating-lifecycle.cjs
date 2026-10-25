// Lifecycle simulation only; passing mocks do not establish device API support.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require(process.env.HYS_TYPESCRIPT_PATH || 'typescript');
const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/pages/FloatingLedgerService.ets'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const V = { STARTED: 1, HIDDEN: 2, STOPPED: 3, IN_SIDEBAR: 4, IN_FLOATING_BALL: 5, ERROR: 6 };
function harness(o = {}) {
  const events = [], timers = new Map(), balls = [], views = [];
  let now = 1000000, timerId = 0, service, reserved = false;
  let capturePermission = !o.requestPermission, viewPermission = !o.requestViewPermission;
  const pixels = {
    async getImageInfo() { events.push('info'); return { size: { width: 1080, height: 2400 }, pixelFormat: o.convert ? 2 : 1 }; },
    async convertPixelFormat() { events.push('convert'); },
    async release() { events.push('release_pixels'); }
  };
  function emitBallStopped(ball = balls[0]) {
    ball.running = false; events.push('ball_stopped'); ball.callbacks.stateChange?.(2);
  }
  function emitViewStopped(view = views[0], reason = 'FLOATING_BALL_STOP') {
    view.running = false; events.push('view_stopped'); view.callbacks.state?.({ state: V.STOPPED, stopReason: reason });
  }
  function createBall() {
    const ball = { index: balls.length, callbacks: {}, running: false, boundView: undefined,
      on(name, cb) { ball.callbacks[name] = cb; }, off(name) { delete ball.callbacks[name]; },
      onDestroy(cb) { ball.callbacks.destroy = cb; }, offDestroy() { delete ball.callbacks.destroy; },
      async startFloatingBall(params) {
        const review = !ball.boundView;
        assert.equal(params.title === '查看账单', review, 'only review ball can start unbound');
        events.push(review ? 'start_review' : 'start_bound');
        const gate = review ? o.reviewStartGate : ball.index === 0 ? o.startGate : undefined;
        if (gate) await gate.promise;
        ball.running = true; ball.callbacks.stateChange?.(1);
        if (ball.boundView) {
          ball.boundView.running = true;
          ball.boundView.callbacks.state?.({ state: V.IN_FLOATING_BALL, stopReason: '' });
        }
        if (o.systemStopDuringStart && ball.index === 0) {
          emitBallStopped(ball); if (ball.boundView) emitViewStopped(ball.boundView);
        }
      },
      async stopFloatingBall() {
        events.push('stop');
        if (!ball.running) throw { code: 1300025 };
        if (o.stopFail) throw { code: 1300023 };
        if (o.manualClose && ball.index === 0) return;
        if (o.viewFirst && ball.boundView) emitViewStopped(ball.boundView);
        emitBallStopped(ball);
        if (!o.viewFirst && ball.boundView) emitViewStopped(ball.boundView);
      },
      async setFloatingBallVisibilityInApp(value) { assert.equal(value, false); events.push('hide_in_app'); },
      async restoreMainWindow(want) {
        assert.equal(ball.boundView, undefined, 'only fallback ball restores using ball click');
        assert.equal(want.bundleName, 'com.huayoushu.ledger'); events.push('restore_review');
        if (o.restoreFail) throw { code: 1300026 };
        if (!o.reviewRestoreNoForeground) service.onForeground();
      }
    };
    balls.push(ball); return ball;
  }
  function createView(config) {
    assert.equal(config.isConfirmOnClose, true);
    const view = { index: views.length, callbacks: {}, running: false,
      onStateChange(cb) { view.callbacks.state = cb; }, offStateChange() { delete view.callbacks.state; },
      async setUIContext(page) {
        assert.equal(page, 'pages/PetActions'); events.push('view_page');
        if (o.failUISetup) throw { code: 1300002 };
      },
      async setWindowSize(size) { assert.ok(Number.isFinite(size.width) && size.width > 0); assert.ok(Number.isFinite(size.height) && size.height > 0); },
      async setFloatViewVisibilityInApp(value) { assert.equal(value, false); },
      async restoreMainWindow() {
        events.push('restore_view'); if (o.restoreFail) throw { code: 1300031 };
        service.onForeground();
      }
    };
    views.push(view); return view;
  }
  const modules = {
    '@kit.AbilityKit': { abilityAccessCtrl: { createAtManager: () => ({
      checkAccessTokenSync(token, name) {
        if (name.endsWith('USE_FLOAT_BALL')) return o.missingAcl ? -1 : 0;
        if (name.endsWith('FLOAT_VIEW')) return viewPermission ? 0 : -1;
        assert.equal(name, 'ohos.permission.CUSTOM_SCREEN_CAPTURE'); return capturePermission ? 0 : -1;
      },
      async requestPermissionsFromUser(context, permissions) {
        const names = Array.from(permissions); assert.equal(names.length, 1);
        const isView = names[0] === 'ohos.permission.FLOAT_VIEW';
        assert.ok(isView || names[0] === 'ohos.permission.CUSTOM_SCREEN_CAPTURE');
        events.push(isView ? 'request_view_permission' : 'request_permission');
        const gate = isView ? o.viewPermissionGate : o.permissionGate;
        const result = gate ? await gate.promise : { authResults: (isView ? o.denyViewPermission : o.denyPermission) ? [-1] : [0] };
        if (isView) viewPermission = result.authResults[0] === 0; else capturePermission = result.authResults[0] === 0;
        return result;
      }
    }) } },
    '@kit.ArkUI': {
      floatingBall: { FloatingBallState: { STARTED: 1, STOPPED: 2 }, FloatingBallTemplate: { STATIC: 1, NORMAL: 2 },
        isFloatingBallEnabled() { return !o.unsupported; },
        async create() {
          events.push('create_ball');
          if (balls.length > 0 && o.reviewCreateFail) throw { code: 1300020 };
          const gate = balls.length === 0 ? o.createGate : balls.length === 1 ? o.reviewCreateGate : undefined;
          if (gate) await gate.promise;
          return createBall();
        }
      },
      floatView: { FloatViewState: V, FloatViewTemplateType: { ROUNDED_RECTANGLE: 0, HORIZONTAL_BAR: 1 },
        isFloatViewEnabled() { return !o.unsupportedView; },
        getFloatViewLimits() { return { minSize: { width: 480, height: 480 }, maxSize: { width: 1000, height: 1500 }, ratioLimits: [{ minRatio: 0.5, maxRatio: 2 }] }; },
        async create(config) { events.push('create_view'); if (o.viewCreateGate && !views.length) await o.viewCreateGate.promise; return createView(config); },
        async bind(view, ball) {
          assert.equal(ball.running, false); assert.equal(view.running, false); events.push('bind');
          if (o.bindGate && ball.index === 0) await o.bindGate.promise;
          ball.boundView = view;
        }
      },
      display: { getDefaultDisplaySync: () => ({ densityPixels: 3, width: 1080, height: 2400 }) },
      screenshot: { async capture(params) {
        events.push('capture_attempt');
        assert.deepEqual(Object.keys(params), [], 'no stale window IDs after teardown');
        assert.ok(balls.every(ball => !ball.running), 'every ball must be stopped');
        assert.ok(views.every(view => !view.running), 'every view must be stopped');
        events.push('capture');
        if (o.captureGate) await o.captureGate.promise;
        if (o.captureFail) throw { code: o.captureFail }; return pixels;
      } }
    },
    '@kit.ImageKit': { image: { PixelMapFormat: { RGBA_8888: 1 }, createImageSource() { return { async createPixelMap() { return { async release() { events.push('release_avatar'); } }; }, async release() {} }; } } },
    './CaptureService': { CaptureService: {
      reserveFloatingCapture() { if (reserved || o.otherCaptureBusy) return false; reserved = true; events.push('reserve'); return true; },
      releaseFloatingCapture() { assert.equal(reserved, true); reserved = false; events.push('release_lock'); },
      async encodeReceipt(value) {
        assert.equal(value, pixels); events.push('encode'); if (o.ocrGate) await o.ocrGate.promise;
        return o.ocrError ? { error: o.ocrError } : { imageBase64: 'synthetic-image-base64', mime: 'image/jpeg' };
      }
    } }
  };
  const context = { exports: {}, require: name => { assert.ok(modules[name], name); return modules[name]; },
    Date: { now: () => now }, JSON, Number, Math, Error, Promise,
    console: { info() {}, warn() {}, error() {}, log() {} }, canIUse: () => !o.unsupported,
    setTimeout(fn, duration) {
      const id = ++timerId;
      if (duration >= 2200) timers.set(id, { fn, duration });
      else {
        events.push('delay_' + duration);
        const gate = duration === 160 ? o.renderGate : undefined;
        (gate ? gate.promise : Promise.resolve()).then(fn);
      }
      return id;
    }, clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(code, context, { filename: 'FloatingLedgerService.js' });
  service = context.exports.FloatingLedgerService.shared;
  service.setContext({
    applicationInfo: { accessTokenId: 42 }, resourceManager: { async getRawFileContent() { return new Uint8Array(8); } },
    async startSelf() {
      events.push('start_self'); if (o.startSelfGate) await o.startSelfGate.promise;
      if (o.startSelfReject) throw { code: 801 };
      if (!o.noSelfForeground) service.onForeground();
    },
    async startAbility(want) {
      assert.equal(want.bundleName, 'com.huayoushu.ledger');
      assert.equal(want.abilityName, 'EntryAbility');
      events.push('start_ability');
      if (!o.standardStartSucceeds) throw { code: 16000053 };
      service.onForeground();
    }
  });
  service.setListener(() => events.push('notify'));
  return { service, events, timers, balls, views, emitBallStopped, emitViewStopped,
    click(ball = balls[balls.length - 1]) {
      ball.callbacks.click?.();
      if (ball.running && ball.boundView) ball.boundView.callbacks.state?.({ state: V.STARTED, stopReason: '' });
    },
    capture() { return service.captureFromMenu(); },
    viewState(state, reason = '', view = views[views.length - 1]) { view.callbacks.state?.({ state, stopReason: reason }); },
    advance(ms) { now += ms; }, revoke() { capturePermission = false; },
    fire(duration) { const timer = [...timers.entries()].find(([, item]) => item.duration === duration); assert.ok(timer, 'timer ' + duration); timers.delete(timer[0]); timer[1].fn(); },
    count(name) { return events.filter(x => x === name).length; },
    get reserved() { return reserved; },
    async enable() { await service.start(); service.onBackground(); }, async open() { await this.enable(); this.click(); }
  };
}
test('missing ACL and unsupported ball or menu cannot start or request permissions', async () => {
  const h = harness({ missingAcl: true }); assert.equal((await h.service.start()).error, 'float_permission_missing'); assert.deepEqual(h.events, []);
  for (const option of ['unsupported','unsupportedView']) {
    const old = harness({ [option]: true }); assert.equal((await old.service.start()).error, 'float_unsupported');
    assert.equal(old.count('start_bound'), 0); assert.equal(old.count('capture_attempt'), 0);
  }
});
test('view and capture permissions are independent and requested only by explicit enable', async () => {
  const ok = harness({ requestViewPermission: true, requestPermission: true });
  ok.service.getStatus(); assert.deepEqual(ok.events, []); await ok.enable();
  assert.ok(ok.events.indexOf('request_view_permission') < ok.events.indexOf('request_permission'));
  for (const option of ['view','capture']) {
    const h = harness(option === 'view' ? { requestViewPermission: true, denyViewPermission: true } : { requestPermission: true, denyPermission: true });
    assert.equal((await h.service.start()).error, option === 'view' ? 'float_view_permission_denied' : 'capture_permission_denied');
    assert.equal(h.count('create_ball'), 0); assert.equal(h.service.getStatus().active, false);
  }
});
test('stop during permission, controller creation or binding prevents a late start', async () => {
  for (const mode of ['viewPermission','permission','create','viewCreate','bind']) {
    const gate = deferred(), options = { [mode + 'Gate']: gate };
    if (mode === 'viewPermission') options.requestViewPermission = true;
    if (mode === 'permission') options.requestPermission = true;
    const h = harness(options), start = h.service.start(); await flush(); const stop = h.service.stop();
    gate.resolve({ authResults: [0] }); await start; const stopped = await stop;
    assert.equal(h.count('start_bound'), 0, mode); assert.equal(h.service.getStatus().active, false, mode);
    assert.equal(stopped.error, undefined, mode);
    const restarted = await h.service.start();
    assert.equal(restarted.error, undefined, mode); assert.equal(restarted.active, true, mode);
  }
});
test('stop waits for an in-flight bound start and closes its late windows', async () => {
  const gate = deferred(), h = harness({ startGate: gate }), start = h.service.start(); await flush(); const stop = h.service.stop();
  assert.equal(h.count('stop'), 0); gate.resolve(); await start; await stop;
  assert.ok(h.balls.every(ball => !ball.running)); assert.ok(h.views.every(view => !view.running));
  assert.equal(h.service.getStatus().active, false);
});
test('system close during start is not overwritten by later Promise completion', async () => {
  const h = harness({ systemStopDuringStart: true }); await h.open(); await h.capture();
  assert.equal(h.service.getStatus().active, false); assert.equal(h.count('capture_attempt'), 0);
});
test('terminal STOPPED callbacks alone release closed windows and allow explicit re-enable', async () => {
  for (const mode of ['ball_first', 'view_first', 'review']) {
    const h = harness(mode === 'review' ? { startSelfReject: true } : {}); await h.open();
    if (mode === 'review') {
      await h.capture(); h.emitBallStopped(h.balls[1]);
    } else if (mode === 'ball_first') {
      h.emitBallStopped(); h.emitViewStopped(h.views[0], 'TITLE_BAR_STOP_CLICK');
    } else {
      h.emitViewStopped(h.views[0], 'TITLE_BAR_STOP_CLICK'); h.emitBallStopped();
    }
    assert.equal(h.service.getStatus().active, false, mode);
    assert.ok(h.balls.every(ball => !ball.running)); assert.ok(h.views.every(view => !view.running));
    h.service.onForeground(); await flush();
    const result = await h.service.start();
    assert.equal(result.error, undefined, mode); assert.equal(result.active, true, mode);
    assert.equal(h.count('start_bound'), 2, mode);
  }
});
test('pre-start UI setup failure can be retried even if stopping an unstarted ball is rejected', async () => {
  const options = { failUISetup: true }, h = harness(options);
  assert.equal((await h.service.start()).error, 'float_start_failed');
  assert.ok(h.balls.every(ball => !ball.running)); assert.ok(h.views.every(view => !view.running));
  options.failUISetup = false;
  const result = await h.service.start();
  assert.equal(result.error, undefined); assert.equal(result.active, true); assert.equal(h.count('start_bound'), 1);
});
test('obsolete menu page cannot unregister the current page listener', async () => {
  const h = harness(); let oldCalls = 0, currentCalls = 0;
  const old = () => ++oldCalls, current = () => ++currentCalls;
  h.service.setMenuListener(old); h.service.setMenuListener(current); h.service.clearMenuListener(old);
  await h.enable(); oldCalls = 0; currentCalls = 0; h.click();
  assert.equal(oldCalls, 0); assert.equal(currentCalls, 1); assert.equal(h.service.isMenuVisible(), true);
  h.service.clearMenuListener(current); h.viewState(V.HIDDEN);
  assert.equal(currentCalls, 1); assert.equal(h.service.isMenuVisible(), false);
});
test('ball click and menu visibility changes never capture, reserve or restore', async () => {
  const h = harness(); await h.enable(); assert.equal(h.balls[0].callbacks.click, undefined); h.click();
  for (const state of [V.HIDDEN,V.IN_FLOATING_BALL,V.IN_SIDEBAR]) {
    h.viewState(state); assert.equal(h.service.isMenuVisible(), false); assert.equal(h.service.getStatus().active, true); h.click();
  }
  for (const event of ['reserve','capture_attempt','restore_view','start_self']) assert.equal(h.count(event), 0, event);
});
test('capture requires a visible background menu and returns one retained image before rebuilding', async () => {
  const h = harness({ convert: true }); await h.service.start(); h.click(); await h.capture(); assert.equal(h.count('capture_attempt'), 0);
  h.service.onBackground(); h.viewState(V.IN_FLOATING_BALL); await h.capture(); assert.equal(h.count('capture_attempt'), 0);
  h.click(); const a = h.capture(), b = h.capture(); await a; await b;
  assert.equal(h.count('capture'), 1); assert.equal(h.count('start_self'), 1); assert.equal(h.count('start_bound'), 2);
  assert.ok(h.events.indexOf('encode') < h.events.indexOf('start_self'));
  assert.ok(h.events.indexOf('release_lock') < h.events.lastIndexOf('start_bound'));
  assert.ok(h.events.includes('convert')); assert.ok(h.events.includes('release_pixels'));
  assert.equal(h.service.getCapture().imageBase64, 'synthetic-image-base64'); assert.equal(h.reserved, false);
});
test('teardown waits for both terminal callbacks in either order before screenshot', async () => {
  for (const order of ['ball','view']) {
    const h = harness({ manualClose: true }); await h.open(); const capture = h.capture(); await flush();
    if (order === 'ball') h.emitBallStopped(); else h.emitViewStopped(); await flush();
    assert.equal(h.count('capture_attempt'), 0, order + ' first cannot capture');
    if (order === 'ball') h.emitViewStopped(); else h.emitBallStopped();
    await capture; assert.equal(h.count('capture'), 1); assert.ok(h.service.getCapture().imageBase64);
  }
});
test('teardown timeout never screenshots when either window remains alive', async () => {
  for (const first of ['ball','view','neither']) {
    const h = harness({ manualClose: true }); await h.open(); const capture = h.capture(); await flush();
    if (first === 'ball') h.emitBallStopped(); if (first === 'view') h.emitViewStopped();
    h.fire(2200); await flush();
    // Failure recovery can retry closing the pair after bringing the app forward.
    for (let retry = 0; retry < 3; ++retry) {
      if (![...h.timers.values()].some(timer => timer.duration === 2200)) break;
      h.fire(2200); await flush();
    }
    await capture;
    assert.equal(h.count('capture_attempt'), 0, first); assert.equal(h.service.getCapture().error, 'float_stop_failed');
    assert.equal(h.reserved, false);
  }
});
test('explicit stop while internal teardown is pending cancels capture and reconstruction', async () => {
  const h = harness({ manualClose: true }); await h.open(); const capture = h.capture(); await flush();
  const stop = h.service.stop(); h.emitViewStopped(); h.emitBallStopped(); await capture; await stop;
  assert.equal(h.count('capture_attempt'), 0); assert.equal(h.count('start_self'), 0); assert.equal(h.count('start_bound'), 1);
  assert.equal(h.service.getStatus().active, false); assert.equal(h.reserved, false);
});
test('user close reason during internal teardown cancels capture', async () => {
  const h = harness({ manualClose: true }); await h.open(); const capture = h.capture(); await flush();
  h.emitViewStopped(h.views[0], 'TITLE_BAR_STOP_CLICK'); h.emitBallStopped(); await capture;
  assert.equal(h.count('capture_attempt'), 0); assert.equal(h.count('start_self'), 0); assert.equal(h.reserved, false);
});
test('returning to app during compositor delay never screenshots the ledger', async () => {
  const gate = deferred(), h = harness({ renderGate: gate }); await h.open(); const capture = h.capture(); await flush();
  h.service.onForeground(); gate.resolve(); await capture;
  assert.equal(h.count('capture_attempt'), 0); assert.equal(h.count('start_bound'), 2); assert.equal(h.reserved, false);
});
test('startSelf rejection or absent foreground callback creates review-only fallback ball', async () => {
  for (const option of ['startSelfReject','noSelfForeground']) {
    const h = harness({ [option]: true }); await h.open(); await h.capture();
    assert.equal(h.count('capture'), 1); assert.equal(h.count('start_review'), 1);
    assert.ok(h.service.getCapture().imageBase64); assert.equal(h.views.length, 1);
    h.click(); await flush();
    assert.equal(h.count('restore_review'), 1); assert.equal(h.count('capture'), 1);
    assert.equal(h.count('start_bound'), 2); assert.equal(h.balls[1].running, false);
    assert.ok(h.service.getCapture().imageBase64);
  }
});
test('ordinary self startAbility restores foreground after startSelf 801 without a review ball', async () => {
  const h = harness({ startSelfReject: true, standardStartSucceeds: true }); await h.open(); await h.capture();
  assert.equal(h.count('start_self'), 1); assert.equal(h.count('start_ability'), 1);
  assert.equal(h.count('start_review'), 0); assert.equal(h.count('start_bound'), 2);
  assert.equal(h.count('capture'), 1); assert.equal(h.service.getCapture().imageBase64, 'synthetic-image-base64');
  assert.equal(h.reserved, false);
});
test('pending survives delayed listener, rereads, reconstruction and stop; ACK must match', async () => {
  const h = harness(); await h.open(); h.service.setListener(undefined); await h.capture();
  const first = h.service.getCapture(); assert.equal(first.createdAt, 1000000);
  assert.equal(h.service.getCapture().captureId, first.captureId);
  h.service.onBackground(); h.click(); await h.capture(); assert.equal(h.count('capture'), 1); assert.equal(h.count('restore_view'), 1);
  await h.service.stop(); assert.equal(h.service.getCapture().captureId, first.captureId);
  assert.equal(h.service.acknowledge('wrong'), false); assert.equal(h.service.acknowledge(first.captureId), true);
  assert.equal(h.service.getCapture().empty, true); assert.equal(h.timers.size, 0);
});
test('failed fallback creation preserves the screenshot and reports restoration warning', async () => {
  const h = harness({ startSelfReject: true, reviewCreateFail: true }); await h.open(); await h.capture();
  assert.equal(h.count('capture'), 1); assert.equal(h.service.getCapture().imageBase64, 'synthetic-image-base64');
  assert.equal(h.service.getCapture().error, 'restore_failed'); assert.equal(h.reserved, false);
});
test('pending expires after five minutes; clicking stale review ball never recaptures', async () => {
  const h = harness({ startSelfReject: true }); await h.open(); await h.capture();
  assert.equal([...h.timers.values()][0].duration, 300000); h.advance(299999); assert.ok(h.service.getCapture().imageBase64);
  h.advance(1); assert.equal(h.service.getCapture().empty, true); h.click(); await flush();
  assert.equal(h.count('capture'), 1); assert.equal(h.timers.size, 0);
});
test('stop during capture or encoding drops late results and releases PixelMap and reservation', async () => {
  for (const phase of ['capture','ocr']) {
    const gate = deferred(), h = harness({ [phase + 'Gate']: gate }); await h.open(); const capture = h.capture(); await flush();
    await h.service.stop(); gate.resolve(); await capture;
    assert.ok(h.events.includes('release_pixels')); assert.equal(h.service.getCapture().empty, true);
    assert.equal(h.count('start_self'), 0); assert.equal(h.count('start_review'), 0); assert.equal(h.reserved, false);
    if (phase === 'capture') assert.equal(h.count('encode'), 0);
  }
});
test('late callbacks from stopped windows cannot cancel rebuilt menu or retained result', async () => {
  const h = harness(); await h.open();
  const oldBall = h.balls[0].callbacks.stateChange, oldDestroy = h.balls[0].callbacks.destroy, oldView = h.views[0].callbacks.state;
  await h.capture(); oldBall(2); oldDestroy('system'); oldView({ state: V.STOPPED, stopReason: 'TITLE_BAR_STOP_CLICK' });
  assert.equal(h.service.getStatus().active, true); assert.ok(h.service.getCapture().imageBase64);
});
test('revoked permission, screenshot error and encoder error remain recoverable without false images', async () => {
  for (const error of ['screen_capture_denied','screen_capture_failed','ocr_failed']) {
    const h = harness(error === 'screen_capture_failed' ? { captureFail: 1400003 } : error === 'ocr_failed' ? { ocrError: 'ocr_failed' } : {});
    await h.open(); if (error === 'screen_capture_denied') h.revoke(); await h.capture();
    assert.equal(h.service.getCapture().error, error); assert.equal(h.service.getCapture().imageBase64, undefined); assert.equal(h.reserved, false);
    if (error === 'screen_capture_denied') assert.equal(h.count('capture_attempt'), 0);
  }
});
test('stop failure preserves active status; competing capture never closes windows or screenshots', async () => {
  const h = harness({ stopFail: true }); await h.open();
  assert.equal((await h.service.stop()).error, 'float_stop_failed'); assert.equal(h.service.getStatus().active, true);
  const busy = harness({ otherCaptureBusy: true }); await busy.open(); await busy.capture();
  assert.equal(busy.service.getCapture().error, 'float_busy'); assert.equal(busy.count('stop'), 0); assert.equal(busy.count('capture_attempt'), 0);
});
test('stop during review-ball platform start cannot leave a late orphan ball', async () => {
  const gate = deferred(), h = harness({ startSelfReject: true, reviewStartGate: gate }); await h.open();
  const capture = h.capture(); await flush(); assert.equal(h.count('start_review'), 1);
  const stop = h.service.stop(); await flush(); gate.resolve(); await capture; await stop;
  assert.ok(h.balls.every(ball => !ball.running), 'all balls remain stopped after user disable');
  assert.equal(h.service.getStatus().active, false); assert.equal(h.reserved, false);
});

