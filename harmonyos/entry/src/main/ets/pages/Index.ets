import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { LedgerBridge } from './LedgerBridge';
import { CaptureService } from './CaptureService';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: LedgerBridge = new LedgerBridge(this.controller);

  aboutToAppear(): void {
    this.bridge.setContext(this.getUIContext().getHostContext() as common.UIAbilityContext);
  }

  aboutToDisappear(): void {
    CaptureService.stopForBackground();
    this.bridge.detach();
  }

  onBackPress(): boolean {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(false)
        // On the target ArkWeb build, false also stalls packaged/data images.
        // The bundled page restricts image sources with its CSP instead.
        .onlineImageAccess(true)
        .geolocationAccess(false)
        // The optional AI gateway can be a user-selected HTTP endpoint on their LAN.
        .mixedMode(MixedMode.All)
        // HarmonyOS 6/7 (API 26) no longer injects the javaScriptProxy attribute
        // reliably, so the bridge is registered explicitly once the controller is
        // attached and before the bundled page starts running.
        .onControllerAttached(() => {
          this.controller.registerJavaScriptProxy(this.bridge, 'HysNative', [
            'saveBackup', 'httpJson', 'pickReceiptImage', 'recognizeScreenshot', 'recognizeVoice', 'stopVoice', 'cancelVoice',
            'getFloatingStatus', 'startFloatingBall', 'stopFloatingBall', 'getFloatingCapture', 'ackFloatingCapture'
          ]);
        })
        .onPageEnd(() => this.bridge.pageReady())
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#f5f6f2')
  }
}
