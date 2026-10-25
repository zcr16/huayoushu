import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { webview } from '@kit.ArkWeb';
import { http } from '@kit.NetworkKit';
import { CaptureService } from './CaptureService';
import { FloatingLedgerService, FloatingStatus } from './FloatingLedgerService';

interface BridgeHttpResult {
  status: number;
  body: string;
}

// Only explicitly registered capabilities are exposed to the bundled page. JavaScript never
// chooses a file path; the operating system picker grants access to the chosen
// URI. The network call accepts a full https URL, but only from the bundled
// resource:// page, with no credentials, fragment or redirect.
export class LedgerBridge {
  private context: common.UIAbilityContext | undefined = undefined;
  private controller: webview.WebviewController;
  private saving: boolean = false;
  private capture: CaptureService;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
    this.capture = new CaptureService(
      (id: string, payload: string) => this.respond(id, payload),
      (id: string, state: string) => {
        if (!this.onBundlePage()) return;
        const script = 'window.__hysCaptureState && window.__hysCaptureState(' +
          JSON.stringify(id) + ',' + JSON.stringify(state) + ')';
        this.controller.runJavaScript(script).catch(() => {});
      }
    );
  }

  setContext(context: common.UIAbilityContext): void {
    this.context = context;
    this.capture.setContext(context);
    FloatingLedgerService.shared.setContext(context);
    FloatingLedgerService.shared.setListener(() => this.pageReady());
  }

  pageReady(): void {
    if (!this.onBundlePage()) return;
    this.controller.runJavaScript('window.__hysFloatingCaptureReady && window.__hysFloatingCaptureReady()').catch(() => {});
  }

  detach(): void { FloatingLedgerService.shared.setListener(undefined); }

  getFloatingStatus(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.respond(id, JSON.stringify(FloatingLedgerService.shared.getStatus()));
  }

  startFloatingBall(id: string, appearance: string = 'whale'): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    FloatingLedgerService.shared.start(appearance).then((result: FloatingStatus) => {
      const status = FloatingLedgerService.shared.getStatus();
      status.error = result.error;
      this.respond(id, JSON.stringify(status));
    }).catch(() => this.respond(id, '{"error":"float_start_failed"}'));
  }

  stopFloatingBall(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    FloatingLedgerService.shared.stop().then((result: FloatingStatus) => {
      const status = FloatingLedgerService.shared.getStatus();
      status.error = result.error;
      this.respond(id, JSON.stringify(status));
    }).catch(() => this.respond(id, '{"error":"float_stop_failed"}'));
  }

  getFloatingCapture(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.respond(id, JSON.stringify(FloatingLedgerService.shared.getCapture()));
  }

  ackFloatingCapture(id: string, captureId: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    const acknowledged = typeof captureId === 'string' && captureId.length < 100 &&
      FloatingLedgerService.shared.acknowledge(captureId);
    this.respond(id, JSON.stringify({ acknowledged: acknowledged }));
  }

  pickReceiptImage(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.capture.pickReceiptImage(id);
  }

  recognizeScreenshot(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.capture.recognizeScreenshot(id);
  }

  recognizeVoice(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.capture.recognizeVoice(id);
  }

  stopVoice(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.capture.stopVoice(id);
  }

  cancelVoice(id: string): void {
    if (!this.onBundlePage()) { this.respond(id, '{"error":"unavailable"}'); return; }
    this.capture.cancelVoice(id);
  }

  private onBundlePage(): boolean {
    try {
      return /^resource:\/{1,2}RAWFILE\/index\.html(?:[?#].*)?$/i.test(this.controller.getUrl());
    } catch {
      return false;
    }
  }

  // ArkWeb renders the ledger from resource://rawfile, so the page has an
  // opaque origin ("null") and every fetch to the cloud gateway needs a CORS
  // preflight. The gateway trigger rejects an OPTIONS request without a token,
  // which makes that preflight fail. Performing the same request over the
  // system HTTP stack avoids the browser CORS layer entirely; the status code
  // and raw body are handed back so the page keeps all of its own error
  // handling, and the token still travels only inside the encrypted request.
  httpJson(id: string, url: string, method: string, headersJson: string, bodyText: string): void {
    this.runHttp(id, url, method, headersJson, bodyText).catch(() => {
      this.respond(id, '{"error":"network"}');
    });
  }

  // ArkWeb 的异步代理没有把 Promise 的完成值交回页面（页面拿到的是占位值），
  // 所以桥改为“调用即返回、结果按 id 回填”：原生侧完成后用 runJavaScript 调
  // window.__hysBridgeResolve(id, payload)，页面据此兑现自己的 Promise。
  private async runHttp(id: string, url: string, method: string, headersJson: string, bodyText: string): Promise<void> {
    if (!this.onBundlePage()) {
      this.respond(id, '{"error":"unavailable"}');
      return;
    }
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
      this.respond(id, '{"error":"invalid"}');
      return;
    }
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?][^\s"<>\\]*)?$/i.test(url) || url.indexOf('@') >= 0) {
      this.respond(id, '{"error":"invalid"}');
      return;
    }
    const verb: string = typeof method === 'string' ? method.toUpperCase() : 'GET';
    if (verb !== 'GET' && verb !== 'POST') {
      this.respond(id, '{"error":"invalid"}');
      return;
    }
    const body: string = typeof bodyText === 'string' ? bodyText : '';
    if (body.length > (verb === 'POST' && /\/api\/receipt$/.test(url) ? 2500000 : 8000)) {
      this.respond(id, '{"error":"too_large"}');
      return;
    }
    const header: Record<string, string> = {};
    try {
      const parsed: Record<string, string> = JSON.parse(headersJson ? headersJson : '{}');
      if (!parsed || typeof parsed !== 'object') {
        this.respond(id, '{"error":"invalid"}');
        return;
      }
      for (const key of Object.keys(parsed)) {
        const value: string = parsed[key];
        if (typeof value === 'string' && !/^(?:host|content-length|connection|accept-encoding|origin|cookie)$/i.test(key)) {
          header[key] = value;
        }
      }
    } catch (error) {
      this.respond(id, '{"error":"invalid"}');
      return;
    }
    const options: http.HttpRequestOptions = {
      method: verb === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
      header: header,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: 15000,
      readTimeout: 70000
    };
    if (verb === 'POST') {
      options.extraData = body;
    }
    const client = http.createHttp();
    try {
      const response = await client.request(url, options);
      const text: string = typeof response.result === 'string' ? response.result : '';
      const result: BridgeHttpResult = { status: response.responseCode, body: text };
      this.respond(id, JSON.stringify(result));
    } catch {
      this.respond(id, '{"error":"network"}');
    } finally {
      client.destroy();
    }
  }

  private respond(id: string, payload: string): void {
    if (!this.onBundlePage()) return;
    const script = 'window.__hysBridgeResolve(' + JSON.stringify(String(id)) + ',' + JSON.stringify(payload) + ')';
    this.controller.runJavaScript(script).catch(() => {
      // The page may already be gone; nothing to recover here.
    });
  }

  saveBackup(id: string, jsonText: string): void {
    this.runSave(id, jsonText).catch(() => {
      this.respond(id, 'failed');
    });
  }

  private async runSave(id: string, jsonText: string): Promise<void> {
    if (this.saving) {
      this.respond(id, 'busy');
      return;
    }
    if (!this.context) {
      this.respond(id, 'unavailable');
      return;
    }
    try {
      if (!/^resource:\/{1,2}RAWFILE\/index\.html(?:[?#].*)?$/i.test(this.controller.getUrl())) {
        this.respond(id, 'unavailable');
        return;
      }
    } catch {
      this.respond(id, 'unavailable');
      return;
    }
    if (typeof jsonText !== 'string' || jsonText.length === 0) {
      this.respond(id, 'invalid');
      return;
    }
    if (jsonText.length > 15000000) {
      this.respond(id, 'too_large');
      return;
    }
    try {
      JSON.parse(jsonText);
    } catch {
      this.respond(id, 'invalid');
      return;
    }
    const data = new util.TextEncoder().encodeInto(jsonText);
    if (data.byteLength > 15000000) {
      this.respond(id, 'too_large');
      return;
    }
    this.saving = true;
    let file: fileIo.File | undefined = undefined;
    try {
      const date = new Date();
      const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const documentPicker = new picker.DocumentViewPicker(this.context);
      const options: picker.DocumentSaveOptions = {
        newFileNames: [`花有数-备份-${stamp}.json`],
        fileSuffixChoices: ['账本备份|.json']
      };
      const uris = await documentPicker.save(options);
      if (uris.length === 0) {
        this.respond(id, 'cancelled');
        return;
      }
      file = await fileIo.open(uris[0], fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      let offset = 0;
      while (offset < data.byteLength) {
        const chunk = data.buffer.slice(data.byteOffset + offset, data.byteOffset + data.byteLength);
        const written = await fileIo.write(file.fd, chunk, { offset: offset });
        if (written <= 0) {
          throw new Error('Incomplete backup write');
        }
        offset += written;
      }
      await fileIo.fsync(file.fd);
      await fileIo.close(file);
      file = undefined;
      this.respond(id, 'saved');
      return;
    } catch {
      this.respond(id, 'failed');
      return;
    } finally {
      if (file) {
        try {
          await fileIo.close(file);
        } catch {
          // Never log a user's document URI or backup contents.
        }
      }
      this.saving = false;
    }
  }
}
