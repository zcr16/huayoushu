import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { floatingBall, floatView, display, screenshot } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { CaptureService, CaptureResult } from './CaptureService';

export interface FloatingStatus {
  appearance?: string;
  supported: boolean;
  active: boolean;
  busy: boolean;
  permission: string;
  capturePermission: string;
  menuPermission: string;
  pending: boolean;
  error?: string;
}

export interface FloatingCapture {
  captureId?: string;
  createdAt?: number;
  text?: string;
  imageBase64?: string;
  mime?: string;
  width?: number;
  height?: number;
  source?: string;
  error?: string;
  empty?: boolean;
}

// Process-local state only. The ball expands a menu; only its capture button captures.
// pixels stay in memory until the bundled page submits the explicit vision request.
export class FloatingLedgerService {
  static readonly shared: FloatingLedgerService = new FloatingLedgerService();
  private context: common.UIAbilityContext | undefined = undefined;
  private controller: floatingBall.FloatingBallController | undefined = undefined;
  private view: floatView.FloatViewController | undefined = undefined;
  private menuVisible: boolean = false;
  private menuListener: (() => void) | undefined = undefined;
  private listener: (() => void) | undefined = undefined;
  private active: boolean = false;
  private starting: boolean = false;
  private stopping: boolean = false;
  private capturing: boolean = false;
  private foreground: boolean = true;
  private generation: number = 0;
  private captureSequence: number = 0;
  private startTask: Promise<FloatingStatus> | undefined = undefined;
  private pending: FloatingCapture | undefined = undefined;
  private expiryTimer: number = -1;
  private appearance: string = 'whale';
  private avatar: image.PixelMap | undefined = undefined;
  private desiredEnabled: boolean = false;
  private reviewMode: boolean = false;
  private rebuilding: boolean = false;
  private closingBall: floatingBall.FloatingBallController | undefined = undefined;
  private closingView: floatView.FloatViewController | undefined = undefined;
  private ballClosed: boolean = false;
  private viewClosed: boolean = false;
  private closedListener: (() => void) | undefined = undefined;
  private closeTask: Promise<boolean> | undefined = undefined;
  private reviewTask: Promise<void> | undefined = undefined;
  private observedBallStopped: boolean = false;
  private observedViewStopped: boolean = true;
  private startRequested: boolean = false;

  setContext(context: common.UIAbilityContext): void { this.context = context; }
  setListener(listener: (() => void) | undefined): void { this.listener = listener; }
  setMenuListener(listener: (() => void) | undefined): void { this.menuListener = listener; }
  clearMenuListener(listener: () => void): void {
    if (this.menuListener === listener) this.menuListener = undefined;
  }
  getAppearance(): string { return this.appearance; }
  isMenuVisible(): boolean { return this.menuVisible; }
  private updateMenu(visible: boolean): void {
    this.menuVisible = visible;
    if (this.menuListener) this.menuListener();
  }
  notify(): void { if (this.listener) this.listener(); }

  onForeground(): void {
    this.foreground = true; this.expire(); this.notify();
    this.rebuildMenu().catch(() => {});
  }
  onBackground(): void { this.foreground = false; }

  private permission(name: Permissions): string {
    if (!this.context) return 'unknown';
    try {
      return abilityAccessCtrl.createAtManager().checkAccessTokenSync(
        this.context.applicationInfo.accessTokenId, name) === 0 ? 'granted' : 'missing';
    } catch { return 'unknown'; }
  }

  private supported(): boolean {
    try {
      return canIUse('SystemCapability.Window.SessionManager') &&
        canIUse('SystemCapability.WindowManager.WindowManager.Core') &&
        floatingBall.isFloatingBallEnabled() && floatView.isFloatViewEnabled();
    } catch { return false; }
  }

  getStatus(): FloatingStatus {
    this.expire();
    return {
      supported: this.supported(), active: this.active, appearance: this.appearance,
      busy: this.starting || this.stopping || this.capturing || this.rebuilding,
      permission: this.permission('ohos.permission.USE_FLOAT_BALL'),
      capturePermission: this.permission('ohos.permission.CUSTOM_SCREEN_CAPTURE'),
      menuPermission: this.permission('ohos.permission.FLOAT_VIEW'),
      pending: this.pending !== undefined
    };
  }

