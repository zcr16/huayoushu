import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { CaptureService } from '../pages/CaptureService';
import { FloatingLedgerService } from '../pages/FloatingLedgerService';

export default class EntryAbility extends UIAbility {
  onForeground(): void {
    FloatingLedgerService.shared.onForeground();
  }

  onNewWant(): void {
    FloatingLedgerService.shared.notify();
  }

  onBackground(): void {
    CaptureService.stopForBackground();
    FloatingLedgerService.shared.onBackground();
  }

  onDestroy(): void {
    CaptureService.stopForBackground();
    FloatingLedgerService.shared.destroy();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`Huayoushu failed to load: ${err.code}`);
      }
    });
  }
}
