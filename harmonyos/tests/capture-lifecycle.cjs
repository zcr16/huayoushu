const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require(process.env.HYS_TYPESCRIPT_PATH || 'typescript');
const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/pages/CaptureService.ets'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function harness(options = {}) {
  const output = [], events = [], packets = [], stateEvents = [], timers = new Map();
  let listener, audioReader, timerCount = 0, createCount = 0;
  const engine = {
    setListener(value) { listener = value; },
    startListening(params) { this.session = params.sessionId; listener.onStart(params.sessionId, 'started'); },
    writeAudio(session, bytes) { packets.push(bytes); },
    finish(session) {
      events.push('finish');
      if (!options.neverFinish) listener.onResult(session, { isFinal: true, isLast: true, result: '午饭25元' });
    },
    cancel() { events.push('cancel'); },
    shutdown() { events.push('shutdown'); }
  };
  const capturer = {
    on(event, fn) { audioReader = fn; }, off() { events.push('off'); },
    start() { events.push('start'); return options.startGate?.promise || Promise.resolve(); },
    async stop() { events.push('stop'); }, async release() { events.push('release_audio'); }
  };
  const pixels = { async getImageInfo(){return {size:{width:1080,height:2400}};},async scale(){events.push('scale');},async release() { events.push('release_pixels'); } };
  const imageSource = {
    async getImageInfo() { return { size: { width: 1080, height: 2400 } }; },
    async createPixelMap() { return pixels; }, async release() { events.push('release_image'); }
  };
  const modules = {
    '@kit.ArkTS': {util:{Base64Helper:class{encodeToStringSync(bytes){return Buffer.from(bytes).toString('base64');}}}},
    '@kit.AbilityKit': { abilityAccessCtrl: { createAtManager: () => ({ requestPermissionsFromUser: () => options.permissionGate?.promise || Promise.resolve({ authResults: options.denyPermission ? [-1] : [0] }) }) } },
    '@kit.CoreFileKit': { fileIo: { OpenMode: { READ_ONLY: 0 }, async open(uri) { events.push('open:' + uri); return { fd: 1 }; }, async stat() { return { size: 10000 }; }, async close() { events.push('close_file'); } } },
    '@kit.MediaLibraryKit': { photoAccessHelper: { PhotoViewMIMETypes: { IMAGE_TYPE: 1 }, PhotoViewPicker: class { async select() { return { photoUris: options.cancelImage ? [] : ['user-selected-photo'] }; } } } },
    '@kit.ImageKit': { image: { PixelMapFormat: { RGBA_8888: 1 }, createImageSource() { return imageSource; },createImagePacker(){return {async packing(){events.push('pack');if(options.packError)throw Error('packing failed');return options.packOversize?new Uint8Array(1800001).buffer:new Uint8Array([255,216,255,0,0,0,0,0,0]).buffer;},async release(){events.push('release_packer');}};} } },
    '@kit.AudioKit': { audio: { AudioSamplingRate: { SAMPLE_RATE_16000: 16000 }, AudioChannel: { CHANNEL_1: 1 }, AudioSampleFormat: { SAMPLE_FORMAT_S16LE: 1 }, AudioEncodingType: { ENCODING_TYPE_RAW: 0 }, SourceType: { SOURCE_TYPE_VOICE_RECOGNITION: 1 }, async createAudioCapturer() { events.push('create_audio'); return capturer; } } },
    '@kit.CoreVisionKit': { textRecognition: { async recognizeText() { return { value: options.ocrText ?? '付款成功\n25.00\n午饭' }; }, async release() { events.push('release_ocr'); } } },
    '@kit.CoreSpeechKit': { speechRecognizer: { async createEngine(params) { assert.equal(params.online, 1); createCount++; return engine; } } }
  };
  const context = { exports: {}, require: name => { assert.ok(modules[name], name); return modules[name]; }, Uint8Array, Date, JSON, Math,
    canIUse: () => !options.unavailable,
    setTimeout: fn => { timers.set(++timerCount, fn); return timerCount; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(code, context, { filename: 'CaptureService.js' });
  const Class = context.exports.CaptureService;
  const service = new Class((id, payload) => output.push({ id, ...JSON.parse(payload) }), (id, state) => stateEvents.push({ id, state }));
  service.setContext({});
  return { service, Class, output, events, packets, timers, stateEvents, engine,
    get createCount() { return createCount; }, read(bytes) { audioReader(bytes.buffer); } };
}

test('voice sends complete 640-byte PCM frames, pads tail on stop, returns text and releases resources', async () => {
  const h = harness(); h.service.recognizeVoice('voice1'); await flush();
  assert.deepEqual(h.stateEvents, [{ id: 'voice1', state: 'listening' }]);
  h.read(new Uint8Array(1500));
  assert.deepEqual(h.packets.map(x => x.length), [640, 640]);
  h.service.stopVoice('stop1'); await flush();
  assert.deepEqual(h.packets.map(x => x.length), [640, 640, 640]);
  assert.ok(h.output.some(x => x.id === 'voice1' && x.text === '午饭25元'));
  assert.ok(h.events.includes('release_audio')); assert.ok(h.events.includes('shutdown'));
  assert.equal(h.timers.size, 0);
});

test('cancel while permission is pending prevents later recorder or engine creation', async () => {
  const permissionGate = deferred(), h = harness({ permissionGate });
  h.service.recognizeVoice('voice2'); h.service.cancelVoice('cancel2');
  permissionGate.resolve({ authResults: [0] }); await flush();
  assert.equal(h.createCount, 0);
  assert.ok(!h.events.includes('create_audio'));
  assert.ok(h.output.some(x => x.id === 'voice2' && x.cancelled));
});

test('permission refusal returns recoverable error without opening microphone', async () => {
  const h = harness({ denyPermission: true }); h.service.recognizeVoice('voice3'); await flush();
  assert.equal(h.output[0].error, 'microphone_denied'); assert.equal(h.createCount, 0);
});

test('background during microphone startup cancels session and never emits ready after stale start', async () => {
  const startGate = deferred(), h = harness({ startGate });
  h.service.recognizeVoice('voice4'); await flush();
  h.Class.stopForBackground(); startGate.resolve(); await flush();
  assert.deepEqual(h.stateEvents, []);
  assert.ok(h.output.some(x => x.id === 'voice4' && x.cancelled));
  assert.ok(h.events.includes('release_audio')); assert.ok(h.events.includes('shutdown'));
  assert.equal(h.timers.size, 0);
});

test('silence after stop times out and releases engine rather than keeping mic open', async () => {
  const h = harness({ neverFinish: true }); h.service.recognizeVoice('voice5'); await flush();
  h.service.stopVoice('stop5'); await flush();
  const callback = [...h.timers.values()][0]; callback(); await flush();
  assert.ok(h.output.some(x => x.id === 'voice5' && x.error === 'voice_timeout'));
  assert.ok(h.events.includes('release_audio')); assert.ok(h.events.includes('shutdown'));
});

test('screenshot reads only selected photo, returns text, and releases bitmap/source/file/OCR', async () => {
  const h = harness(); h.service.recognizeScreenshot('image1'); await flush();
  assert.equal(h.output[0].text, '付款成功\n25.00\n午饭');
  for (const event of ['open:user-selected-photo', 'release_pixels', 'release_image', 'close_file', 'release_ocr']) assert.ok(h.events.includes(event));
});

test('cancelled photo selection opens no file; oversized OCR text is rejected without truncation', async () => {
  const cancelled = harness({ cancelImage: true }); cancelled.service.recognizeScreenshot('image2'); await flush();
  assert.equal(cancelled.output[0].cancelled, true); assert.ok(!cancelled.events.some(x => x.startsWith('open:')));
  const large = harness({ ocrText: 'x'.repeat(6001) }); large.service.recognizeScreenshot('image3'); await flush();
  assert.equal(large.output[0].error, 'text_too_long'); assert.ok(large.events.includes('release_pixels'));
});

test('floating capture reservation excludes photo picker and microphone until release', async () => {
  const h = harness();
  assert.equal(h.Class.reserveFloatingCapture(), true);
  assert.equal(h.Class.reserveFloatingCapture(), false);
  h.service.recognizeScreenshot('locked_photo'); h.service.recognizeVoice('locked_voice'); await flush();
  assert.equal(h.output.filter(x => x.error === 'busy').length, 2);
  assert.equal(h.createCount, 0); assert.ok(!h.events.some(x => x.startsWith('open:')));
  h.Class.releaseFloatingCapture(); h.service.recognizeScreenshot('free_photo'); await flush();
  assert.ok(h.output.some(x => x.id === 'free_photo' && x.text));
});

test('voice initialization also prevents floating reservation, and cancellation releases it', async () => {
  const permissionGate = deferred(), h = harness({ permissionGate });
  h.service.recognizeVoice('voice_reserved');
  assert.equal(h.Class.reserveFloatingCapture(), false);
  h.service.cancelVoice('cancel_reserved');
  assert.equal(h.Class.reserveFloatingCapture(), true); h.Class.releaseFloatingCapture();
  permissionGate.resolve({ authResults: [0] }); await flush(); assert.equal(h.createCount, 0);
});

test('whole-image picker returns bounded JPEG without OCR and releases all resources',async()=>{
 const h=harness();h.service.pickReceiptImage('vision');await flush();
 assert.equal(h.output[0].mime,'image/jpeg');assert.equal(h.output[0].text,undefined);assert.ok(h.output[0].captureId.startsWith('image_'));
 assert.equal(Buffer.from(h.output[0].imageBase64,'base64')[0],255);assert.ok(!h.events.includes('release_ocr'));
 for(const event of ['release_packer','release_pixels','release_image','close_file'])assert.ok(h.events.includes(event));
});
test('encoding failure or oversized JPEG releases picker lock for another request',async()=>{
 for(const options of [{packError:true},{packOversize:true}]){
  const h=harness(options);h.service.pickReceiptImage('bad');await flush();assert.ok(h.output[0].error);
  assert.ok(h.events.includes('release_packer'));assert.ok(h.events.includes('release_pixels'));
  assert.equal(h.Class.reserveFloatingCapture(),true);h.Class.releaseFloatingCapture();
 }
});