  private failure(error: string): FloatingStatus {
    const status = this.getStatus(); status.error = error; return status;
  }

  start(appearance: string = 'whale'): Promise<FloatingStatus> {
    if (this.starting || this.stopping || this.capturing || this.closeTask) return Promise.resolve(this.failure('float_busy'));
    if (this.active) return Promise.resolve(this.getStatus());
    if (this.controller || this.view) return Promise.resolve(this.failure('float_stop_failed'));
    if (!this.supported() || !this.context) return Promise.resolve(this.failure('float_unsupported'));
    if (this.permission('ohos.permission.USE_FLOAT_BALL') !== 'granted') {
      return Promise.resolve(this.failure('float_permission_missing'));
    }
    this.appearance = ['whale', 'star', 'robot'].includes(appearance) ? appearance : 'whale';
    this.desiredEnabled = true;
    this.reviewMode = false;
    this.starting = true;
    const generation = ++this.generation;
    const task = this.runStart(generation, this.context);
    this.startTask = task;
    this.notify();
    return task;
  }

  private async runStart(generation: number, context: common.UIAbilityContext): Promise<FloatingStatus> {
    try {
      if (this.permission('ohos.permission.FLOAT_VIEW') !== 'granted') {
        const permission = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(
          context, ['ohos.permission.FLOAT_VIEW']);
        if (generation !== this.generation) return this.getStatus();
        if (permission.authResults.length === 0 || permission.authResults[0] !== 0) {
          this.desiredEnabled = false;
          return this.failure('float_view_permission_denied');
        }
      }
      if (this.permission('ohos.permission.CUSTOM_SCREEN_CAPTURE') !== 'granted') {
        const permission = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(
          context, ['ohos.permission.CUSTOM_SCREEN_CAPTURE']);
        if (generation !== this.generation) return this.getStatus();
        if (permission.authResults.length === 0 || permission.authResults[0] !== 0) {
          this.desiredEnabled = false;
          return this.failure('capture_permission_denied');
        }
      }
      if (generation !== this.generation) return this.getStatus();
      const controller = await floatingBall.create({ context: context });
      if (generation !== this.generation) return this.getStatus();
      this.controller = controller;
      this.observedBallStopped = false; this.observedViewStopped = true; this.startRequested = false;
      controller.on('stateChange', (state: floatingBall.FloatingBallState) => {
        if (this.controller !== controller) return;
        this.active = state === floatingBall.FloatingBallState.STARTED;
        if (!this.active) {
          this.observedBallStopped = true;
          if (this.closingBall === controller) { this.ballClosed = true; this.checkClosed(); }
          else { this.desiredEnabled = false; ++this.generation; this.releaseStoppedSession(); }
        }
        this.notify();
      });
      // No click handler: the system's binding expands the menu without capture.
      controller.onDestroy(() => {
        if (this.controller !== controller) return;
        this.observedBallStopped = true;
        if (this.closingBall === controller) {
          this.ballClosed = true; this.active = false; this.checkClosed(); return;
        }
        this.desiredEnabled = false;
        this.active = false;
        this.releaseStoppedSession();
        ++this.generation;
        this.notify();
      });
      const data = await context.resourceManager.getRawFileContent('assistants/' + this.appearance + '.png');
      const source = image.createImageSource(data.buffer);
      try { this.avatar = await source.createPixelMap({ desiredSize: { width: 128, height: 128 } }); }
      finally { await source.release(); }
      if (generation !== this.generation) { this.releaseAvatar(); return this.getStatus(); }
      const title = this.appearance === 'star' ? 'Claude' : this.appearance === 'robot' ? 'GPT' : '鲸鱼娘';
      const color = this.appearance === 'star' ? '#FFF1DF' : this.appearance === 'robot' ? '#E4F7EF' : '#E8F3FF';
      const params: floatingBall.FloatingBallParams = {
        template: floatingBall.FloatingBallTemplate.STATIC,
        title: title, icon: this.avatar, backgroundColor: color
      };
      const view = await floatView.create({ context: context,
        templateType: floatView.FloatViewTemplateType.ROUNDED_RECTANGLE, isConfirmOnClose: true });
      if (generation !== this.generation) return this.getStatus();
      this.view = view;
      this.observedViewStopped = false;
      view.onStateChange((info: floatView.FloatViewStateChangeInfo) => {
        if (this.view !== view) return;
        this.updateMenu(info.state === floatView.FloatViewState.STARTED);
        // Hiding, collapsing and the sidebar keep the session and pending capture alive.
        if (info.state === floatView.FloatViewState.STOPPED || info.state === floatView.FloatViewState.ERROR) {
          this.active = false;
          if (info.state === floatView.FloatViewState.STOPPED) this.observedViewStopped = true;
          if (this.closingView === view && info.state === floatView.FloatViewState.STOPPED) {
            this.viewClosed = true;
            if (info.stopReason !== 'APP_STOP' && info.stopReason !== 'FLOATING_BALL_STOP') {
              this.desiredEnabled = false; ++this.generation;
            }
            this.checkClosed();
          } else { this.desiredEnabled = false; ++this.generation; this.releaseStoppedSession(); }
        }
        this.notify();
      });
      await view.setUIContext('pages/PetActions');
      if (generation !== this.generation) return this.getStatus();
      await this.sizeMenu(view);
      if (generation !== this.generation) return this.getStatus();
      await floatView.bind(view, controller, params);
      if (generation !== this.generation) return this.getStatus();
      this.startRequested = true;
      await controller.startFloatingBall(params);
      if (this.controller !== controller) return this.failure('float_start_failed');
      if (generation !== this.generation) return this.getStatus();
      this.active = true;
      // Prevent accidental capture of the ledger itself while it is open.
      await controller.setFloatingBallVisibilityInApp(false);
      await view.setFloatViewVisibilityInApp(false);
      return this.getStatus();
    } catch (error) {
      const code = (error as BusinessError).code;
      this.desiredEnabled = false;
      if (this.controller) {
        if (!this.startRequested) this.detach();
        else { try { await this.closeWindows(); } catch {} }
      }
      return this.failure(code === 201 ? 'float_view_permission_denied' : code === 801 ? 'float_unsupported' : 'float_start_failed');
    } finally {
      this.starting = false;
      this.startTask = undefined;
      this.notify();
    }
  }

