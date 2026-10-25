import { abilityAccessCtrl, common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { audio } from '@kit.AudioKit';
import { textRecognition } from '@kit.CoreVisionKit';
import { speechRecognizer } from '@kit.CoreSpeechKit';

export interface CaptureResult {
  text?: string;
  imageBase64?: string;
  mime?: string;
  captureId?: string;
  width?: number;
  height?: number;
  source?: string;
  error?: string;
  cancelled?: boolean;
  stopped?: boolean;
}

// Selected/captured receipt images are compressed in memory for explicit cloud
// vision requests. Voice stays on-device; original pixels are never persisted.
export class CaptureService {
  private static active: CaptureService | undefined = undefined;
  private static imageBusy: boolean = false;
  private static floatingBusy: boolean = false;
  private context: common.UIAbilityContext | undefined = undefined;
  private send: (id: string, payload: string) => void;
  private sendState: (id: string, state: string) => void;
  private voiceId: string = '';
  private voiceSession: string = '';
  private engine: speechRecognizer.SpeechRecognitionEngine | undefined = undefined;
  private capturer: audio.AudioCapturer | undefined = undefined;
  private audioTail: Uint8Array = new Uint8Array(0);
  private finalText: string = '';
  private partialText: string = '';
  private timer: number = -1;
  private finishing: boolean = false;

  constructor(send: (id: string, payload: string) => void, sendState: (id: string, state: string) => void) {
    this.send = send;
    this.sendState = sendState;
  }

  setContext(context: common.UIAbilityContext): void {
    this.context = context;
  }

  static stopForBackground(): void {
    if (CaptureService.active) {
      CaptureService.active.completeVoice({ cancelled: true });
    }
  }

  static reserveFloatingCapture(): boolean {
    if (CaptureService.active || CaptureService.imageBusy || CaptureService.floatingBusy) return false;
    CaptureService.floatingBusy = true;
    return true;
  }

  static releaseFloatingCapture(): void {
    CaptureService.floatingBusy = false;
  }

  // Callers exclusively reserve their capture operation and retain ownership
  // of the PixelMap. OCR releases its service but never writes or uploads pixels.
  static async recognizePixels(pixels: image.PixelMap): Promise<CaptureResult> {
    if (!canIUse('SystemCapability.AI.OCR.TextRecognition')) return { error: 'ocr_unavailable' };
    try {
      const recognized = await textRecognition.recognizeText({ pixelMap: pixels });
      const value = recognized.value.trim();
      if (value.length === 0) return { error: 'no_text' };
      if (value.length > 6000) return { error: 'text_too_long' };
      return { text: value };
    } catch {
      return { error: 'ocr_failed' };
    } finally {
      try { await textRecognition.release(); } catch {}
    }
  }

  private reply(id: string, result: CaptureResult): void {
    this.send(id, JSON.stringify(result));
  }

  pickReceiptImage(id: string): void {
    this.pickAndRecognize(id, true).catch(() => this.reply(id, { error: 'image_failed' }));
  }

  static async encodeReceipt(pixels: image.PixelMap): Promise<CaptureResult> {
    const info = await pixels.getImageInfo();
    const scale = Math.min(1, 2400 / Math.max(info.size.width, info.size.height));
    if (scale < 1) await pixels.scale(scale, scale);
    const packer = image.createImagePacker();
    try {
      let bytes = await packer.packing(pixels, { format: 'image/jpeg', quality: 85 });
      if (bytes.byteLength > 1800000) bytes = await packer.packing(pixels, { format: 'image/jpeg', quality: 65 });
      if (bytes.byteLength > 1800000) return { error: 'image_too_large' };
      const size = await pixels.getImageInfo();
      return { imageBase64: new util.Base64Helper().encodeToStringSync(new Uint8Array(bytes)),
        mime: 'image/jpeg', width: size.size.width, height: size.size.height,
        captureId: 'image_' + Date.now().toString() + '_' + Math.random().toString(36).slice(2) };
    } finally { await packer.release(); }
  }

  recognizeScreenshot(id: string): void {
    this.pickAndRecognize(id).catch(() => this.reply(id, { error: 'ocr_failed' }));
  }

  private async pickAndRecognize(id: string, vision: boolean = false): Promise<void> {
    if (!vision && !canIUse('SystemCapability.AI.OCR.TextRecognition')) {
      this.reply(id, { error: 'ocr_unavailable' });
      return;
    }
    if (CaptureService.imageBusy || CaptureService.active || CaptureService.floatingBusy) {
      this.reply(id, { error: 'busy' });
      return;
    }
    CaptureService.imageBusy = true;
    let file: fileIo.File | undefined = undefined;
    let source: image.ImageSource | undefined = undefined;
    let pixels: image.PixelMap | undefined = undefined;
    try {
      const select = new photoAccessHelper.PhotoViewPicker();
      const result = await select.select({
        MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 1
      });
      if (result.photoUris.length === 0) {
        this.reply(id, { cancelled: true });
        return;
      }
      // Read exactly the URI explicitly selected by the system picker. No
      // library scan, persistent photo permission, or arbitrary JS path input.
      file = await fileIo.open(result.photoUris[0], fileIo.OpenMode.READ_ONLY);
      const stat = await fileIo.stat(file.fd);
      if (stat.size > 20 * 1024 * 1024) {
        this.reply(id, { error: 'image_too_large' });
        return;
      }
      source = image.createImageSource(file.fd);
      const info = await source.getImageInfo();
      const width = info.size.width;
      const height = info.size.height;
      if (width < 10 || height < 10 || width * height > 50000000) {
        this.reply(id, { error: 'image_too_large' });
        return;
      }
      const scale = Math.min(1, 3000 / Math.max(width, height));
      pixels = await source.createPixelMap({
        desiredPixelFormat: image.PixelMapFormat.RGBA_8888,
        desiredSize: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
      });
      const recognized = vision ? await CaptureService.encodeReceipt(pixels) : await CaptureService.recognizePixels(pixels);
      recognized.source = 'screenshot';
      this.reply(id, recognized);
    } catch {
      this.reply(id, { error: 'ocr_failed' });
    } finally {
      if (pixels) { try { await pixels.release(); } catch {} }
      if (source) { try { await source.release(); } catch {} }
      if (file) { try { await fileIo.close(file); } catch {} }
      CaptureService.imageBusy = false;
    }
  }

  recognizeVoice(id: string): void {
    this.beginVoice(id).catch(() => {
      if (this.voiceId === id) this.completeVoice({ error: 'voice_unavailable' });
    });
  }

  private async beginVoice(id: string): Promise<void> {
    if (CaptureService.active || CaptureService.imageBusy || CaptureService.floatingBusy) {
      this.reply(id, { error: 'busy' });
      return;
    }
    if (!this.context) {
      this.reply(id, { error: 'unavailable' });
      return;
    }
    if (!canIUse('SystemCapability.AI.SpeechRecognizer') ||
      !canIUse('SystemCapability.Multimedia.Audio.Capturer')) {
      this.reply(id, { error: 'voice_unavailable' });
      return;
    }
    this.voiceId = id;
    this.voiceSession = 'ledger_' + Date.now().toString();
    const session = this.voiceSession;
    this.finishing = false;
    this.finalText = '';
    this.partialText = '';
    this.audioTail = new Uint8Array(0);
    CaptureService.active = this;
    const permissions = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(
      this.context, ['ohos.permission.MICROPHONE']);
    if (this.voiceId !== id) return;
    if (permissions.authResults.length === 0 || permissions.authResults[0] !== 0) {
      this.completeVoice({ error: 'microphone_denied' });
      return;
    }
    // The SDK uses online:1 for its offline Chinese speech model. Missing
    // system models and unavailable services surface as a recoverable error.
    const engine = await speechRecognizer.createEngine({
      language: 'zh-CN', online: 1, extraParams: { locate: 'CN', recognizerMode: 'short' }
    });
    if (this.voiceId !== id) { engine.shutdown(); return; }
    this.engine = engine;
    const capturer = await audio.createAudioCapturer({
      streamInfo: {
        samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
        channels: audio.AudioChannel.CHANNEL_1,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
        encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
      },
      capturerInfo: { source: audio.SourceType.SOURCE_TYPE_VOICE_RECOGNITION, capturerFlags: 0 }
    });
    if (this.voiceId !== id) { await capturer.release(); return; }
    this.capturer = capturer;
    capturer.on('readData', (buffer: ArrayBuffer) => {
      if (this.voiceSession !== session || this.voiceId !== id || this.finishing) return;
      const bytes = new Uint8Array(buffer);
      const joined = new Uint8Array(this.audioTail.length + bytes.length);
      joined.set(this.audioTail, 0);
      joined.set(bytes, this.audioTail.length);
      let offset = 0;
      try {
        while (offset + 640 <= joined.length) {
          engine.writeAudio(session, joined.slice(offset, offset + 640));
          offset += 640;
        }
        this.audioTail = joined.slice(offset);
      } catch {
        this.completeVoice({ error: 'voice_failed' });
      }
    });
    engine.setListener({
      onStart: (sessionId: string, eventMessage: string): void => {
        if (sessionId !== this.voiceSession || this.voiceId !== id) return;
        try {
          capturer.start().then(() => {
            if (this.voiceId !== id) { this.releaseCapturer(capturer); return; }
            this.clearTimer();
            this.timer = setTimeout(() => this.finishCurrentVoice(), 20000);
            this.sendState(id, 'listening');
          }).catch(() => {
            if (this.voiceId === id) this.completeVoice({ error: 'microphone_unavailable' });
          });
        } catch {
          if (this.voiceId === id) this.completeVoice({ error: 'microphone_unavailable' });
        }
      },
      onEvent: (sessionId: string, eventCode: number, eventMessage: string): void => {},
      onResult: (sessionId: string, result: speechRecognizer.SpeechRecognitionResult): void => {
        if (sessionId !== this.voiceSession || this.voiceId !== id) return;
        if (result.isFinal) {
          this.finalText += result.result;
          this.partialText = '';
        } else {
          this.partialText = result.result;
        }
        if (this.finalText.length + this.partialText.length > 6000) {
          this.completeVoice({ error: 'text_too_long' });
        } else if (result.isLast) {
          this.deliverVoiceText();
        }
      },
      onComplete: (sessionId: string, eventMessage: string): void => {
        if (sessionId === this.voiceSession && this.voiceId === id) this.deliverVoiceText();
      },
      onError: (sessionId: string, errorCode: number, errorMessage: string): void => {
        if (sessionId === this.voiceSession && this.voiceId === id) this.completeVoice({ error: 'voice_failed' });
      }
    });
    this.timer = setTimeout(() => {
      if (this.voiceId === id) this.completeVoice({ error: 'voice_unavailable' });
    }, 10000);
    engine.startListening({
      sessionId: session,
      audioInfo: { audioType: 'pcm', sampleRate: 16000, soundChannel: 1, sampleBit: 16 },
      extraParams: { online: 1 }
    });
  }

  stopVoice(id: string): void {
    this.finishCurrentVoice();
    this.reply(id, { stopped: true });
  }

  cancelVoice(id: string): void {
    this.completeVoice({ cancelled: true });
    this.reply(id, { cancelled: true });
  }

  private finishCurrentVoice(): void {
    if (!this.voiceId || this.finishing) return;
    if (!this.engine) { this.completeVoice({ cancelled: true }); return; }
    this.finishing = true;
    const engine = this.engine;
    const session = this.voiceSession;
    const capturer = this.capturer;
    this.capturer = undefined;
    if (capturer) this.releaseCapturer(capturer);
    this.clearTimer();
    this.timer = setTimeout(() => this.completeVoice({ error: 'voice_timeout' }), 5000);
    try {
      if (this.audioTail.length > 0) {
        const tail = new Uint8Array(640);
        tail.set(this.audioTail);
        engine.writeAudio(session, tail);
      }
      engine.finish(session);
    } catch { this.completeVoice({ error: 'voice_failed' }); }
  }

  private deliverVoiceText(): void {
    const value = (this.finalText + this.partialText).trim();
    if (value) this.completeVoice({ text: value, source: 'voice' });
    else this.completeVoice({ error: 'no_speech' });
  }

  private clearTimer(): void {
    if (this.timer !== -1) { clearTimeout(this.timer); this.timer = -1; }
  }

  private async releaseCapturer(capturer: audio.AudioCapturer): Promise<void> {
    try { capturer.off('readData'); } catch {}
    try { await capturer.stop(); } catch {}
    try { await capturer.release(); } catch {}
  }

  private completeVoice(result: CaptureResult): void {
    const id = this.voiceId;
    if (!id) return;
    const session = this.voiceSession;
    const engine = this.engine;
    const capturer = this.capturer;
    // Invalidate callbacks before touching service resources. In-flight
    // permission, initialization, and microphone-start callbacks are ignored.
    this.voiceId = '';
    this.voiceSession = '';
    this.engine = undefined;
    this.capturer = undefined;
    this.audioTail = new Uint8Array(0);
    this.clearTimer();
    if (CaptureService.active === this) CaptureService.active = undefined;
    if (capturer) this.releaseCapturer(capturer);
    if (engine) {
      try { engine.cancel(session); } catch {}
      try { engine.shutdown(); } catch {}
    }
    this.reply(id, result);
  }
}