  private async sizeMenu(view: floatView.FloatViewController): Promise<void> {
    const limits = floatView.getFloatViewLimits(floatView.FloatViewTemplateType.ROUNDED_RECTANGLE);
    const density = display.getDefaultDisplaySync().densityPixels;
    let width = Math.max(limits.minSize.width, Math.min(limits.maxSize.width, Math.round(288 * density)));
    let height = Math.max(limits.minSize.height, Math.min(limits.maxSize.height, Math.round(320 * density)));
    // Pick the nearest supported aspect interval, then fit within the pixel bounds.
    if (limits.ratioLimits.length > 0) {
      const requested = width / height;
      let ratio = requested;
      let distance = Number.MAX_VALUE;
      for (const range of limits.ratioLimits) {
        const candidate = Math.max(range.minRatio, Math.min(range.maxRatio, requested));
        if (Math.abs(candidate - requested) < distance) {
          ratio = candidate; distance = Math.abs(candidate - requested);
        }
      }
      const minHeight = Math.max(limits.minSize.height, limits.minSize.width / ratio);
      const maxHeight = Math.min(limits.maxSize.height, limits.maxSize.width / ratio);
      height = Math.max(minHeight, Math.min(maxHeight, height));
      width = height * ratio;
    }
    await view.setWindowSize({ width: Math.round(width), height: Math.round(height) });
  }

  async stop(): Promise<FloatingStatus> {
    if (this.stopping) return this.failure('float_busy');
    this.stopping = true;
    this.desiredEnabled = false;
    ++this.generation;
    this.notify();
    try {
      // A pending platform start must finish before stop, otherwise a late
      // start could recreate a ball after the user explicitly disabled it.
      const task = this.startTask;
      if (task) await task;
      const reviewTask = this.reviewTask;
      if (reviewTask) { try { await reviewTask; } catch {} }
      if (this.closeTask) await this.closeTask;
      if (this.controller && !await this.closeWindows()) return this.failure('float_stop_failed');
      this.active = false;
      return this.getStatus();
    } catch {
      return this.failure('float_stop_failed');
    } finally { this.stopping = false; this.notify(); }
  }

  private releaseAvatar(): void {
    const avatar = this.avatar; this.avatar = undefined;
    if (avatar) avatar.release().catch(() => {});
  }

  private checkClosed(): void {
    if (this.ballClosed && this.viewClosed && this.closedListener) this.closedListener();
  }

  private releaseStoppedSession(): void {
    if (!this.closingBall && this.observedBallStopped && this.observedViewStopped) this.detach();
  }

  private closeWindows(): Promise<boolean> {
    if (this.closeTask) return this.closeTask;
    const controller = this.controller;
    if (!controller) return Promise.resolve(true);
    // stop() waits for setup/review tasks first. An unstarted controller has no
    // window to stop; the platform rejects stopFloatingBall in that state.
    if (!this.startRequested) { this.detach(); return Promise.resolve(true); }
    const task = this.runClose(controller, this.view);
    this.closeTask = task;
    task.then(() => { if (this.closeTask === task) this.closeTask = undefined; });
    return task;
  }

  private async runClose(controller: floatingBall.FloatingBallController,
    view: floatView.FloatViewController | undefined): Promise<boolean> {
    this.closingBall = controller; this.closingView = view;
    this.ballClosed = this.observedBallStopped;
    this.viewClosed = view === undefined || this.observedViewStopped;
    let timer: number = -1;
    let closed = false;
    const barrier = new Promise<boolean>((resolve) => {
      this.closedListener = () => { resolve(true); };
      timer = setTimeout(() => { resolve(false); }, 2200);
      this.checkClosed();
    });
    try {
      if (!this.ballClosed) await controller.stopFloatingBall();
      closed = await barrier;
      if (closed && this.controller === controller) this.detach();
      return closed;
    } catch { return false; }
    finally {
      if (timer !== -1) clearTimeout(timer);
      this.closedListener = undefined;
      this.closingBall = undefined; this.closingView = undefined;
    }
  }

  private async rebuildMenu(): Promise<void> {
    if (!this.desiredEnabled || !this.foreground || this.capturing || this.starting ||
        this.stopping || this.rebuilding || (this.active && !this.reviewMode)) return;
    this.rebuilding = true;
    const generation = this.generation;
    try {
      if (this.controller && !await this.closeWindows()) return;
      if (generation !== this.generation || !this.desiredEnabled || !this.foreground) return;
      await this.start(this.appearance);
    } finally { this.rebuilding = false; this.notify(); }
  }

  private async returnForReview(generation: number): Promise<void> {
    if (generation !== this.generation || !this.desiredEnabled || !this.context) return;
    if (this.foreground) return;
    // API 26 offers an explicit public API for bringing this UIAbility forward.
    // No background-start privilege or third-party-app control is requested.
    try { await this.context.startSelf(); }
    catch (error) { console.info('HYS_PET_RETURN startSelf code=' + (error as BusinessError).code); }
    if (generation !== this.generation || !this.desiredEnabled || this.foreground) return;
    // Standard public self-ability launch is an independent compatibility path.
    // The OS still enforces normal foreground/background startup restrictions.
    try { await this.context.startAbility({ bundleName: 'com.huayoushu.ledger', abilityName: 'EntryAbility' }); }
    catch (error) { console.info('HYS_PET_RETURN startAbility code=' + (error as BusinessError).code); }
    for (let attempt = 0; attempt < 8 && !this.foreground; ++attempt) {
      if (generation !== this.generation || !this.desiredEnabled) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    }
    if (generation !== this.generation || !this.desiredEnabled || this.foreground) return;
    const task = this.createReviewBall(generation, this.context);
    this.reviewTask = task;
    try { await task; }
    catch (error) {
      console.info('HYS_PET_RETURN reviewBall code=' + (error as BusinessError).code);
      // Keep the captured image available when the user opens the app manually.
      if (this.pending) this.pending.error = 'restore_failed';
      if (this.controller && !this.active) {
        try { await this.controller.stopFloatingBall(); } catch {}
        this.detach();
      }
      this.notify();
    }
    finally { if (this.reviewTask === task) this.reviewTask = undefined; }
  }

  private async createReviewBall(generation: number, context: common.UIAbilityContext): Promise<void> {
    if (this.controller) return;
    const controller = await floatingBall.create({ context: context });
    if (generation !== this.generation || !this.desiredEnabled || this.foreground) return;
    this.controller = controller; this.reviewMode = true;
    this.observedBallStopped = false; this.observedViewStopped = true; this.startRequested = false;
    controller.on('stateChange', (state: floatingBall.FloatingBallState) => {
      if (this.controller !== controller) return;
      this.active = state === floatingBall.FloatingBallState.STARTED;
      if (!this.active) {
        this.observedBallStopped = true;
        if (this.closingBall === controller) { this.ballClosed = true; this.checkClosed(); }
        else { this.desiredEnabled = false; ++this.generation; this.releaseStoppedSession(); }
      }
      this.notify();
    });
    controller.onDestroy(() => {
      if (this.controller !== controller) return;
      this.observedBallStopped = true;
      if (this.closingBall === controller) { this.ballClosed = true; this.active = false; this.checkClosed(); return; }
      this.desiredEnabled = false; this.active = false; this.releaseStoppedSession(); ++this.generation; this.notify();
    });
    controller.on('click', () => {
      if (this.controller !== controller || !this.active || this.stopping) return;
      // This fallback ball only opens the retained result, never takes a screenshot.
      controller.restoreMainWindow({ bundleName: 'com.huayoushu.ledger', abilityName: 'EntryAbility' }).catch(() => {});
    });
    const data = await context.resourceManager.getRawFileContent('assistants/' + this.appearance + '.png');
    const source = image.createImageSource(data.buffer);
    try { this.avatar = await source.createPixelMap({ desiredSize: { width: 128, height: 128 } }); }
    finally { await source.release(); }
    if (generation !== this.generation || !this.desiredEnabled || this.foreground) {
      this.detach(); return;
    }
    this.startRequested = true;
    await controller.startFloatingBall({ template: floatingBall.FloatingBallTemplate.STATIC,
      title: '查看账单', icon: this.avatar, backgroundColor: '#E4F7EF' });
    if (generation !== this.generation || !this.desiredEnabled || this.foreground) {
      await this.closeWindows(); return;
    }
    await controller.setFloatingBallVisibilityInApp(false);
  }

  private detach(): void {
    this.updateMenu(false);
    const view = this.view;
    this.view = undefined;
    if (view) { try { view.offStateChange(); } catch {} }
    this.releaseAvatar();
    const controller = this.controller;
    this.controller = undefined;
    this.active = false;
    this.observedBallStopped = false; this.observedViewStopped = true; this.startRequested = false;
    if (controller) {
      try { controller.off('click'); } catch {}
      try { controller.off('stateChange'); } catch {}
      try { controller.offDestroy(); } catch {}
    }
  }

  getCapture(): FloatingCapture {
    this.expire();
    return this.pending ? this.pending : { empty: true };
  }

  acknowledge(captureId: string): boolean {
    this.expire();
    if (!this.pending || this.pending.captureId !== captureId) return false;
    this.clearPending();
    this.notify();
    return true;
  }

  private clearPending(): void {
    this.pending = undefined;
    if (this.expiryTimer !== -1) { clearTimeout(this.expiryTimer); this.expiryTimer = -1; }
  }

  private expire(): void {
    if (this.pending && this.pending.createdAt !== undefined && Date.now() - this.pending.createdAt >= 300000) {
      this.clearPending();
    }
  }

  private deliver(text: string | undefined, error: string | undefined, receipt?: CaptureResult): void {
    const createdAt = Date.now();
    this.clearPending();
    this.pending = { captureId: 'float_' + createdAt.toString() + '_' + (++this.captureSequence).toString(),
      createdAt: createdAt, source: 'floating', text: text, error: error,
      imageBase64: receipt?.imageBase64, mime: receipt?.mime, width: receipt?.width, height: receipt?.height };
    this.expiryTimer = setTimeout(() => { this.clearPending(); this.notify(); }, 300000);
    this.notify();
  }

  private async restore(controller: floatView.FloatViewController): Promise<boolean> {
    try {
      await controller.restoreMainWindow();
      this.notify();
      return true;
    } catch { return false; }
  }

  async captureFromMenu(): Promise<void> {
    const controller = this.view;
    if (!this.controller || !controller || !this.active || !this.menuVisible || this.foreground ||
        this.starting || this.stopping || this.capturing) return;
    this.expire();
    if (this.pending) { await this.restore(controller); return; }
    const generation = this.generation;
    if (!CaptureService.reserveFloatingCapture()) {
      this.deliver(undefined, 'float_busy'); await this.restore(controller); return;
    }
    this.capturing = true; this.notify();
    let pixels: image.PixelMap | undefined = undefined;
    let stage: string = 'permission';
    try {
      if (this.permission('ohos.permission.CUSTOM_SCREEN_CAPTURE') !== 'granted') {
        this.deliver(undefined, 'screen_capture_denied');
        await this.restore(controller); return;
      }
      // The platform cannot hide a floatView with Window.minimize. Stop the
      // bound pair and await BOTH terminal callbacks instead. No window from
      // this app remains to obstruct the underlying payment screen.
      stage = 'close_windows';
      const closed = await this.closeWindows();
      if (generation !== this.generation || !this.desiredEnabled || this.foreground) return;
      if (!closed) throw new Error('menu_close_failed');
      await new Promise<void>((resolve) => { setTimeout(resolve, 160); });
      if (generation !== this.generation || !this.desiredEnabled || this.foreground || this.controller || this.view) return;
      stage = 'capture';
      pixels = await screenshot.capture({});
      if (generation !== this.generation || !this.desiredEnabled) return;
      stage = 'image_info';
      const info = await pixels.getImageInfo();
      if (generation !== this.generation) return;
      if (info.size.width < 10 || info.size.height < 10 || info.size.width * info.size.height > 50000000) {
        this.deliver(undefined, 'screen_protected_or_empty');
        await this.returnForReview(generation); return;
      }
      if (info.pixelFormat !== image.PixelMapFormat.RGBA_8888) {
        await pixels.convertPixelFormat(image.PixelMapFormat.RGBA_8888);
      }
      if (generation !== this.generation) return;
      stage = 'encode';
      const recognized = await CaptureService.encodeReceipt(pixels);
      if (generation !== this.generation) return;
      this.deliver(undefined, recognized.error, recognized);
      stage = 'return_to_app';
      await this.returnForReview(generation);
    } catch (error) {
      if (generation === this.generation && this.desiredEnabled) {
        const code = (error as BusinessError).code;
        // Diagnostic contains only stage/error code, never screen content or credentials.
        console.warn('HYS_PET_CAPTURE stage=' + stage + ' code=' + code);
        this.deliver(undefined, code === 201 ? 'screen_capture_denied' :
          (error as Error).message === 'menu_close_failed' ? 'float_stop_failed' : 'screen_capture_failed');
        if (this.view && this.menuVisible) await this.restore(this.view);
        else { try { await this.returnForReview(generation); } catch {} }
      }
    } finally {
      if (pixels) { try { await pixels.release(); } catch {} }
      CaptureService.releaseFloatingCapture();
      this.capturing = false; this.notify();
      await this.rebuildMenu();
    }
  }

  destroy(): void {
    this.listener = undefined;
    this.menuListener = undefined;
    this.clearPending();
    this.stop().catch(() => {});
    this.context = undefined;
  }
}
