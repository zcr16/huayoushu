(function () {
  'use strict';
  const C = window.LedgerCore;
  const KEY = 'huayoushu.ledger.v1';
  const SETTINGS = 'huayoushu.connection.v1';
  const $ = (s, root = document) => root.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const money = n => C.formatAmount(n);
  const rawMoney = n => C.formatAmount(n, {grouping:false});
  const labels = {day:'日', week:'周', month:'月'};
  const icons = {
    home:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    accounts:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 10h18M15 15h3"/>',
    list:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    budget:'<circle cx="12" cy="12" r="9"/><path d="m8 7 4 5 4-5M8 13h8M8 16h8M12 12v7"/>',
    analysis:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    ai:'<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="m10 3-1 3-3 1-3 3v4l3 3 3 1 1 3h4l1-3 3-1 3-3v-4l-3-3-3-1-1-3z"/>'
  };
  let loadError = '', lastStored = null;
  let state;
  try { lastStored=localStorage.getItem(KEY); state = lastStored===null ? C.createInitialState() : C.validateState(JSON.parse(lastStored)); }
  catch (e) { loadError = '账本暂时无法读取，原始数据已保留。请先导出原始备份，再恢复有效账本。'; state = C.createInitialState(); }
  let settings = {base:'',token:''};
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS) || '{}')); } catch (_) {}
  settings.base = typeof settings.base === 'string' ? settings.base : '';
  settings.token = typeof settings.token === 'string' ? settings.token : '';
  settings.mode = ['cloud','local'].includes(settings.mode) ? settings.mode : (settings.base.startsWith('https:') || (!settings.base && (window.HYS_NATIVE || location.protocol==='https:')) ? 'cloud' : 'local');
  let demo = false, demoState, ledgerEpoch=0, draftsEpoch=0, page = 'home', period = 'month', reference = C.today();
  let chartInstances = [], aiReady = null, aiConfigured = false, aiBusy = false, aiInput = '', drafts = [], selectedCategory = 'food', connectionEpoch = 0, healthRequest = 0;
  const aiStatus = () => aiReady ? (settings.mode==='cloud' ? '云端识别已验证' : '模型已就绪') : aiConfigured ? (settings.token ? '云端待首次识别验证' : '请填写连接码') : aiReady===null ? '检测连接中' : 'AI 暂未连接';
  let draftProtocolVersion = 0;
  let inputSource = 'text', captureSession = null, captureSeq = 0;
  let search = '', categoryFilter = '', typeFilter = '', toastTimer;
  let drillCat = '', drillSub = '', selectedSub = '';
  const activeState = () => demo ? demoState : state;
  const category = id => C.categories.find(x => x.id === id) || C.categories[C.categories.length-1];
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5500); }
  function commit(next) {
    const valid = C.validateState(next);
    if (demo) { demoState = valid; ledgerEpoch++;invalidateFloating(); return; }
    if (loadError) throw new Error('请先备份原始数据，并通过“备份与设置”恢复账本。');
    if(localStorage.getItem(KEY)!==lastStored)throw new Error('另一个页面已更新账本，请先刷新页面，再重新保存这次更改。');
    try { const serialized=JSON.stringify(valid); if(lastStored && JSON.parse(lastStored).version===1 && !localStorage.getItem('huayoushu.ledger.pre-v2'))localStorage.setItem('huayoushu.ledger.pre-v2',lastStored); localStorage.setItem(KEY,serialized); lastStored=serialized; } catch (_) { throw new Error('保存失败，存储空间不足或未允许本地存储。此次更改未保存，请先备份。'); }
    state = valid; ledgerEpoch++;invalidateFloating();
  }
  function connectionUrl(path) {
    const base = settings.base.trim().replace(/\/+$/,'');
    if (base) { const u=new URL(base); if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname!=='/') throw new Error('请填写 AI 服务的根地址'); if(settings.mode==='cloud' && u.protocol!=='https:')throw new Error('云端 AI 必须使用 https:// 加密地址'); return base + path; }
    if (window.HYS_NATIVE || !/^https?:$/.test(location.protocol)) throw new Error('请在“设置 → AI 连接”填写服务地址和连接码。');
    if(settings.mode==='cloud' && location.protocol!=='https:')throw new Error('云端 AI 必须使用 https:// 加密地址');
    return path;
  }
  // ArkWeb's async proxy handed the page a placeholder instead of the resolved
  // value, so every bridge call is correlated by id and completed by the shell
  // through __hysBridgeResolve. The method is invoked on the injected object
  // itself because a detached function is rejected as "non-injected".
  const bridgePending = new Map(); let bridgeSeq = 0;
  window.__hysBridgeResolve = (id, payload) => { const done = bridgePending.get(id); if (!done) return; bridgePending.delete(id); done(payload); };
  window.__hysCaptureState=(id,status)=>{if(captureSession?.nativeId===id&&status==='listening'){const el=$('#capture-state');if(el)el.textContent='现在可以说话（最多20秒），说完点下方按钮。';}};
  const nativeHttp = () => (window.HYS_NATIVE && window.HysNative && typeof window.HysNative.httpJson === 'function' ? window.HysNative : null);
  function nativeCall(method, args) {
    return new Promise((resolve, reject) => {
      const id = 'hys' + (++bridgeSeq) + '-' + Date.now();
      if(method==='recognizeVoice'&&captureSession)captureSession.nativeId=id;
      const timer = setTimeout(() => { if (bridgePending.delete(id)) reject(new Error('bridge timeout')); }, 80000);
      bridgePending.set(id, (payload) => { clearTimeout(timer); resolve(payload); });
      try { window.HysNative[method](id, ...args); }
      catch (e) { clearTimeout(timer); bridgePending.delete(id); reject(e); }
    });
  }

  // Floating capture stays local until the user explicitly opens and submits it.
  const FLOAT_TTL = 5 * 60 * 1000;
  let floatState = null, floatPending = null, floatError = '', floatControlBusy = false;
  let floatStatusSeq = 0, floatGeneration = 0, floatCutoff = 0, floatReadBusy = false, floatReadAgain = false, floatExpiry;
  const floatSeen = new Set();
  const floatNative = () => !!(window.HYS_NATIVE && ['getFloatingStatus','startFloatingBall','stopFloatingBall','getFloatingCapture','ackFloatingCapture'].every(m => typeof window.HysNative?.[m] === 'function'));
  const floatErrors = {
    float_unsupported:'当前设备或系统暂不支持闪控球记账，请使用截图或语音入口。',
    float_view_permission_denied:'尚未获得闪控菜单权限，请允许系统授权；如无法授权，请更新权限证书。',
    float_permission_missing:'当前安装包尚未开通闪控球能力，请安装已获得华为授权的版本。',
    capture_permission_denied:'尚未允许截屏。请再次点开启，并在系统提示中授权；也可在手机设置中检查权限。',
    float_busy:'正在处理上一张付款页面，请稍候。', float_start_failed:'闪控球未能开启，请检查系统能力与权限后重试。',
    float_stop_failed:'闪控球未能关闭，请重试。', screen_capture_failed:'没有截取到付款页面，请返回付款详情后重新点小球。',
    screen_capture_denied:'截屏权限已关闭，请回到花有数重新开启闪控球并授权。',
    screen_protected_or_empty:'这个页面不允许截屏或没有可识别内容，请改用语音或手动记账。',
    ocr_unavailable:'系统文字识别服务暂不可用，请改用语音或手动记账。',
    ocr_failed:'文字识别失败，请在清晰的付款详情页重新点小球。', no_text:'没有识别到文字，请打开包含金额和日期的付款详情。',
    text_too_long:'图片内容过多，请选择更清晰的账单图片。', restore_failed:'未能自动返回花有数，请手动打开应用继续识图。',
    expired:'这次识别已超过5分钟，请返回付款详情重新点小球。'
  };
  const floatMessage = code => floatErrors[code] || '闪控球处理未完成，请重试；现有账本未受影响。';
  function rememberFloat(id) { floatSeen.add(id); if(floatSeen.size > 128) floatSeen.delete(floatSeen.values().next().value); }
  function ackFloat(id) { if(!id || !floatNative())return; nativeCall('ackFloatingCapture',[id]).catch(()=>{}); }
  function validFloatId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\x00-\x1f]/.test(id); }
  function freshFloat(item) { return Number.isSafeInteger(item.createdAt) && item.createdAt > 0 && item.createdAt >= floatCutoff && item.createdAt <= Date.now()+30000 && Date.now()-item.createdAt < FLOAT_TTL; }
  function floatingPanel() { return '<section class="card floating-card" data-floating-panel>'+floatingPanelBody()+'</section>'; }
  function floatingPanelBody() {
    const available=floatNative(), active=floatState?.active===true;
    let status = !available ? '请在新版鸿蒙App中使用' : !floatState ? '尚未检查设备能力' : !floatState.supported ? '当前设备暂不支持' : floatState.permission==='missing' ? '此安装包尚未开通' : active ? (floatState.busy?'正在识别付款页面':'已开启 · 点击人物打开菜单') : '未开启';
    const blocked=!available||demo||floatControlBusy||floatState?.supported===false||(!active&&floatState?.permission==='missing');
    return `<div class="card-head"><h3>闪控球记账</h3><span class="pill" data-floating-status>${esc(status)}</span></div><p class="helper">选一个记账搭子。打开账单列表或付款页面，点人物，再选“截图记账”。也可以选“和我互动”，炫白饭、摸鱼、撒花，还能自选常用动作。</p>${avatarPicker()}<p class="pet-message" data-pet-message>点已选中的角色，和她打个招呼。</p><div class="backup-actions"><button class="${active?'secondary':'primary'}" data-action="${active?'float-stop':'float-start'}" ${blocked?'disabled':''}>${floatControlBusy?'正在处理…':active?'关闭闪控球':'开启闪控球'}</button><button class="ghost" data-action="float-refresh" ${!available||floatControlBusy?'disabled':''}>检查状态</button></div><p class="helper">只有选择“截图记账”才获取画面并交给云端千问识图，不写入相册。互动在本机完成，不截图、不上传。查重只在手机完成，核对后才入账。形象可切换，位置与吸边由鸿蒙系统控制。</p>${demo?'<p class="notice">请回到真实账本后使用闪控球。</p>':''}${floatError?`<p class="error" role="status">${esc(floatError)}</p>`:''}`;
  }
  function syncFloatingUI() {
    document.querySelectorAll('[data-floating-panel]').forEach(el=>el.innerHTML=floatingPanelBody());
    const banner=$('#floating-pending'); if(!banner)return;
    if(floatPending?.imageBase64){banner.innerHTML=`<div class="floating-notice"><strong>有一张账单图片待识别</strong><button class="secondary" data-action="float-review" ${aiBusy?'disabled':''}>${aiBusy?'正在识图…':'继续识图'}</button><button class="ghost" data-action="float-discard">丢弃</button></div>`;return;}
    banner.innerHTML=floatPending ? `<div class="floating-notice" role="status"><div><strong>${floatPending.error?'闪控球识别需要重试':'有一份闪控球识别文字待核对'}</strong><p class="helper">${floatPending.error?esc(floatMessage(floatPending.error)):(floatPending.warning?floatMessage(floatPending.warning)+' ':'')+'尚未上传或入账，请在5分钟内查看。'}</p></div><div class="backup-actions">${floatPending.error?'':'<button class="secondary" data-action="float-review">查看识别文字</button>'}<button class="ghost" data-action="float-discard">${floatPending.error?'关闭提示':'丢弃'}</button></div></div>` : '';
  }
  async function refreshFloatingStatus() {
    if(!floatNative()||floatControlBusy){syncFloatingUI();return;}
    const seq=++floatStatusSeq;
    try {
      const result=JSON.parse(await nativeCall('getFloatingStatus',[]));
      if(seq!==floatStatusSeq||floatControlBusy)return;
      if(result.error)throw new Error(floatMessage(result.error));
      if(typeof result.supported!=='boolean'||typeof result.active!=='boolean')throw new Error('无法确认闪控球状态，请重试。');
      floatState=result; floatError='';
    } catch(e) { if(seq===floatStatusSeq)floatError=e.message==='bridge timeout'?'检查状态超时，请重试。':e.message; }
    if(seq===floatStatusSeq)syncFloatingUI();
  }
  async function toggleFloating(enable) {
    if(floatControlBusy)return;
    if(!floatNative()){toast('请在支持闪控球的新版鸿蒙App中使用。');return;}
    if(enable && (demo||loadError)){toast('请先回到可用的真实账本。');return;}
    const seq=++floatStatusSeq; let changed=false; floatControlBusy=true; floatError=''; syncFloatingUI();
    try {
      const result=JSON.parse(await nativeCall(enable?'startFloatingBall':'stopFloatingBall',enable?[avatarChoice]:[]));
      if(result.error)throw new Error(floatMessage(result.error));
      if(typeof result.active!=='boolean'||typeof result.supported!=='boolean')throw new Error('无法确认闪控球状态，请点检查状态。');
      if(seq===floatStatusSeq){floatState=result;changed=true;}
      toast(result.active?'助手已开启，点人物选择截图记账或互动。':'闪控球已关闭。');
    } catch(e) { if(seq===floatStatusSeq){floatError=e.message==='bridge timeout'?'操作超时，请检查闪控球是否已出现。':e.message;toast(floatError);} }
    finally {if(seq===floatStatusSeq){floatControlBusy=false;syncFloatingUI();if(changed)refreshFloatingStatus();}}
  }
  function clearFloatingPending() {
    if(floatPending){rememberFloat(floatPending.captureId);ackFloat(floatPending.captureId);}
    floatPending=null;clearTimeout(floatExpiry);syncFloatingUI();
  }
  function invalidateFloating() {
    floatGeneration++;floatCutoff=Date.now();clearFloatingPending();
  }
  async function readFloatingCapture() {
    if(!floatNative())return;
    if(floatReadBusy){floatReadAgain=true;return;}
    floatReadBusy=true; const generation=floatGeneration, epoch=ledgerEpoch;
    try {
      const result=JSON.parse(await nativeCall('getFloatingCapture',[]));
      if(!result||result.empty)return;
      if(!validFloatId(result.captureId)){toast('收到的识别结果无效，请重新点小球。');return;}
      if(floatSeen.has(result.captureId)){ackFloat(result.captureId);return;}
      if(generation!==floatGeneration||epoch!==ledgerEpoch||demo||loadError||!freshFloat(result)) {
        rememberFloat(result.captureId);ackFloat(result.captureId);
        toast(demo?'请回到真实账本后重新点小球。':'账本已变化或识别已过期，请重新点小球。');return;
      }
      if(result.error==='restore_failed' && result.source==='floating' && (receiptValid(result)||typeof result.text==='string' && result.text.trim() && result.text.length<=4000)){result.warning=result.error;delete result.error;}
      if(floatPending?.captureId===result.captureId)return;
      if(floatPending){rememberFloat(result.captureId);ackFloat(result.captureId);return;}
      if(!result.error && (result.source!=='floating'||(!receiptValid(result)&&(typeof result.text!=='string'||!result.text.trim()||result.text.length>4000)))) {
        rememberFloat(result.captureId);ackFloat(result.captureId);toast('图片或识别结果无效，请重新点小球。');return;
      }
      if(result.error && typeof result.error!=='string'){rememberFloat(result.captureId);ackFloat(result.captureId);return;}
      floatPending={...result,epoch,generation};
      clearTimeout(floatExpiry);floatExpiry=setTimeout(()=>{if(floatPending?.captureId===result.captureId){clearFloatingPending();toast(floatMessage('expired'));}},Math.max(1,FLOAT_TTL-(Date.now()-result.createdAt)));
      syncFloatingUI();
      if(receiptValid(result)){if(!receiptAttempts.has(result.captureId)&&!aiBusy&&!captureSession&&!$('#modal').open&&!drafts.length)reviewFloating();}
      else toast(result.error?floatMessage(result.error):'识别结果已到达，请查看。');
    } catch(_) { toast('未能读取闪控球结果，请点检查状态重试。'); }
    finally {floatReadBusy=false;if(floatReadAgain){floatReadAgain=false;readFloatingCapture();}}
  }
  function reviewFloating(replaceId) {
    const item=floatPending;
    if(!item)return;
    if(item.epoch!==ledgerEpoch||item.generation!==floatGeneration||demo||!freshFloat(item)){clearFloatingPending();toast('账本已变化或识别已过期，请重新点小球。');return;}
    if(item.error){toast(floatMessage(item.error));return;}
    if(aiBusy||captureSession){toast('请先完成或取消当前识别，再查看闪控球文字。');return;}
    if(receiptValid(item)){if($('#modal').open||drafts.length){toast('请先完成当前账单，图片已暂存');return;}parseReceipt(item);return;}
    const replacing=typeof replaceId==='string' && replaceId===item.captureId && $('#modal').dataset.floatingReplace===replaceId;
    if($('#modal').open&&!replacing){toast('请先完成或关闭当前窗口，识别文字已暂存。');return;}
    if(!activeState().budgetReady){onboarding();toast('请先完成预算设置，再重新点小球记账。');return;}
    if(aiInput.trim()&&!replacing){
      showModal(`${modalHeading('替换当前记账文字？')}<p class="page-intro">AI记账页还有未提交的文字。使用这次闪控球文字会替换当前输入，不会修改已保存账目。</p><div class="notice floating-preview">${esc(item.text.slice(0,300))}${item.text.length>300?'…':''}</div><div class="form-actions"><button class="secondary" data-action="close">保留当前文字</button><button class="primary" data-action="float-replace" data-id="${esc(item.captureId)}">使用这次识别文字</button></div>`);
      $('#modal').dataset.floatingReplace=item.captureId;return;
    }
    aiInput=item.text.trim();inputSource='ocr';drafts=[];
    clearFloatingPending();if(replacing)$('#modal').close();page='ai';render();
    toast('请核对金额、日期和付款账户，点“整理”才会发送给AI。');
  }
  window.__hysFloatingCaptureReady=()=>{refreshFloatingStatus();readFloatingCapture();};

  // The bundled page runs from resource://rawfile, an opaque origin, so the
  // browser's CORS preflight for the Authorization header is rejected by the
  // cloud gateway trigger. On the phone the same request goes through the
  // system HTTP stack through the shell bridge; a plain browser keeps fetch.
  async function sendRequest(url, options, signal) {
    const bridge = settings.mode === 'cloud' ? nativeHttp() : null;
    if (!bridge) return fetch(url, {...options, signal, redirect:'error'});
    let raw, envelope;
    try { raw = await nativeCall('httpJson', [url, String(options.method || 'GET').toUpperCase(), JSON.stringify(options.headers || {}), typeof options.body === 'string' ? options.body : '']); } catch (_) { throw new Error('Failed to fetch'); }
    try { envelope = JSON.parse(raw); } catch (_) { throw new Error('Failed to fetch'); }
    if (!envelope || typeof envelope.status !== 'number') throw new Error('Failed to fetch');
    const body = typeof envelope.body === 'string' ? envelope.body : '';
    return { ok: envelope.status >= 200 && envelope.status < 300, status: envelope.status, json: async () => JSON.parse(body), text: async () => body };
  }
  async function fetchJson(path, options={}) {
    const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(), 110000);
    try { const response = await sendRequest(connectionUrl(path), options, controller.signal); if(settings.mode==='cloud' && (response.status===401 || (path==='/api/health' && !settings.token && response.status===400)))throw new Error('云端连接码未填写或已失效，请在设置中填写正确的花有数连接码（不是百炼 API Key）。'); let result;try{result=await response.json();}catch(_){throw new Error('AI 服务没有返回有效结果，请检查服务地址；本地账本未受影响。');} if(!response.ok) {
      if(settings.mode==='cloud') {
        const messages={AMBIGUOUS_TRANSACTION:'业务性质还不明确。本人账户转账请写清两个账户都属于自己；退款、借贷、代垫请单独核对；还款本金与手续费请分开描述。',NON_TRANSACTION_AMOUNT:'截图包含多个金额，请核对并只保留明确的实际付款金额，不要把余额、原价或优惠计为消费。',OCR_MULTIPLE_TRANSACTIONS:'请用新版整图识别入口，支持一张图中的多笔交易。',VISION_NOT_CONFIGURED:'云端整图识别尚未配置，请检查连接。',INVALID_RECEIPT:'图片格式或大小不符合要求，请重新选择。',AMBIGUOUS_DATE:'交易日期不明确，请核对并补充 YYYY-MM-DD 日期。',NO_EXACT_AMOUNT:'没有识别到准确金额，请修改识别文字或重新截图、录音。',UNCLEAR_RECOGNIZED_TEXT:'识别文字有无法确认的字符，请核对金额和文字后重试。',UNTRUSTED_INPUT:'请只保留交易的金额、用途和日期，不要混入操作指令。',AI_CREDENTIALS_INVALID:'云端 AI 密钥无效或已失效，请检查服务器配置；手机连接码无需因此更换。',AI_NOT_CONFIGURED:'云端 AI 尚未配置，请先完成服务器配置。',AI_DAILY_LIMIT:'已达到此服务设置的每日识别上限，请次日重试；手动记账仍可使用。',AI_RATE_LIMIT:'识别请求过于频繁，请等待一分钟后重试。',AI_BUSY:'AI 正在处理其他账目，请稍后重试。',AI_OUTPUT_TRUNCATED:'本次账目较多，结果未完整返回，请拆成更短的内容重试。'};
        const fallback={400:'请求内容不正确，请检查记账文字和日期后重试。',402:'云端 AI 余额不足或可用额度已用完，请在服务商控制台核对。',403:'云端服务拒绝访问，请检查服务地址、连接码与访问权限。',408:'云端 AI 响应超时，请稍后重试或使用手动记账。',422:'账目、金额或日期还不够明确，请写清具体金额、日期和收支方向后重试。',429:'云端 AI 请求或用量已达限制，请稍后重试并核对服务额度。',504:'云端 AI 响应超时，请稍后重试或使用手动记账。'};
        throw new Error((typeof result?.code==='string' && Object.hasOwn(messages,result.code) ? messages[result.code] : '') || fallback[response.status] || '云端 AI 暂时不可用，请检查服务配置后重试；本地账本未受影响。');
      }
      throw new Error(typeof result?.error==='string' ? result.error : '服务暂时不可用');
    } return result; }
    catch(e) { if(e.name==='AbortError') throw new Error('AI 响应超时，请重试或使用手动记账。'); throw e; }
    finally { clearTimeout(timeout); }
  }
  async function checkConnection(showMessage=false) {
    const request=++healthRequest, epoch=connectionEpoch;
    const options=settings.mode==='cloud' && settings.token ? {headers:{Authorization:'Bearer '+settings.token}} : {};
    try { const result=await fetchJson('/api/health',options); if(request!==healthRequest || epoch!==connectionEpoch)return; draftProtocolVersion=Number(result.draftProtocolVersion)||0;receiptVision=result.receiptVision===true;aiReady=!!result.aiReady; aiConfigured=result.provider==='dashscope' && result.configured===true; if(settings.mode==='local' && result.provider!=='dashscope' && !settings.base && !window.HYS_NATIVE && ['localhost','127.0.0.1','[::1]'].includes(location.hostname)) { try { const pair=await fetchJson('/api/pairing'); if(request!==healthRequest || epoch!==connectionEpoch)return; settings.token=pair.token; localStorage.setItem(SETTINGS,JSON.stringify(settings)); } catch(_){} }
      if(showMessage) toast(aiConfigured ? (settings.token ? '云端服务配置已就绪；点击识别后验证模型和连接码，可能产生调用费用。' : '云端服务已配置，请先填写花有数连接码。') : aiReady ? 'AI 模型已就绪，可以一句话记账' : '服务已连接，AI 尚未配置完成；本地记账仍可使用');
    } catch(e) { if(request!==healthRequest || epoch!==connectionEpoch)return; aiReady=false;aiConfigured=false;draftProtocolVersion=0;receiptVision=false; if(showMessage) toast(e.message.includes('Failed') ? '暂时无法连接 AI，请检查网络与服务地址；本地记账不受影响' : e.message); }
    document.querySelectorAll('.ai-state').forEach(el=>{el.textContent=aiStatus();el.classList.toggle('ready',!!aiReady);});
  }
  function budgetAlerts() {
    const statuses=C.getBudgetStatuses(activeState(),C.today());
    return Object.entries(statuses).filter(([,v])=>['warning','reached','exceeded'].includes(v.level)).map(([key,v])=>`<div class="alert ${v.level==='exceeded'?'danger':''}"><span>${v.level==='exceeded'?'!':'◷'}</span><span>本${labels[key]}${v.level==='exceeded'?`已超额度 ¥${money(-v.remaining)}`:v.level==='reached'?'已用完额度':`已用掉 ${Math.floor(v.ratio*100)}% 额度`} · ${v.level==='exceeded'?'接下来的开销记得留意一下。':`已花 ¥${money(v.spent)} / ¥${money(v.limit)}`}</span></div>`).join('');
  }
  function nav() { return [['home','总览'],['accounts','账户'],['list','账单'],['analysis','分析'],['budget','预算'],['ai','AI 记账'],['settings','设置']].map(([id,name])=>`<button data-action="navigate" data-page="${id}" class="${page===id?'active':''}" ${page===id?'aria-current="page"':''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[id]}</svg>${name}</button>`).join(''); }
  function render() {
    chartInstances.forEach(c=>c.dispose()); chartInstances=[];
    const titles={accounts:'钱在哪里，一眼看清。',home:'每一笔，都心中有数。',list:'生活里的每一笔',analysis:'钱花成了什么样',budget:'给花销，留一点分寸',ai:'说句话，就记下了',settings:'你的账本，你来掌管'};
    $('#app').innerHTML=`<div class="app-shell"><aside class="sidebar"><div class="brand"><div class="logo">¥</div><div>花有数<small>SPEND WITH CARE</small></div></div><nav class="nav" aria-label="主导航">${nav()}</nav><div class="sidebar-foot"><div class="leaf-mark">❧</div>把日子过好<br>也把每一笔花明白。<br><br>◉ 账本保存在本机</div></aside><main class="main"><div class="mobile-brand">花有数 · HUAYOUSHU</div><header class="topbar"><div><div class="eyebrow">YOUR LITTLE MONEY JOURNAL</div><h1 class="greeting">${titles[page]}</h1></div><div class="top-actions"><span class="date-label">${C.today().replace(/-/g,'.')}</span><button class="primary" data-action="add">＋ 记一笔</button></div></header>${demo?'<div class="demo-banner"><span>正在体验示例账本 · 不影响你的真实记录</span><button class="text-button" data-action="leave-demo">回到我的账本 →</button></div>':''}${loadError?`<div class="alert danger">${esc(loadError)}</div>`:''}<div id="floating-pending"></div>${page==='home'?home():page==='accounts'?accountsPage():page==='list'?ledger():page==='analysis'?analysisPage():page==='budget'?budgets():page==='ai'?aiPage():settingsPage()}<footer class="footer">花有数 · 好好生活，花得明白</footer></main></div>`;
    bindLocal();
    syncFloatingUI();
    if(page==='home') requestAnimationFrame(drawCharts);
  }
  function home() {
    const s=activeState(), month=C.getSummary(s.transactions,'month'), day=C.getSummary(s.transactions,'day'), week=C.getSummary(s.transactions,'week');
    const budget=C.getBudgetStatus(month.expense,s.budgets.month), summary=C.getSummary(s.transactions,period,reference);
    const chosen=summary.categories.filter(x=>x.amount>0), most=chosen[0];
    return `${budgetAlerts()}<div class="quick-capture"><button class="secondary" data-action="capture-image">截图记账</button><button class="secondary" data-action="capture-voice">语音记账</button><button class="secondary" data-action="float-open">闪控球记账</button><button class="ghost" data-action="navigate" data-page="accounts">我的账户 →</button></div><section class="hero"><div><div class="hero-label">本月总支出 <span class="pill">${Number(C.today().slice(5,7))} 月账本</span></div><div class="big-money"><span class="currency">¥</span>${money(month.expense)}</div><div class="hero-description">${month.count?`已记录 ${month.count} 笔收支，每一笔都值得被看见。`:'从今天的第一笔开始，慢慢了解自己的消费。'}</div></div><div class="hero-budget"><div class="split"><span>本月${budget.remaining!==null && budget.remaining<0?'超出预算':'剩余额度'}</span><button class="text-button muted" data-action="navigate" data-page="budget">调整预算 ↗</button></div><strong>${budget.remaining===null?'尚未设置':`¥ ${money(Math.abs(budget.remaining))}`}</strong><div class="progress ${budget.level==='exceeded'?'danger':''}"><i style="width:${Math.min(100,budget.ratio*100 || 0)}%"></i></div><div class="split muted"><small>${budget.limit?`月预算 ¥${money(budget.limit)}`:'设置预算，让花钱更有计划'}</small><small>${budget.limit?`已用 ${Math.round(budget.ratio*100)}%`:''}</small></div></div></section><div class="metric-grid"><div class="metric"><div class="metric-label"><i class="dot"></i>今日支出</div><strong>¥ ${money(day.expense)}</strong><small>${day.count} 笔收支记录</small></div><div class="metric"><div class="metric-label"><i class="dot gold"></i>本周支出</div><strong>¥ ${money(week.expense)}</strong><small>周一至周日</small></div><div class="metric"><div class="metric-label"><i class="dot orange"></i>本月收入</div><strong>¥ ${money(month.income)}</strong><small>收入不抵扣消费额度</small></div></div><section class="card wechat-promo"><div><h3>微信花的钱，一次导入</h3><p class="helper">导入微信导出的账单，自动分类与去重。</p></div><button class="secondary" data-action="wechat">导入微信账单 →</button></section><div class="section-bar"><div class="section-title"><h2>钱都花在哪了</h2><small>看懂你的消费</small></div><div class="segmented" aria-label="统计周期">${['day','week','month'].map(p=>`<button data-action="period" data-value="${p}" class="${p===period?'active':''}">${labels[p]}</button>`).join('')}</div></div><div class="section-bar" style="margin-top:-5px"><span class="muted">${esc(summary.range.label)} · 支出 ¥${money(summary.expense)}</span><div class="period-control"><button aria-label="上一${labels[period]}" data-action="shift" data-value="-1">‹</button><button data-action="today">今</button><button aria-label="下一${labels[period]}" data-action="shift" data-value="1">›</button></div></div><div class="charts-grid"><section class="card"><div class="card-head"><h3>支出分布</h3><span class="muted">${chosen.length} 个分类</span></div><div id="category-chart" class="chart chart-pie" role="img" aria-label="分类支出占比"></div><div class="legend">${chosen.map(x=>`<div class="legend-row"><i class="legend-color" style="background:${x.color}"></i><span>${x.name}</span><span class="value">${Math.round(x.percentage)}% · ¥${money(x.amount)}</span></div>`).join('')}</div></section><section class="card"><div class="card-head"><h3>支出趋势</h3><span class="muted">单位 / 元</span></div><p class="chart-subtitle">${period==='day'?'看看今天的分类开销':'每日开销，一眼就看得明白'}</p><div id="trend-chart" class="chart" role="img" aria-label="每日支出趋势"></div><div class="insight">${most?`↗ ${most.name}是这段时间最大的支出，花了 ¥${money(most.amount)}，占 ${Math.round(most.percentage)}%。`:'记下第一笔，消费趋势和分类占比就会出现在这里。'}</div></section></div><section class="card recent-card"><div class="card-head"><h3>最近账单</h3><button class="text-button" data-action="navigate" data-page="list">查看全部 →</button></div>${transactionList([...s.transactions].sort(sortTransactions).slice(0,5))}</section>${!s.transactions.length?'<div style="text-align:center;margin-top:20px"><button class="secondary" data-action="demo">先看看示例账本</button></div>':''}`;
  }

  const typeNames = {expense:'支出',income:'收入',transfer:'内部转账',repayment:'信用卡还款'};
  const accountName = id => activeState().accounts.find(a=>a.id===id)?.name || '账户未确认';
  function accountOptions(selected='', filter='', legacy=false, pending=false) {
    return `<option value="">${pending?'账户待归属（可直接保存）':legacy?'保留历史记录（不计账户余额）':'请选择实际资金账户'}</option>` + activeState().accounts.filter(a=>!filter||a.type===filter).map(a=>`<option value="${esc(a.id)}" ${a.id===selected?'selected':''}>${esc(a.name)}${a.type==='liability'?' · 信用卡/负债':''}</option>`).join('');
  }
  function accountsPage() {
    const accounts=C.getAccountBalances(activeState()), assets=accounts.filter(a=>a.type==='asset').reduce((n,a)=>n+a.balance,0), debt=accounts.filter(a=>a.type==='liability').reduce((n,a)=>n+a.balance,0);
    const unassigned=activeState().transactions.filter(t=>!t.accountId&&!t.pendingAccount).length,pending=activeState().transactions.filter(t=>t.pendingAccount).length;
    return `<p class="page-intro">从你核实的期初余额开始记。这里是账面余额，需要定期与银行、钱包核对。</p><div class="metric-grid"><div class="metric"><div class="metric-label">已登记资产</div><strong>¥ ${money(assets)}</strong></div><div class="metric"><div class="metric-label">已登记负债</div><strong>¥ ${money(debt)}</strong></div><div class="metric"><div class="metric-label">净资产</div><strong>¥ ${money(assets-debt)}</strong></div></div><section class="card"><div class="card-head"><h3>资金账户</h3><button class="primary" data-action="add-account">＋ 添加账户</button></div>${accounts.length?accounts.map(a=>`<div class="account-row"><div><strong>${esc(a.name)}</strong><p class="helper">${a.type==='asset'?'资产账户':'信用卡/负债'} · ${a.openingDate} 起记账</p></div><div><strong>¥ ${money(a.type==='liability'&&a.balance<0?-a.balance:a.balance)}</strong><p class="helper">${a.type==='liability'?(a.balance<0?'溢缴款':'待还余额'):'账面余额'}</p></div></div>`).join(''):'<p class="page-intro">添加银行卡、微信零钱、支付宝余额或现金。用微信绑定银行卡付款时，选择实际扣钱的银行卡。</p>'}</section>${pending?`<div class="notice">${pending} 笔交易已保存，账户待归属。已计入收支统计，不会扣减银行卡或钱包余额；可在账单编辑里补选账户。</div>`:''}${unassigned?`<div class="notice">${unassigned} 笔历史或导入记录尚未关联账户，只参加收支统计，不影响以上余额。不要把开账前的消费再次从当前余额扣除。</div>`:''}<section class="card" style="margin-top:18px"><h3>转账与还款</h3><p class="helper">自己的账户之间转钱、归还信用卡本金，不会重复计入消费预算。信用卡刷卡消费时计入支出。</p><div class="backup-actions"><button class="secondary" data-action="new-transfer">内部转账</button><button class="secondary" data-action="new-repayment">信用卡还款</button></div></section>`;
  }
  function openAccount() {
    showModal(`${modalHeading('添加资金账户')}<form id="account-form"><div class="field"><label for="account-name">账户名称</label><input id="account-name" name="name" maxlength="40" placeholder="例如：招商银行卡、微信零钱" required></div><div class="field"><label for="account-type">账户类型</label><select id="account-type" name="type"><option value="asset">资产 · 银行卡/钱包/现金</option><option value="liability">负债 · 信用卡</option></select></div><div class="field"><label id="opening-label" for="opening-balance">期初可用余额（元）</label><input id="opening-balance" name="openingBalance" inputmode="decimal" value="0" required></div><div class="field"><label for="opening-date">开始记账日期</label><input id="opening-date" type="date" name="openingDate" value="${C.today()}" max="${C.today()}" required></div><p class="notice">填写这一天开始记录新流水之前的余额。信用卡填写当时的欠款，已记录的消费不要再包含一次。期初余额不算收入。</p><div id="account-error" class="error" role="alert"></div><div class="form-actions"><button type="button" class="secondary" data-action="close">取消</button><button class="primary">保存账户</button></div></form>`);
    $('#account-type').addEventListener('change',e=>$('#opening-label').textContent=e.target.value==='liability'?'期初待还欠款（元）':'期初可用余额（元）');
    $('#account-form').addEventListener('submit',e=>{e.preventDefault();try{const f=new FormData(e.target),v=String(f.get('openingBalance')).trim(),openingBalance=/^0(?:\.0{1,2})?$/.test(v)?0:C.parseAmount(v),name=String(f.get('name')).trim(),openingDate=String(f.get('openingDate'));if(!name)throw new Error('请填写账户名称');if(!C.isValidDate(openingDate)||openingDate>C.today())throw new Error('开账日期须为今天或过去的有效日期');if(activeState().accounts.some(a=>a.name===name))throw new Error('已有同名账户，请使用容易区分的名称');commit({...activeState(),accounts:[...activeState().accounts,{id:uid(),name,type:String(f.get('type')),openingBalance,openingDate}]});$('#modal').close();page='accounts';render();toast('账户已创建，期初余额不计收入');}catch(err){$('#account-error').textContent=err.message;}});
  }
  function journalDetails(t) {
    if(!t?.entries?.length)return '';
    const label=id=>{const account=activeState().accounts.find(a=>a.id===id);if(account)return account.name;if(id==='sys:unassigned')return t.pendingAccount?'账户待归属':'历史账户未确认';if(id==='sys:equity:opening')return '期初权益';if(id.startsWith('sys:expense:'))return category(id.slice(12)).name+'费用';if(id.startsWith('sys:income:'))return category(id.slice(11)).name+'收入';return id;};
    return `<details class="journal-details"><summary>查看这笔账的借贷记录</summary>${t.entries.map(e=>`<div>${esc(label(e.accountId))} · 借 ${money(e.debit||0)} / 贷 ${money(e.credit||0)}</div>`).join('')}</details>`;
  }

  const sortTransactions=(a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt);

  function transactionList(items) {
    if(!items.length)return '<div class="empty">这里还没有账单<br><button class="text-button" data-action="add">记下第一笔 →</button></div>';
    return items.map(t=>{const c=category(t.category),movement=['transfer','repayment'].includes(t.type),account=t.accountId?accountName(t.accountId)+(t.targetAccountId?' → '+accountName(t.targetAccountId):''):t.pendingAccount?'账户待归属':'历史/导入 · 账户未确认';return `<div class="transaction"><div class="category-icon" style="background:${c.color}18">${movement?'⇄':t.type==='income'?'↙':c.icon}</div><div><div class="transaction-name">${esc(t.note||typeNames[t.type])}</div><div class="transaction-meta">${t.date} · ${movement?typeNames[t.type]:t.type==='income'?'收入':c.name}<br>${esc(account)}</div></div><div class="transaction-amount ${t.type==='income'?'income':''}">${movement?'':t.type==='income'?'+':'−'} ${money(t.amount)}</div><button class="row-edit" aria-label="编辑${esc(t.note||typeNames[t.type])}" data-action="edit" data-id="${esc(t.id)}">⋮</button></div>`;}).join('');
  }
  function ledger() {
    const range=C.getPeriodRange(period,reference);
    const items=activeState().transactions.filter(t=>t.date>=range.start&&t.date<=range.end&&(!categoryFilter||t.category===categoryFilter)&&(!typeFilter||t.type===typeFilter)&&(!search||(t.note+category(t.category).name+t.date).toLowerCase().includes(search.toLowerCase()))).sort(sortTransactions);
    const sum=items.filter(x=>x.type==='expense').reduce((a,x)=>a+x.amount,0);
    const incomeSum=items.filter(x=>x.type==='income').reduce((a,x)=>a+x.amount,0);
    return `<p class="page-intro">按日期回看，每一天的钱花在哪里，都清清楚楚。</p><div class="section-bar"><div class="period-control"><button data-action="shift" data-value="-1" aria-label="上一周期">‹</button><span>${esc(range.label)}</span><button data-action="shift" data-value="1" aria-label="下一周期">›</button><button data-action="today">今</button></div><div class="segmented">${['day','week','month'].map(p=>`<button data-action="period" data-value="${p}" class="${p===period?'active':''}">${labels[p]}</button>`).join('')}</div></div><div class="filter-row"><input type="search" id="search" value="${esc(search)}" placeholder="搜索备注、分类、日期" aria-label="搜索账单"><select id="category-filter" aria-label="筛选分类"><option value="">全部分类</option>${C.categories.map(c=>`<option value="${c.id}" ${c.id===categoryFilter?'selected':''}>${c.name}</option>`).join('')}</select><select id="type-filter" aria-label="筛选收支"><option value="">全部收支</option><option value="expense" ${typeFilter==='expense'?'selected':''}>支出</option><option value="income" ${typeFilter==='income'?'selected':''}>收入</option><option value="transfer" ${typeFilter==='transfer'?'selected':''}>内部转账</option><option value="repayment" ${typeFilter==='repayment'?'selected':''}>信用卡还款</option></select></div><div class="card"><div class="card-head"><h3>${items.length} 笔记录</h3><span class="muted">筛选内支出 ¥${money(sum)}${incomeSum?` · 收入 ¥${money(incomeSum)}`:''}</span></div>${items.length?Object.entries(items.reduce((acc,t)=>{(acc[t.date] ||= []).push(t);return acc;},{})).map(([date,txs])=>`<div class="date-group split"><span>${date===C.today()?'今天':date.replace(/-/g,'.')}</span><span>支出 ¥${money(txs.filter(t=>t.type==='expense').reduce((n,t)=>n+t.amount,0))}</span></div>${transactionList(txs)}`).join(''):transactionList([])}</div>`;
  }
  function pct(n){return (n*100>=10?(n*100).toFixed(0):(n*100).toFixed(1))+'%';}
  function shareBar(n,color){return `<div class="share-bar"><i style="width:${Math.max(2,Math.min(100,Math.round(n*100)))}%;background:${color}"></i></div>`;}
  function analysisPage(){
    const s=activeState(),range=C.getPeriodRange(period,reference),b=C.getBreakdown(s.transactions,period,reference),prev=C.getBreakdown(s.transactions,period,C.shiftPeriod(period,reference,-1));
    const find=id=>b.categories.find(c=>c.id===id);
    const periodBar=`<div class="section-bar"><div class="period-control"><button data-action="shift" data-value="-1" aria-label="上一周期">‹</button><span>${esc(range.label)}</span><button data-action="shift" data-value="1" aria-label="下一周期">›</button><button data-action="today">今</button></div><div class="segmented">${['day','week','month'].map(p=>`<button data-action="period" data-value="${p}" class="${p===period?'active':''}">${labels[p]}</button>`).join('')}</div></div>`;
    if(!b.count&&!b.income) return `<p class="page-intro">这里把支出拆开看：大类 → 细分，还有常去的地方，一眼看清钱流向了哪里。</p>${periodBar}<div class="card"><div class="empty"><div class="empty-symbol">◌</div>本${labels[period]}还没有支出记录<br><button class="text-button" data-action="add">记下第一笔开销 →</button></div></div>`;
    const top=b.categories[0],notes=[];
    notes.push(`本${labels[period]}一共花了 <b>¥${money(b.total)}</b>，${b.count} 笔，${b.activeDays} 天有消费，日均 ¥${money(b.avgPerDay)}。`);
    if(b.income) notes.push(`同期收入 <b>¥${money(b.income)}</b>（${b.incomeCount||0} 笔），${b.income>=b.total?`收入够覆盖支出，净存 ¥${money(b.income-b.total)}`:`收入不够覆盖支出，净支出 ¥${money(b.total-b.income)}`}。`);
    if(top) notes.push(`${top.name}花得最多：<b>¥${money(top.amount)}</b>（${top.count} 笔，占 ${pct(top.share)}）${top.subs[0]?`，主要是${top.subs[0].name} ¥${money(top.subs[0].amount)}`:''}。`);
    const food=find('food');
    if(food&&food.subs.length){const pick=id=>food.subs.find(x=>x.id===id);const meal=pick('meal'),fruit=pick('fruit'),snack=pick('snack'),drink=pick('drink'),bbq=pick('bbq');
      const parts=[meal&&`三餐食堂 ¥${money(meal.amount)}`,fruit&&`水果生鲜 ¥${money(fruit.amount)}`,snack&&`零食 ¥${money(snack.amount)}`,drink&&`饮品奶茶 ¥${money(drink.amount)}`,bbq&&`夜宵火锅 ¥${money(bbq.amount)}`].filter(Boolean);
      notes.push(`吃这件事花了 ¥${money(food.amount)}（占 ${pct(food.share)}）：${parts.join('、')}。`);}
    const ai=find('ai');
    notes.push(ai?`AI 上花了 <b>¥${money(ai.amount)}</b>（${ai.count} 笔）：${ai.subs.map(x=>`${x.name} ¥${money(x.amount)}`).join('、')}。这类是订阅或接口充值，属于固定支出，值得单独盯。`:'这个周期没有 AI 相关支出。用到 DeepSeek 接口、会员订阅时会自动归到「AI 服务」。');
    const life=find('life');
    if(life) notes.push(`生活开销 ¥${money(life.amount)}（${life.count} 笔）：${life.subs.map(x=>`${x.name} ¥${money(x.amount)}`).join('、')}。你住校，这部分是洗衣、话费这类日常，不含房租。`);
    const hotel=find('hotel');
    if(hotel) notes.push(`住宿 ¥${money(hotel.amount)}（${hotel.count} 笔）是出门住的酒店，和日常房租分开算。`);
    const health=find('health');
    if(health&&health.subs.some(x=>x.id==='gym')){const gym=health.subs.find(x=>x.id==='gym');notes.push(`健身 ¥${money(gym.amount)}（${gym.count} 次），平均一次约 ¥${money(Math.round(gym.amount/Math.max(1,gym.count)))}。`);}
    if(prev.count) notes.push(`比上${labels[period]}（¥${money(prev.total)}）${b.total===prev.total?'持平':(b.total>prev.total?`多花 ¥${money(b.total-prev.total)}（+${pct((b.total-prev.total)/Math.max(1,prev.total))}）`:`少花 ¥${money(prev.total-b.total)}（-${pct((prev.total-b.total)/Math.max(1,prev.total))}）`)}。`);
    if(b.biggest) notes.push(`单笔最大：${esc(b.biggest.note||'未写备注')} <b>¥${money(b.biggest.amount)}</b>（${b.biggest.date.replace(/-/g,'.')}）。`);
    if(b.merchants[0]) notes.push(`花得最多的商家：${esc(b.merchants[0].label)}，¥${money(b.merchants[0].amount)} / ${b.merchants[0].count} 次。`);
    const periodTxns=s.transactions.filter(t=>t.date>=range.start&&t.date<=range.end);
    const catRows=b.categories.map(c=>{
      const open=drillCat===c.id;
      const picked=periodTxns.filter(t=>t.category===c.id&&(!drillSub||t.sub===drillSub)).sort(sortTransactions);
      const pickedSum=picked.filter(t=>t.type==='expense').reduce((n,t)=>n+t.amount,0);
      const pickedIncome=picked.filter(t=>t.type==='income').reduce((n,t)=>n+t.amount,0);
      const subRows=c.subs.map(x=>`<button type="button" class="sub-row ${drillSub===x.id?'active':''}" data-action="drill-sub" data-value="${c.id}|${x.id}"><span>${x.name}</span><span class="muted">${x.count} 笔</span><span class="sub-amt">¥${money(x.amount)}</span><span class="sub-share">${pct(x.share)}</span></button>${shareBar(x.share,c.color)}`).join('');
      const txnRows=`<div class="txn-mini"><div class="txn-mini-head"><span>${drillSub?esc(C.subName(c.id,drillSub))+' 的明细':c.name+' · 共 '+picked.length+' 笔'}</span><span class="muted">支出 ¥${money(pickedSum)}${pickedIncome?` · 收入 ¥${money(pickedIncome)}`:''}</span></div>${picked.length?picked.map(t=>`<div class="txn-row" role="button" tabindex="0" data-action="edit" data-id="${t.id}"><span class="txn-date">${t.date.slice(5).replace('-','.')}</span><span class="txn-note">${esc(t.note||'未写备注')}<small>${esc(C.subName(t.category,t.sub))}${t.type==='income'?' · 收入':''}${t.fixed?' · 已手动指定':''}</small></span><span class="txn-amt${t.type==='income'?' in':''}">${t.type==='income'?'+':'−'} ¥${money(t.amount)}</span><button type="button" class="txn-fix" data-action="fix-cat" data-id="${t.id}" aria-label="这笔分类不对，改到别的分类">✕</button></div>`).join(''):'<p class="helper">这一档没有记录。</p>'}<button type="button" class="text-button" data-action="drill-to-bill" data-value="${c.id}">在账单里筛选看这几笔 →</button></div>`;
      return `<div class="cat-row ${open?'open':''}"><div class="cat-head" data-action="drill" data-value="${c.id}" role="button" tabindex="0" aria-expanded="${open}"><span class="cat-icon" style="background:${c.color}18">${c.icon}</span><span class="cat-name">${c.name}<small>${c.count} 笔</small></span><span class="cat-amt">¥${money(c.amount)}</span><span class="cat-share">${pct(c.share)}</span><span class="cat-caret">${open?'▴':'▾'}</span></div>${shareBar(c.share,c.color)}${open?`<div class="sub-list">${subRows}</div>${txnRows}`:''}</div>`;
    }).join('');
    const maxM=b.merchants[0]?b.merchants[0].amount:1;
    const merchantRows=b.merchants.map((m,i)=>`<div class="merchant-row"><span class="merchant-rank">${i+1}</span><span class="merchant-name">${esc(m.label)}</span><span class="merchant-amt">¥${money(m.amount)}<small>${m.count} 次</small></span></div>${shareBar(m.amount/maxM,'#c9b78a')}`).join('');
const netAmount=b.total-b.income;
    const ioCard=`<section class="card io-card"><div class="card-head"><h3>收入与支出</h3><span class="muted">本${labels[period]}分开算</span></div><div class="io-rows"><div class="io-row"><span class="io-tag out">支出</span><span class="io-amount out">− ¥${money(b.total)}</span><span class="io-count">${b.count} 笔</span></div><div class="io-row"><span class="io-tag in">收入</span><span class="io-amount in">+ ¥${money(b.income)}</span><span class="io-count">${b.incomeCount||0} 笔</span></div><div class="io-row net"><span class="io-tag">${netAmount>=0?'净支出':'净存入'}</span><span class="io-amount">${netAmount>=0?'¥'+money(netAmount):'净存入 ¥'+money(-netAmount)}</span><span class="io-count">收入已抵扣</span></div></div>${b.income?`<div class="io-break"><div class="io-break-title">收入从哪来</div>${b.incomes.map(x=>`<div class="sub-row"><span>${x.icon} ${x.name}</span><span class="muted">${x.count} 笔</span><span class="sub-amt">+ ¥${money(x.amount)}</span><span class="sub-share">${pct(x.share)}</span></div>${shareBar(x.share,'#7ba05b')}`).join('')}</div>`:'<p class="helper">这个周期还没有收入记录。收到生活费、红包或兼职收入时，记成「收入」就会单独统计在这里。</p>'}</section>`;
    return `<p class="page-intro">这里把支出拆开看：点一个大类，就能看到里面每一笔是谁、多少钱，点 ✕ 还能改到别的分类。</p>${periodBar}<div class="metric-grid analysis-metrics"><div class="metric"><div class="metric-label"><i class="dot"></i>本${labels[period]}支出</div><strong>¥ ${money(b.total)}</strong><small>${b.count} 笔</small></div><div class="metric"><div class="metric-label"><i class="dot gold"></i>日均</div><strong>¥ ${money(b.avgPerDay)}</strong><small>${b.activeDays}/${b.dayCount} 天有消费</small></div><div class="metric"><div class="metric-label"><i class="dot orange"></i>单笔最大</div><strong>¥ ${money(b.biggest?b.biggest.amount:0)}</strong><small>${b.biggest?esc((b.biggest.note||'').slice(0,10)):'—'}</small></div></div>${ioCard}<section class="card"><h3>看出来的几件事</h3><ul class="insight-list">${notes.map(n=>`<li>${n}</li>`).join('')}</ul></section><section class="card"><div class="card-head"><h3>支出构成</h3><span class="muted">点开看细分</span></div>${catRows?`<div class="cat-list">${catRows}</div>`:'<p class="helper">本期没有支出记录，只有收入。</p>'}<p class="helper">分类按备注自动判断。点开一行能看那几笔明细；哪一笔归错了，点它右边的 ✕ 换成别的分类，改过的会记住、重新分类也不会动它。</p></section><section class="card"><div class="card-head"><h3>常去的地方</h3><span class="muted">按商户名聚合</span></div><div class="merchant-list">${merchantRows}</div></section><section class="card"><div class="card-head"><h3>重新整理分类</h3><span class="muted">一次性</span></div><p class="helper">按最新关键词重判全部记录的细分，适合刚导入完账单时跑一次。</p><button class="secondary" data-action="reclass">按最新规则重新分类</button></section>`;
  }
  function budgets() {
    const s=activeState(), statuses=C.getBudgetStatuses(s);
    return `<p class="page-intro">先给自己一个额度。达到 80% 时提醒，达到或超过额度时会明确提示。</p>${budgetAlerts()}<div class="budget-list">${['day','week','month'].map(p=>{const b=statuses[p];return `<div class="budget-card"><div class="split"><h3>每${labels[p]}预算</h3><span class="muted">${b.limit?Math.round(b.ratio*100)+'% 已用':'未设置'}</span></div><span class="muted">本${labels[p]}已花</span><div class="limit">¥ ${money(b.spent)}</div><div class="progress dark ${b.level==='exceeded'?'danger':''}"><i style="width:${Math.min(100,b.ratio*100||0)}%"></i></div><div class="split muted"><span>额度 ${b.limit?'¥'+money(b.limit):'—'}</span><span>${b.remaining===null?'':b.remaining<0?'超出 ¥'+money(-b.remaining):'剩余 ¥'+money(b.remaining)}</span></div></div>`}).join('')}</div><section class="card budget-form"><h3>调整你的额度</h3><form id="budget-form">${budgetInputs(s)}<div class="notice">额度按自然日、周一至周日和自然月循环。收入不抵扣支出；提醒在打开应用和记账后显示。</div><div id="budget-error" class="error" role="alert"></div><div class="form-actions"><button class="primary">保存额度</button></div></form></section>`;
  }
  function budgetInputs(s) { return `<div class="field"><label for="budget-month">每月额度（元）</label><input id="budget-month" name="month" inputmode="decimal" placeholder="例如 3000" value="${s.budgets.month?rawMoney(s.budgets.month):''}"></div><div class="field-row"><div class="field"><label for="budget-week">每周额度（可选）</label><input id="budget-week" name="week" inputmode="decimal" placeholder="例如 700" value="${s.budgets.week?rawMoney(s.budgets.week):''}"></div><div class="field"><label for="budget-day">每日额度（可选）</label><input id="budget-day" name="day" inputmode="decimal" placeholder="例如 100" value="${s.budgets.day?rawMoney(s.budgets.day):''}"></div></div><p class="helper">至少设置一种额度。留空表示不启用该周期的额度。</p>`; }

  function aiPage() {
    return `<p class="page-intro">一张图，多笔账。AI 直接看图、提取交易，再对照本机账本查重。</p>${floatingPanel()}${receiptPending?`<section class="card receipt-progress"><strong>${aiBusy?"正在识别整张图片…":"这张图片尚未识别完成"}</strong><p class="helper">自动提取交易、日期与时间，然后在本机查重。</p>${!aiBusy?'<button class="primary" data-action="receipt-retry">重试识图</button>':''}</section>`:''}${receiptMode&&drafts.length?'<section class="card"><button class="primary" data-action="receipt-review">继续核对图片账单</button><button class="ghost" data-action="discard-drafts">丢弃这批草稿</button></section>':''}<section class="ai-box"><div class="card-head"><h2>轻松记一笔</h2><span class="ai-state ${aiReady?'ready':''}">${aiStatus()}</span></div><div class="quick-capture"><button class="secondary" data-action="capture-image" ${aiBusy?'disabled':''}>整张图片记账</button><button class="secondary" data-action="capture-voice" ${aiBusy?'disabled':''}>开始语音记账</button></div><label class="helper" for="ai-input">${inputSource==='ocr'?'截图文字':inputSource==='voice'?'语音文字':'记账文字'} · 可修改，尚未保存</label><textarea id="ai-input" maxlength="4000" aria-label="记账文字" placeholder="例如：今天午饭25元，招行卡付的">${esc(aiInput)}</textarea><div class="examples"><button class="example" data-action="example" data-value="今天午饭25元，地铁6元">午饭 + 地铁</button><button class="example" data-action="example" data-value="今天从我的银行卡转500元到我的微信零钱">自己的账户转账</button></div><div class="split"><button class="text-button" data-action="check-ai">检查连接 ↗</button><button class="primary" data-action="parse" ${aiBusy?'disabled':''}>${aiBusy?'正在理解…':'整理成待确认账单'}</button></div><p class="helper">点击“整理”才发送以上文字给${settings.mode==='cloud'?'云端千问':'已配置的电脑AI'}；文字记账不上传声音或整个账本。选图与闪控球会发送本次图片给云端千问。${settings.mode==='cloud'?'需要联网，可能产生模型调用费用。':''}</p><p class="helper">截图与语音入口在新版鸿蒙App使用。账单列表和付款详情均可整图识别；商品明细和合计不会作为多笔消费处理。退款、借贷及代垫会提示单独核对。</p></section><section class="card"><h3>先记下来，账户可以稍后补</h3><p class="page-intro">普通截图收支可直接保存。识别不出实际账户时，记为“账户待归属”，不改变银行卡余额；之后可在账单里补选。</p><div class="backup-actions"><button class="secondary" data-action="add">手动记账</button><button class="ghost" data-action="navigate" data-page="accounts">管理账户</button><button class="ghost" data-action="navigate" data-page="settings">云端连接设置</button></div></section>`;
  }
  async function capture(kind) {
    if(captureSession||aiBusy)return;
    if(kind==='image'&&drafts.length){receiptMode?showReceiptDrafts():showDrafts();return;}
    if(!activeState().budgetReady){onboarding();return;}
    const method=kind==='image'?'pickReceiptImage':'recognizeVoice';
    if(!window.HYS_NATIVE||typeof window.HysNative?.[method]!=='function'){toast('请在新版鸿蒙App使用截图/语音入口；当前页面仍可输入或粘贴记账文字。');page='ai';render();return;}
    const session={id:++captureSeq,epoch:ledgerEpoch,kind,cancelled:false};captureSession=session;
    showModal(`${modalHeading(kind==='image'?'选择账单图片':'语音记账',false)}<p class="page-intro">${kind==='image'?'选择后立即发送本次图片给云端千问，可识别多笔交易；账本查重在本机完成。':'说出金额、用途和付款账户。识别文字可修改，尚未发送给云端千问。'}</p><p id="capture-state" role="status">${kind==='image'?'等待选择图片…':'正在准备麦克风，录音最长20秒。'}</p><div class="form-actions"><button class="secondary" data-action="capture-cancel">取消</button>${kind==='voice'?'<button class="primary" data-action="capture-stop">说完了</button>':''}</div>`);
    try {
      const result=JSON.parse(await nativeCall(method,[]));
      if(session.cancelled||session.epoch!==ledgerEpoch||captureSession!==session)return;
      if(result.cancelled){$('#modal').close();return;}
      if(result.error){const errors={ocr_unavailable:'设备暂不支持截图文字识别，请检查系统服务或手动输入',ocr_failed:'截图识别失败，请换一张清晰的付款详情图',image_too_large:'图片过大，请裁剪到交易详情后再试',text_too_long:'图片文字过多，请裁剪到单笔交易详情',microphone_denied:'麦克风权限未开启，请在手机设置中允许花有数使用麦克风',microphone_unavailable:'麦克风暂不可用，请关闭其他录音应用后重试',voice_unavailable:'系统中文语音识别尚未就绪，请检查手机语音服务后重试，或输入文字',voice_failed:'语音识别失败，请重试或手动输入',voice_timeout:'语音识别超时，请重试',no_speech:'没有听到清晰语音，请准备好后再试',permission:'请允许使用麦克风后重试',permission_denied:'麦克风权限未开启，请在系统设置中允许后重试',no_text:'没有识别到文字，请选择清晰的交易详情截图',empty:'没有识别到内容，请重试',busy:'正在识别，请稍后再试',unavailable:'当前设备暂不支持此识别能力',timeout:'识别超时，请重试',too_large:'图片或识别文字过大，请裁剪交易详情后重试'};throw new Error(errors[result.error]||'识别未完成，请检查系统识别服务后重试，或手动输入。');}
      if(kind==='image'){if(!receiptValid(result))throw new Error('没有取得有效图片，请重试');$('#modal').close();captureSession=null;await parseReceipt(result);return;}
      if(typeof result.text!=='string'||!result.text.trim())throw new Error('没有识别到文字，请重试。');
      if(result.text.length>4000)throw new Error('图片文字超过4000字，请裁剪到单笔交易详情后重试。');
      aiInput=result.text.trim();inputSource=kind==='image'?'ocr':'voice';$('#modal').close();page='ai';render();toast('文字已识别，请核对金额和日期，再点击整理');
    }catch(err){if(!session.cancelled){$('#modal').close();toast(err.message==='bridge timeout'?'识别超时，请重试。':err.message);}}
    finally{if(captureSession===session){captureSession=null;if(kind==='voice'&&window.HysNative?.cancelVoice)nativeCall('cancelVoice',[]).catch(()=>{});}}
  }
  function cancelCapture() {
    if(!captureSession)return;
    const kind=captureSession.kind;captureSession.cancelled=true;captureSession=null;
    if(kind==='voice')nativeCall('cancelVoice',[]).catch(()=>{});
    $('#modal').close();
  }
  let receiptVision=false, receiptMode=false, receiptWarnings=[], receiptPending=null, receiptExpiry;
  const receiptAttempts=new Set();
  let avatarChoice='whale';
  try { const v=localStorage.getItem('huayoushu.assistant.v1');if(['whale','star','robot'].includes(v))avatarChoice=v; } catch(_){}
  const avatarNames={whale:'DeepSeek 鲸鱼娘',star:'Claude',robot:'GPT'};
  let petTapCount=0;
  function petGreeting(){const lines=['在呢，账单交给我～','打开付款页面，点人物选截图记账。','今天的每一笔，都帮你理清楚。'];document.querySelectorAll('[data-pet-message]').forEach(el=>el.textContent=lines[(petTapCount++)%lines.length]);document.querySelectorAll('.assistant-option.selected img').forEach(el=>{el.classList.remove('pet-wave');void el.offsetWidth;el.classList.add('pet-wave');});}
  function avatarPicker(){return `<div class="assistant-options" role="group" aria-label="选择助手形象">${Object.entries(avatarNames).map(([key,name])=>`<button type="button" class="assistant-option ${avatarChoice===key?'selected':''}" data-action="assistant-select" data-value="${key}" aria-pressed="${avatarChoice===key}" ${floatControlBusy?'disabled':''}><img src="${window.HysAssistants?.[key]||''}" alt="${name}" width="56" height="56"><span>${name}</span></button>`).join('')}</div>`;}
  async function chooseAvatar(value){
    if(!Object.hasOwn(avatarNames,value)||floatControlBusy)return;
    if(value===avatarChoice){petGreeting();return;}
    const wasActive=floatState?.active;
    if(wasActive){await toggleFloating(false);if(floatState?.active)return;}
    try{localStorage.setItem('huayoushu.assistant.v1',value);avatarChoice=value;}catch(_){toast('形象设置未能保存，请检查存储空间');return;}
    syncFloatingUI();
    if(wasActive)await toggleFloating(true);else toast('已选择'+avatarNames[value]+'，开启闪控球后生效');
  }
  function receiptValid(item){return item?.mime==='image/jpeg'&&typeof item.imageBase64==='string'&&item.imageBase64.length>12&&item.imageBase64.length<=2400000&&validFloatId(item.captureId);}
  async function parseReceipt(item){
    if(aiBusy||demo||loadError||!receiptValid(item))return;
    if(!activeState().budgetReady){onboarding();return;}
    const epoch=ledgerEpoch,connection=connectionEpoch;
    receiptPending={...item,receivedAt:item.receivedAt||Date.now()};
    clearTimeout(receiptExpiry);receiptExpiry=setTimeout(()=>{if(receiptPending?.captureId===item.captureId){receiptPending=null;render();}},Math.max(1,FLOAT_TTL-(Date.now()-receiptPending.receivedAt)));
    if(Date.now()-receiptPending.receivedAt>=FLOAT_TTL){receiptPending=null;toast('图片已过期，请重新选择');return;}
    aiBusy=true;receiptAttempts.add(item.captureId);page='ai';render();
    try{
      if(!receiptVision)await checkConnection();
      if(!receiptVision)throw new Error('整图识别尚未连接，请检查云端设置后重试');
      const response=await fetchJson('/api/receipt',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+settings.token},body:JSON.stringify({imageBase64:item.imageBase64,mime:item.mime,today:C.today()})});
      if(epoch!==ledgerEpoch||connection!==connectionEpoch){receiptPending=null;toast('账本或连接已变化，本次图片结果未入账');return;}
      if(response.receiptProtocolVersion!==1||!Array.isArray(response.drafts)||response.drafts.length>50)throw new Error('图片识别结果无效，请重试');
      drafts=response.drafts.map((d,i)=>{
        if(!Object.hasOwn(typeNames,d.type)||!Number.isSafeInteger(d.amount)||d.amount<=0||d.amount>C.MAX_AMOUNT||typeof d.note!=='string'||(d.date&&(!C.isValidDate(d.date)||d.date>C.today())))throw new Error('图片结果需要重新识别');
        return {...d,id:uid(),createdAt:new Date().toISOString(),sourceFingerprint:item.captureId+':'+i};
      });
      receiptWarnings=Array.isArray(response.warnings)?response.warnings.filter(x=>typeof x==='string').slice(0,20):[];
      receiptMode=true;draftsEpoch=epoch;aiReady=true;receiptPending=null;
      if(floatPending?.captureId===item.captureId)clearFloatingPending();
      else ackFloat(item.captureId);
      if(!drafts.length){showModal(`${modalHeading('这张图暂未找到可入账交易')}<p class="helper">${esc(receiptWarnings.join('；')||'请检查图片是否清晰、是否包含已完成的交易。')}</p><button class="primary" data-action="close">知道了</button>`);return;}
      showReceiptDrafts();
    }catch(e){toast(e.message.includes('Failed')?'图片识别连接失败，可以重试':e.message);}
    finally{aiBusy=false;render();}
  }
  function suggestedAccount(d){
    const hint=String(d.accountHint||'').replace(/\s/g,'');if(!hint)return '';
    const matches=activeState().accounts.filter(a=>a.name&&hint===a.name.replace(/\s/g,'')&&d.date>=a.openingDate&&(d.type==='expense'||a.type==='asset'));
    return matches.length===1?matches[0].id:'';
  }
  function showReceiptDrafts(){
    const classified=window.LedgerReconcile.classify(drafts,activeState().transactions);
    const names={new:'待入账',matched:'已记录',suspected:'可能重复'};
    const counts=Object.fromEntries(Object.keys(names).map(k=>[k,classified.filter(x=>x.status===k).length]));
    const rows=['new','suspected','matched'].map(status=>classified.filter(x=>x.status===status).map(c=>{
      const i=c.index,d=drafts[i],picked=suggestedAccount(d);
      return `<article class="receipt-row ${status}" data-receipt-row="${i}"><div class="split"><label class="receipt-include"><input type="checkbox" name="include-${i}" ${status==='new'?'checked':''}><strong>${esc(d.merchant||d.note)}</strong></label><strong>¥${money(d.amount)}</strong></div><p class="receipt-meta"><span class="receipt-tag ${status}">${names[status]}</span> ${esc([d.date||'日期待确认',d.time,d.paymentChannel].filter(Boolean).join(' · '))}</p>${status!=='new'?`<p class="helper">${esc(c.reason)}${c.matches[0]?.note?' · 对应：'+esc(c.matches[0].note):''}。${status==='matched'?'已记录，不会重复保存':'确认是另一笔后再勾选'}。</p>`:''}<details ${!d.date||['transfer','repayment'].includes(d.type)?'open':''}><summary>${['transfer','repayment'].includes(d.type)?'核对交易详情与资金账户':'补充账户与详情（可选）'}</summary><div class="field"><label>资金账户（收支可不选）<select name="account-${i}">${accountOptions(picked,'',false,!['transfer','repayment'].includes(d.type))}</select></label>${d.accountHint?`<small>图片线索：${esc(d.accountHint)}</small>`:''}</div><div class="draft-fields"><label>金额（元）<input name="amount-${i}" inputmode="decimal" value="${rawMoney(d.amount)}"></label><label>日期<input type="date" name="date-${i}" value="${esc(d.date||'')}" max="${C.today()}"></label><label>时间（可空）<input type="time" step="1" name="time-${i}" value="${esc(d.time||'')}"></label><label>类型<select name="type-${i}" data-receipt-type="${i}">${Object.entries(typeNames).map(([k,v])=>`<option value="${k}" ${k===d.type?'selected':''}>${v}</option>`).join('')}</select></label><label>分类<select name="category-${i}">${C.categories.map(c=>`<option value="${c.id}" ${c.id===d.category?'selected':''}>${c.name}</option>`).join('')}</select></label><label id="receipt-target-${i}" ${['transfer','repayment'].includes(d.type)?'':'hidden'}>转入／还款账户<select name="target-${i}">${accountOptions('',d.type==='repayment'?'liability':'asset')}</select></label></div><label>备注<input class="draft-note" name="note-${i}" value="${esc(d.note)}" maxlength="200"></label>${d.receiptId?`<p class="helper">交易单号：${esc(d.receiptId)}</p>`:''}</details></article>`;
    }).join('')).join('');
    showModal(`${modalHeading('整张图，已经理好了')}<div class="receipt-counts">${Object.entries(names).map(([k,n])=>`<span class="receipt-tag ${k}">${n} ${counts[k]}</span>`).join('')}</div><p class="helper">已在本机对照账本，默认仅勾选新交易。核对后可直接保存，资金账户不用再选。识别不准的先记为“账户待归属”，不改变银行卡余额；日期不清楚时请补充。</p>${receiptWarnings.length?`<p class="notice">${esc(receiptWarnings.join('；'))}</p>`:''}<form id="receipt-form"><details id="receipt-account-options"><summary>统一选择资金账户（可选）</summary><div class="receipt-bulk"><label>实际资金账户<select id="receipt-account-all">${accountOptions('','',false,true)}</select></label><button type="button" class="secondary" id="receipt-apply-account">应用到勾选交易</button></div></details>${rows}<div class="error" id="receipt-error" role="alert"></div><div class="form-actions"><button type="button" class="secondary" data-action="close">稍后处理</button><button type="button" class="ghost" data-action="discard-drafts">丢弃草稿</button><button class="primary">确认保存勾选交易</button></div></form>`);
    document.querySelectorAll('[data-receipt-type]').forEach(el=>el.onchange=()=>{const i=el.dataset.receiptType,movement=['transfer','repayment'].includes(el.value),source=$(`[name="account-${i}"]`);$('#receipt-target-'+i).hidden=!movement;source.innerHTML=accountOptions(source.value,el.value==='expense'?'':'asset',false,!movement);$(`[name="target-${i}"]`).innerHTML=accountOptions('',el.value==='repayment'?'liability':'asset');});
    const form=$('#receipt-form'),saveButton=$('button.primary',form);
    // Validate only selected rows ourselves. Native validation can otherwise
    // block submit because of an invalid field in an unselected/closed row.
    form.noValidate=true;
    let saving=false;
    const clearReceiptError=()=>{document.querySelectorAll('[data-receipt-field-error]').forEach(el=>el.remove());form.querySelectorAll('[aria-invalid]').forEach(el=>{el.removeAttribute('aria-invalid');el.removeAttribute('aria-describedby');});$('#receipt-error').textContent='';};
    const showReceiptError=(message,field)=>{
      clearReceiptError();
      const summary=$('#receipt-error');summary.textContent='还未保存：'+message;
      const control=field?form.elements.namedItem(field):null;
      if(control){
        const details=control.closest('details');if(details)details.open=true;
        const feedback=document.createElement('p');feedback.className='error';feedback.dataset.receiptFieldError='';feedback.id='receipt-field-error';feedback.setAttribute('role','alert');feedback.textContent=message;feedback.style.cssText='padding:10px;background:#fff0eb;border-radius:8px;font-weight:600';
        control.insertAdjacentElement('afterend',feedback);control.setAttribute('aria-invalid','true');control.setAttribute('aria-describedby',feedback.id);control.focus({preventScroll:true});control.scrollIntoView({block:'center'});
      }else{summary.tabIndex=-1;summary.focus({preventScroll:true});summary.scrollIntoView({block:'center'});}
    };
    const selectedRows=()=>drafts.map((_,i)=>i).filter(i=>{const checkbox=form.elements.namedItem('include-'+i);return checkbox.checked&&!checkbox.disabled;});
    const updateReceiptSelection=()=>{saveButton.textContent=`保存 ${selectedRows().length} 笔并返回首页`;};
    const applyReceiptAccount=()=>{const value=$('#receipt-account-all').value;selectedRows().forEach(i=>form.elements.namedItem('account-'+i).value=value);clearReceiptError();};
    $('#receipt-account-all').name='receipt-account-all';
    $('#receipt-account-all').onchange=applyReceiptAccount;
    $('#receipt-apply-account').onclick=applyReceiptAccount;
    classified.filter(c=>c.status==='matched').forEach(c=>{const checkbox=form.elements.namedItem('include-'+c.index);checkbox.checked=false;checkbox.disabled=true;});
    drafts.forEach((_,i)=>{form.elements.namedItem('include-'+i).onchange=()=>{if(form.elements.namedItem('include-'+i).checked&&$('#receipt-account-all').value)form.elements.namedItem('account-'+i).value=$('#receipt-account-all').value;updateReceiptSelection();};});
    updateReceiptSelection();
    form.onsubmit=e=>{e.preventDefault();if(saving)return;saving=true;saveButton.disabled=true;clearReceiptError();let errorField='';try{
      if(draftsEpoch!==ledgerEpoch)throw new Error('账本已更新，请重新识别后核对');
      const f=new FormData(form),records=[];let skipped=0;
      drafts.forEach((d,i)=>{
        if(!f.has('include-'+i))return;
        const date=String(f.get('date-'+i)),time=String(f.get('time-'+i)||''),type=String(f.get('type-'+i)),accountId=String(f.get('account-'+i));
        const label=`第 ${i+1} 笔“${d.merchant||d.note}”`;
        errorField='date-'+i;if(!C.isValidDate(date)||date>C.today())throw new Error(`请确认${label}的实际交易日期，不会自动填成今天`);
        errorField='time-'+i;if(time&&!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time))throw new Error(`请核对${label}的交易时间`);
        errorField='account-'+i;if(!accountId&&['transfer','repayment'].includes(type))throw new Error(`请为${label}选择实际转出账户，转账和还款需要明确两端账户`);
        errorField='amount-'+i;
        const record={id:d.id,createdAt:d.createdAt,type,amount:C.parseAmount(f.get('amount-'+i)),date,...(accountId?{accountId}:{pendingAccount:true}),category:String(f.get('category-'+i)),note:String(f.get('note-'+i)).trim(),source:'vision',sourceFingerprint:d.sourceFingerprint,...(time?{transactionTime:date+'T'+time}:{}),...Object.fromEntries(['merchant','receiptId','paymentChannel','accountHint'].filter(k=>typeof d[k]==='string'&&d[k]).map(k=>[k,d[k]])),...(['transfer','repayment'].includes(type)?{targetAccountId:String(f.get('target-'+i))}:{})};
        if(window.LedgerReconcile.classify([record],[...activeState().transactions,...records])[0].status==='matched'){skipped++;return;}
        try{C.buildEntries(record,activeState().accounts);}catch(err){errorField=(/日期/.test(err.message)?'date-':/目标|转入|相同/.test(err.message)?'target-':/分类/.test(err.message)?'category-':'account-')+i;throw new Error(`${label}：${err.message}`);}
        records.push(record);
      });
      errorField='';if(!records.length)throw new Error(skipped?'勾选的交易已经入账，无需重复保存':'请至少勾选一笔待入账交易；“已记录”不会再次保存');
      commit({...activeState(),transactions:[...activeState().transactions,...records]});
      drafts=[];receiptMode=false;receiptWarnings=[];$('#modal').close();page='home';reference=C.today();render();window.scrollTo(0,0);afterSave(records,`已保存 ${records.length} 笔，已返回首页${records.some(r=>r.pendingAccount)?`；${records.filter(r=>r.pendingAccount).length} 笔账户待归属`:''}${skipped?`；跳过 ${skipped} 笔已记录交易`:''}`);
    }catch(err){saving=false;saveButton.disabled=false;showReceiptError(err.message,errorField);}};
  }

  function settingsPage() { return `<p class="page-intro">记录保存在这台设备上。定期备份，可以在换机时恢复。</p><div class="settings-grid">${floatingPanel()}<section class="card"><h3>微信账单导入</h3><p class="helper">将微信钱包导出的个人对账 CSV 文件导入，批量记下收支，不用逐笔抄写。原始账单只在本机解析。</p><div class="backup-actions"><button class="primary" data-action="wechat">导入微信账单</button></div><div class="notice">这是账单文件导入，不是绑定微信钱包；没有自动读取或实时同步支付记录。</div></section><section class="card"><h3>账本备份</h3><p class="helper">当前${demo?'示例':'真实'}账本：${activeState().transactions.length} 笔记录。备份包含账户、期初余额、借贷记录、历史账单与预算，不包含 AI 连接码。</p><div class="backup-actions"><button class="secondary" data-action="export">导出备份</button><button class="secondary" data-action="import">恢复备份</button>${!demo&&localStorage.getItem('huayoushu.ledger.pre-v2')?'<button class="ghost" data-action="migration-backup">导出升级前账本</button>':''}<button class="ghost" data-action="csv">导出 CSV</button></div><div class="notice">手机和电脑各自保存账本，暂不自动同步。卸载应用或清理应用数据前，请先备份。</div>${loadError?'<button class="danger-button" data-action="raw-backup" style="margin-top:15px">导出原始数据</button>':''}</section><section class="card"><h3>AI 连接</h3><p class="helper">云端模式下手机联网就能识别，电脑可以关机。电脑模式保留为备用。</p><form id="settings-form"><div class="field"><label for="ai-mode">连接方式</label><select id="ai-mode" name="mode"><option value="cloud" ${settings.mode==='cloud'?'selected':''}>云端 AI · 手机联网即可</option><option value="local" ${settings.mode==='local'?'selected':''}>电脑 AI · 需要同一网络</option></select></div><div class="field"><label for="ai-base">花有数服务地址</label><input id="ai-base" name="base" type="url" placeholder="https://你的花有数服务域名" value="${esc(settings.base)}"><div class="helper">云端填已部署的 HTTPS 地址；电脑模式填局域网地址。此处不填通义千问或 GPT 官网地址。</div></div><div class="field"><label for="ai-token">花有数连接码</label><input id="ai-token" name="token" type="password" autocomplete="off" placeholder="由你的花有数服务提供" value="${esc(settings.token)}"><div class="helper">不是百炼 API Key。云服务密钥只保存在服务器。</div></div><div id="settings-error" class="error" role="alert"></div><div class="split"><span class="ai-state ${aiReady?'ready':''}">${aiStatus()}</span><button class="primary">保存并连接</button></div></form><p class="helper">选图或点闪控球时发送本次图片，文字记账发送本次文字；不上传完整账本。检查连接不会调用模型。AI 不可用时，手动记账、微信文件导入和统计仍可使用。</p></section><section class="card"><h3>看看示例账本</h3><p class="helper">体验周/月分布、消费趋势和预算提醒，示例与真实记录分开保存。</p><div class="backup-actions"><button class="secondary" data-action="${demo?'leave-demo':'demo'}">${demo?'回到我的账本':'进入示例模式'}</button></div></section><section class="card"><h3>关于花有数</h3><p class="helper">2.3.3 · 整图多笔识别 / 本机查重 / 三款助手形象</p><p class="helper">图表：Apache ECharts（Apache-2.0）<br>电脑模型：Qwen2.5-1.5B-Instruct（Apache-2.0）<br>电脑运行：Ollama（MIT）<br>云端模型：由你的云服务配置</p><p class="helper">预算提示为应用内提醒。仅在你点闪控球或选图时识别当前图片，不会持续读取支付记录。</p></section></div>`; }
  function drawCharts() {
    if(page!=='home') return;
    const summary=C.getSummary(activeState().transactions,period,reference), data=summary.categories.filter(x=>x.amount>0);
    if(!data.length) { $('#category-chart').innerHTML='<div class="empty"><div class="empty-symbol">◌</div>还没有支出记录</div>'; $('#trend-chart').innerHTML='<div class="empty"><div class="empty-symbol">⌁</div>记一笔，开始看见变化</div>';return; }
    if(!window.echarts) { $('#category-chart').innerHTML=`<div class="bars-fallback">${data.map(c=>`<div class="fallback-row"><span>${c.name}</span><i style="width:${c.percentage}%;background:${c.color}"></i><span>¥${money(c.amount)}</span></div>`).join('')}</div>`; $('#trend-chart').innerHTML=`<div class="empty">本${labels[period]}总支出 ¥${money(summary.expense)}<br>图表组件未加载，金额仍正常统计。</div>`;return; }
    const pie=echarts.init($('#category-chart'),null,{renderer:'svg'}); chartInstances.push(pie);
    pie.setOption({animationDuration:450,tooltip:{trigger:'item',formatter:p=>`${esc(p.name)}<br>¥ ${money(Math.round(p.value*100))} · ${p.percent}%`},series:[{type:'pie',radius:['60%','78%'],center:['50%','50%'],itemStyle:{borderColor:'#fffefa',borderWidth:5,borderRadius:5},label:{show:false},emphasis:{scaleSize:4},data:data.map(x=>({name:x.name,value:x.amount/100,itemStyle:{color:x.color}}))}],graphic:[{type:'text',left:'center',top:'40%',style:{text:'总支出',fill:'#8e9a8b',fontSize:11}},{type:'text',left:'center',top:'51%',style:{text:'¥ '+money(summary.expense),fill:'#2b4838',fontSize:21,fontWeight:600}}]});
    const trend=echarts.init($('#trend-chart'),null,{renderer:'svg'}); chartInstances.push(trend);
    const values=period==='day'?data.map(x=>x.amount/100):summary.trend.map(x=>x.expense/100), names=period==='day'?data.map(x=>x.name):summary.trend.map(x=>x.label);
    trend.setOption({animationDuration:500,grid:{left:5,right:6,top:17,bottom:8,containLabel:true},tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>'¥ '+Number(v).toFixed(2)},xAxis:{type:'category',data:names,axisLine:{show:false},axisTick:{show:false},axisLabel:{color:'#97a08f',fontSize:9,interval:period==='month'?Math.max(0,Math.floor(names.length/6)-1):0,margin:12}},yAxis:{type:'value',axisLabel:{color:'#a2ab9b',fontSize:9},splitLine:{lineStyle:{color:'#eef0e8',type:'dashed'}}},series:[{type:'bar',data:values,barMaxWidth:period==='month'?13:28,itemStyle:{color:'#77a284',borderRadius:[5,5,2,2]},emphasis:{itemStyle:{color:'#176c57'}}}]});
  }
  function bindLocal() {
    $('#budget-form')?.addEventListener('submit',saveBudget);
    $('#settings-form')?.addEventListener('submit',e=>{e.preventDefault();try{
      const f=new FormData(e.target), next={mode:String(f.get('mode')),base:String(f.get('base')).trim().replace(/\/+$/,''),token:String(f.get('token')).trim()};
      if(!['cloud','local'].includes(next.mode))throw new Error('请选择连接方式');
      if(next.base){const u=new URL(next.base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('请填写服务根地址，不包含其他路径');if(next.mode==='cloud'&&u.protocol!=='https:')throw new Error('云端 AI 必须使用 https:// 加密地址');}
      else if(window.HYS_NATIVE || next.mode==='cloud'&&location.protocol!=='https:')throw new Error('请填写已部署的花有数服务地址');
      if(next.mode==='cloud' && next.token.length<16)throw new Error('请填写服务提供的完整连接码（至少16个字符）');
      localStorage.setItem(SETTINGS,JSON.stringify(next));settings=next;connectionEpoch++;receiptVision=false;receiptPending=null;draftProtocolVersion=0;aiReady=null;aiConfigured=false;$('#settings-error').textContent='';render();checkConnection(true);
    }catch(err){$('#settings-error').textContent=err.message;}});
    $('#ai-input')?.addEventListener('input',e=>aiInput=e.target.value);
    $('#search')?.addEventListener('input',e=>{search=e.target.value; const pos=e.target.selectionStart; render();$('#search').focus();try{$('#search').setSelectionRange(pos,pos);}catch(_){}});
    $('#category-filter')?.addEventListener('change',e=>{categoryFilter=e.target.value;render();});
    $('#type-filter')?.addEventListener('change',e=>{typeFilter=e.target.value;render();});
  }
  function showModal(html) { const modal=$('#modal'); if(modal.open)modal.close(); modal.innerHTML=html;modal.showModal(); }
  function modalHeading(title,closable=true) {return `<div class="modal-title"><h2>${title}</h2>${closable?'<button class="modal-close" data-action="close" aria-label="关闭">×</button>':''}</div>`;}
  function onboarding() { showModal(`${modalHeading('先给生活，设个小额度',false)}<div class="helper">欢迎来到花有数。先设置至少一种预算，之后随时可以调整。</div><form id="onboard-form">${budgetInputs(activeState())}<div id="budget-error" class="error" role="alert"></div><div class="form-actions"><button type="button" class="ghost" data-action="demo">先看看示例</button><button class="primary">开始记账 →</button></div></form>`);$('#onboard-form').addEventListener('submit',saveBudget); }
  function saveBudget(e) {e.preventDefault();try{const f=new FormData(e.target), budgets={};for(const p of ['day','week','month']){const v=String(f.get(p)||'').trim();budgets[p]=v?C.parseAmount(v):0;}if(!Object.values(budgets).some(x=>x>0))throw new Error('请至少设置一种额度');commit({...activeState(),budgets,budgetReady:true});$('#modal').close();render();toast('额度已保存');}catch(err){$('#budget-error').textContent=err.message;}}
  function subChoices(){return C.subcategoriesOf(selectedCategory).map(x=>`<button type="button" class="sub-choice ${selectedSub===x.id?'active':''}" data-action="choose-sub" data-value="${x.id}">${x.name}</button>`).join('');}

  function openRecord(id, initialType='expense') {
    if(!activeState().budgetReady){onboarding();return;}
    const t=id?activeState().transactions.find(x=>x.id===id):null;
    if(!t&&!activeState().accounts.length){page='accounts';render();openAccount();return;}
    selectedCategory=t?.category||'food';selectedSub=t?.sub||(C.subcategoriesOf(selectedCategory)[0]||{id:'unknown'}).id;
    showModal(`${modalHeading(t?'编辑账单':'记下这一笔')}<form id="record-form"><div class="field"><label for="amount">金额（元）</label><input class="amount-field" id="amount" name="amount" inputmode="decimal" placeholder="0.00" value="${t?rawMoney(t.amount):''}" required autofocus></div><div class="field-row"><div class="field"><label for="record-type">业务类型</label><select id="record-type" name="type">${Object.entries(typeNames).map(([type,name])=>`<option value="${type}" ${type===(t?.type||initialType)?'selected':''}>${name}</option>`).join('')}</select></div><div class="field"><label for="record-date">日期</label><input type="date" id="record-date" name="date" value="${t?.date||C.today()}" max="${C.today()}" required></div></div><div class="field"><label id="source-label" for="record-account">实际付款账户</label><select id="record-account" name="accountId"></select></div><div class="field" id="target-field" hidden><label id="target-label" for="record-target">转入账户</label><select id="record-target" name="targetAccountId"></select></div><div id="expense-categories"><div class="field"><label>分类</label><div class="category-grid">${C.categories.map(c=>`<button type="button" class="category-choice ${selectedCategory===c.id?'active':''}" data-action="choose-category" data-value="${c.id}"><span>${c.icon}</span>${c.name}</button>`).join('')}</div></div><div class="field"><label>细分类</label><div class="sub-grid" id="sub-grid">${subChoices()}</div></div></div><div class="field"><label for="note">备注</label><input id="note" name="note" maxlength="200" value="${esc(t?.note||'')}" placeholder="这笔钱的用途"></div><p id="record-help" class="helper"></p>${journalDetails(t)}<div id="record-error" class="error" role="alert"></div><div class="form-actions">${t?`<button type="button" class="danger-button" data-action="delete" data-id="${esc(t.id)}">删除</button>`:''}<button type="button" class="secondary" data-action="close">取消</button><button class="primary">保存账单</button></div></form>`);
    const refresh=()=>{const type=$('#record-type').value,movement=['transfer','repayment'].includes(type),source=$('#record-account').value||t?.accountId||'',target=$('#record-target').value||t?.targetAccountId||'';$('#record-account').innerHTML=accountOptions(source,type==='expense'?'':'asset',!!t&&!t.accountId&&!movement,!!t?.pendingAccount&&!movement);$('#record-target').innerHTML=accountOptions(target,type==='repayment'?'liability':'asset');$('#target-field').hidden=!movement;$('#expense-categories').hidden=movement;$('#source-label').textContent=type==='income'?'收款账户':'实际付款账户';$('#target-label').textContent=type==='repayment'?'归还的信用卡':'转入账户';$('#record-help').textContent=movement?'这是账户之间的变化，不重复计入消费预算。信用卡利息和手续费请另记支出。':t?.pendingAccount?'这笔交易已保存、账户待归属。可以继续保持待归属，或补选实际资金账户；补选会更新原账单，不会新增一笔。':'微信是支付渠道；请选择实际扣款的银行卡、信用卡或零钱账户。';};refresh();$('#record-type').addEventListener('change',refresh);
    $('#record-form').addEventListener('submit',e=>{e.preventDefault();try{const f=new FormData(e.target),date=String(f.get('date')),type=String(f.get('type')),accountId=String(f.get('accountId')),targetAccountId=String(f.get('targetAccountId'));if(!C.isValidDate(date)||date>C.today())throw new Error('请选择今天或过去的有效日期');if(!accountId&&(!t||t.accountId||['transfer','repayment'].includes(type)))throw new Error('请选择实际资金账户；如还没有，请先在账户页添加');const record={id:t?.id||uid(),type,amount:C.parseAmount(f.get('amount')),category:selectedCategory,sub:selectedSub,date,note:String(f.get('note')).trim(),createdAt:t?.createdAt||new Date().toISOString(),...Object.fromEntries(['source','externalId','paymentChannel','merchant','receiptId','sourceFingerprint','accountHint'].filter(k=>t?.[k]!==undefined).map(k=>[k,t[k]])),...(accountId?{accountId}:t?.pendingAccount?{pendingAccount:true}:{legacy:true}),...(['transfer','repayment'].includes(type)?{targetAccountId}:{}),...(t?.transactionTime&&t.date===date?{transactionTime:t.transactionTime}:{}),...(t?.fixed?{fixed:true}:{})};commit({...activeState(),transactions:t?activeState().transactions.map(x=>x.id===t.id?record:x):[...activeState().transactions,record]});$('#modal').close();render();afterSave([record]);}catch(err){$('#record-error').textContent=err.message;}});
  }
  function afterSave(records, savedMessage) {
    const alerts=new Set(); for(const r of records.filter(x=>x.type==='expense')){for(const [p,b] of Object.entries(C.getBudgetStatuses(activeState(),r.date))){if(b.level==='exceeded') alerts.add(`${C.getPeriodRange(p,r.date).label} 超额度 ¥${money(-b.remaining)}`);else if(b.level==='reached')alerts.add(`${C.getPeriodRange(p,r.date).label} 额度已用完`);else if(b.level==='warning')alerts.add(`${C.getPeriodRange(p,r.date).label} 额度已用 ${Math.floor(b.ratio*100)}%`);}}
    toast(`${savedMessage||`已保存${demo?'到示例账本':''}`}${alerts.size?'\n'+[...alerts].join('\n'):''}`);
    if([...alerts].some(x=>x.includes('超额度')))showModal(`${modalHeading('这笔记好了，也超额度了')}<p class="page-intro">${[...alerts].map(esc).join('<br>')}</p><p class="helper">账单已正常保存。可以到预算页看看剩余额度，安排接下来的开销。</p><div class="form-actions"><button class="primary" data-action="close">知道了</button></div>`);
  }
  async function parseAi() {
    if(aiBusy)return;if(!activeState().budgetReady){onboarding();return;} aiInput=$('#ai-input')?.value||aiInput; if(!aiInput.trim()){toast('先说说这笔钱怎么花的');return;}
    receiptMode=false;
    const requestEpoch=ledgerEpoch, requestConnection=connectionEpoch;aiBusy=true;render();try{if(!settings.token&&!window.HYS_NATIVE&&!settings.base){await checkConnection();} if(settings.mode==='cloud'&&draftProtocolVersion<2){await checkConnection();if(draftProtocolVersion<2)throw new Error('云端网关尚未升级或暂时无法连接，请检查连接；截图/语音文字已保留，手工记账仍可用。');} const response=await fetchJson('/api/parse',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+settings.token},body:JSON.stringify({text:aiInput,today:C.today(),inputSource})});if(requestEpoch!==ledgerEpoch||requestConnection!==connectionEpoch){toast('账本或连接已切换，本次 AI 结果未入账，请重新识别');return;}if(!activeState().budgetReady)throw new Error('请先设置额度');draftsEpoch=requestEpoch;if(settings.mode==='cloud'&&!(Number(response.draftProtocolVersion)>=2))throw new Error('云端网关版本不匹配，请更新网关后再识别');if(!Array.isArray(response.drafts)||!response.drafts.length||response.drafts.length>20)throw new Error('AI 没有返回可确认的账单，请补充具体金额。');drafts=response.drafts.map(d=>{const guess=C.classify(`${d.note||''} ${d.sourceText||''}`,d.type);const category=d.type==='expense'&&d.category==='other'&&guess.category!=='other'?guess.category:d.category;return {...d,category,id:uid(),createdAt:new Date().toISOString()};});drafts.forEach(d=>{if(!Object.hasOwn(typeNames,d.type)||!Number.isSafeInteger(d.amount)||d.amount<=0||d.amount>C.MAX_AMOUNT||!C.isValidDate(d.date)||d.date>C.today()||typeof d.note!=='string')throw new Error('AI 返回的账单不完整，请补充金额和日期后重试');});aiReady=true;showDrafts();}catch(e){toast(e.message.includes('Failed')?'无法连接 AI 服务，请检查网络、服务地址与连接码；本地账本未受影响':e.message);}finally{aiBusy=false;render();}}

  function showDrafts() {
    showModal(`${modalHeading('核对一下，再入账')}<p class="helper">请核对金额、日期和资金账户。截图没有日期时会暂填今天，请按实际交易日期修改。</p>${!activeState().accounts.length?'<p class="notice">先在账户页添加银行卡或钱包，再回来整理；识别文字会保留。</p>':''}<form id="draft-form">${drafts.map((d,i)=>`<div class="draft-row"><div class="split"><strong>第 ${i+1} 笔</strong><label><input type="checkbox" name="include-${i}" checked> 保存此笔</label></div><div class="draft-fields"><label>金额（元）<input name="amount-${i}" aria-label="第${i+1}笔金额" inputmode="decimal" value="${rawMoney(d.amount)}"></label><label>类型<select name="type-${i}" data-draft-type="${i}" aria-label="第${i+1}笔类型">${Object.entries(typeNames).map(([type,name])=>`<option value="${type}" ${type===d.type?'selected':''}>${name}</option>`).join('')}</select></label><label>分类<select name="category-${i}" aria-label="第${i+1}笔分类">${C.categories.map(c=>`<option value="${c.id}" ${d.category===c.id?'selected':''}>${c.name}</option>`).join('')}</select></label><label>日期${d.dateNeedsConfirmation?'（请确认）':''}<input type="date" name="date-${i}" aria-label="第${i+1}笔日期" value="${esc(d.date)}" max="${C.today()}"></label><label>付款/收款账户<select name="account-${i}" aria-label="第${i+1}笔资金账户">${accountOptions()}</select></label><label id="draft-target-${i}" ${['transfer','repayment'].includes(d.type)?'':'hidden'}>转入/还款账户<select name="target-${i}" aria-label="第${i+1}笔目标账户">${accountOptions('',d.type==='repayment'?'liability':'asset')}</select></label></div>${d.accountHint||d.fromAccountHint||d.toAccountHint||d.channelHint?`<p class="helper">原文线索：${esc([d.accountHint,d.fromAccountHint,d.toAccountHint,d.channelHint].filter(Boolean).join(' · '))}（仍需选账户）</p>`:''}<input class="draft-note" name="note-${i}" aria-label="第${i+1}笔备注" maxlength="200" value="${esc(d.note)}"></div>`).join('')}<div class="error" id="draft-error" role="alert"></div><div class="form-actions"><button type="button" class="secondary" data-action="close">暂不保存</button><button class="primary">确认入账</button></div></form>`);
    document.querySelectorAll('[data-draft-type]').forEach(el=>el.addEventListener('change',()=>{const i=el.dataset.draftType;$('#draft-target-'+i).hidden=!['transfer','repayment'].includes(el.value);$(`[name="target-${i}"]`).innerHTML=accountOptions('',el.value==='repayment'?'liability':'asset');}));
    $('#draft-form').addEventListener('submit',e=>{e.preventDefault();try{if(draftsEpoch!==ledgerEpoch||!activeState().budgetReady)throw new Error('账本已变更，请重新整理识别文字');const f=new FormData(e.target),records=drafts.flatMap((d,i)=>{if(!f.has('include-'+i))return [];const date=String(f.get('date-'+i)),type=String(f.get('type-'+i)),accountId=String(f.get('account-'+i));if(!C.isValidDate(date)||date>C.today())throw new Error('账单日期须为今天或过去的有效日期');if(!accountId)throw new Error('请为每笔账单选择实际资金账户');return [{id:d.id,type,accountId,...(['transfer','repayment'].includes(type)?{targetAccountId:String(f.get('target-'+i))}:{}),amount:C.parseAmount(f.get('amount-'+i)),date,category:String(f.get('category-'+i)),note:String(f.get('note-'+i)).trim(),createdAt:d.createdAt,source:inputSource}];});if(!records.length)throw new Error('请至少勾选一笔');commit({...activeState(),transactions:[...activeState().transactions,...records]});drafts=[];aiInput='';inputSource='text';$('#modal').close();render();afterSave(records);}catch(err){$('#draft-error').textContent=err.message;}});
  }
  function download(name,content,type='application/json') {const url=URL.createObjectURL(new Blob(['\ufeff',content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),20000);}
  function exportBackup(raw=false) {let content;try{content=raw?(localStorage.getItem(KEY)||''):JSON.stringify(activeState(),null,2);}catch(e){toast('无法读取存储，请勿清理应用数据');return;}showModal(`${modalHeading(raw?'原始账本数据':'保存你的账本备份')}<p class="helper">请把完整文本复制并保存到应用之外。也可以下载 JSON 文件；鸿蒙端优先使用复制文本。</p><textarea class="backup-text" id="backup-text" readonly aria-label="账本备份文本"></textarea><div class="form-actions"><button class="secondary" data-action="download-backup">下载文件</button><button class="primary" data-action="copy-backup">复制全文</button></div><p class="helper">备份不包含配对码。请妥善保存含个人收支的备份文件。</p>`);$('#backup-text').value=content;}
  function importBackup() {showModal(`${modalHeading('恢复账本')}<p class="helper">粘贴备份文本，或读取 JSON 文件。验证通过后会显示笔数，确认后替换当前${demo?'示例':'真实'}账本。</p><div class="field"><input id="backup-file" type="file" accept=".json,application/json" aria-label="选择备份文件"></div><textarea class="backup-text" id="import-text" placeholder="在这里粘贴完整备份文本" aria-label="要恢复的备份文本"></textarea><div id="import-error" class="error" role="alert"></div><div class="form-actions"><button class="secondary" data-action="close">取消</button><button class="primary" data-action="validate-import">检查备份</button></div>`);$('#backup-file').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>15000000){$('#import-error').textContent='备份文件过大（最大 15MB）';return;}$('#import-text').value=await f.text();});}
  let importCandidate=null, wechatCandidate=null, wechatEpoch=0, wechatPreviewLimit=50, wechatZipBytes=null;

  // ---- 微信账单文件读取：CSV / TXT / 微信压缩包（ZipCrypto 加密）----
  const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[i]=c>>>0;}return t;})();
  function crc32(bytes,crc=0){crc=(crc^0xFFFFFFFF)>>>0;for(let i=0;i<bytes.length;i++)crc=(CRC_TABLE[(crc^bytes[i])&0xff]^(crc>>>8))>>>0;return (crc^0xFFFFFFFF)>>>0;}
  class ZipCrypto{constructor(pw){this.k=[0x12345678,0x23456789,0x34567890];const enc=new TextEncoder().encode(pw);for(const b of enc)this.update(b);}
    update(b){this.k[0]=(CRC_TABLE[(this.k[0]^b)&0xff]^(this.k[0]>>>8))>>>0;this.k[1]=((this.k[1]+(this.k[0]&0xff))*134775813+1)>>>0;const t=(this.k[1]>>>24)&0xff;this.k[2]=(CRC_TABLE[(this.k[2]^t)&0xff]^(this.k[2]>>>8))>>>0;}
    decrypt(data){const out=new Uint8Array(data.length);for(let i=0;i<data.length;i++){const t=(this.k[2]|2)&0xffff;const p=data[i]^((Math.imul(t,t^1)>>>8)&0xff);out[i]=p;this.update(p);}return out;}}
  function zipEntries(bytes){const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let eocd=-1;const floor=Math.max(0,bytes.length-65558);for(let i=bytes.length-22;i>=floor;i--){if(dv.getUint32(i,true)===0x06054b50){eocd=i;break;}}if(eocd<0)throw new Error('压缩包已损坏或格式不受支持');const count=dv.getUint16(eocd+10,true);let off=dv.getUint32(eocd+16,true);const list=[];for(let n=0;n<count;n++){if(off+46>bytes.length||dv.getUint32(off,true)!==0x02014b50)break;const flags=dv.getUint16(off+8,true),method=dv.getUint16(off+10,true),crc=dv.getUint32(off+16,true),compSize=dv.getUint32(off+20,true),nameLen=dv.getUint16(off+28,true),extraLen=dv.getUint16(off+30,true),commLen=dv.getUint16(off+32,true),localOff=dv.getUint32(off+42,true);const name=new TextDecoder('utf-8').decode(bytes.subarray(off+46,off+46+nameLen));list.push({name,flags,method,crc,compSize,localOff});off+=46+nameLen+extraLen+commLen;}return list;}
  async function inflateRaw(bytes){if(typeof DecompressionStream!=='function')throw new Error('当前系统不支持应用内解压，请先在文件管理里解压后再选择 CSV');const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));return new Uint8Array(await new Response(stream).arrayBuffer());}
  async function readZipEntry(bytes,entry,password){const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(dv.getUint32(entry.localOff,true)!==0x04034b50)throw new Error('压缩包已损坏');const nameLen=dv.getUint16(entry.localOff+26,true),extraLen=dv.getUint16(entry.localOff+28,true);const start=entry.localOff+30+nameLen+extraLen;let data=bytes.subarray(start,start+entry.compSize);if(entry.flags&1){if(!password)throw new Error('这个压缩包有密码，请在下方输入微信里收到的解压密码后点“解压并读取”');const zc=new ZipCrypto(password);data=zc.decrypt(data);if(data.length<=12)throw new Error('压缩包密码不正确');const header=data.subarray(0,12);const crcCheck=(entry.crc>>>24)&0xff;const timeCheck=(dv.getUint16(entry.localOff+12,true)>>>8)&0xff;if(crcCheck!==0&&header[11]!==crcCheck&&header[11]!==timeCheck)throw new Error('压缩包密码不正确，请核对微信消息里的密码');data=data.subarray(12);}let out;if(entry.method===0)out=data;else if(entry.method===8)out=await inflateRaw(data);else throw new Error('压缩包使用了不支持的压缩方式，请解压后选择 CSV');if(!(entry.flags&8)&&crc32(out)!==entry.crc)throw new Error('压缩包校验失败，请重新下载账单');return out;}
  function decodeBillText(bytes){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}if(text.includes('\0'))throw new Error('文件不是 CSV 文本，请先转换为 CSV');return text;}
  function csvField(v){const s=String(v==null?'':v);return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
  function colIndex(ref){let n=0;for(const ch of String(ref).replace(/[^A-Z]/g,''))n=n*26+(ch.charCodeAt(0)-64);return n-1;}
  const DATE_FMT_IDS={14:1,15:1,16:1,17:1,18:1,19:1,20:1,21:1,22:1,45:1,46:1,47:1};
  function isDateFormatCode(code){const t=String(code||'');return /[ymd]/i.test(t);}
  function excelSerialToText(value){const n=Number(value);if(!Number.isFinite(n))return String(value);const d=new Date(Math.round((n-25569)*86400000));const p=x=>String(x).padStart(2,'0');return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds());}
  function cellText(cell,shared){const t=cell.getAttribute('t');if(t==='s'){const v=cell.getElementsByTagName('v')[0];return v?(shared[Number(v.textContent)]||''):'';}if(t==='inlineStr')return Array.from(cell.getElementsByTagName('t')).map(x=>x.textContent||'').join('');const v=cell.getElementsByTagName('v')[0];return v?v.textContent:'';}
  async function xlsxToCsv(bytes){
    const entries=zipEntries(bytes);const byName=n=>entries.find(e=>e.name.toLowerCase()===n);
    const readXml=async e=>new DOMParser().parseFromString(new TextDecoder('utf-8').decode(await readZipEntry(bytes,e,'')),'application/xml');
    let shared=[];const sh=byName('xl/sharedstrings.xml');
    if(sh){const doc=await readXml(sh);shared=Array.from(doc.getElementsByTagName('si')).map(si=>Array.from(si.getElementsByTagName('t')).map(t=>t.textContent||'').join(''));}
    let dateXfs=[];const stE=byName('xl/styles.xml');
    if(stE){const doc=await readXml(stE);const custom={};Array.from(doc.getElementsByTagName('numFmt')).forEach(f=>{custom[f.getAttribute('numFmtId')]=f.getAttribute('formatCode');});const holder=doc.getElementsByTagName('cellXfs')[0];if(holder)dateXfs=Array.from(holder.getElementsByTagName('xf')).map(xf=>{const id=Number(xf.getAttribute('numFmtId')||'0');return Boolean(DATE_FMT_IDS[id]||isDateFormatCode(custom[id]));});}
    const sheet=byName('xl/worksheets/sheet1.xml')||entries.find(e=>/^xl\/worksheets\/[^/]+\.xml$/i.test(e.name));
    if(!sheet)throw new Error('表格里没有找到工作表');
    const doc=await readXml(sheet);const rows=Array.from(doc.getElementsByTagName('row'));if(!rows.length)throw new Error('表格是空的');
    const out=[];
    for(const row of rows){const vals=[];for(const cell of Array.from(row.getElementsByTagName('c'))){const ci=colIndex(cell.getAttribute('r')||'');const at=ci>=0?ci:vals.length;const sAttr=cell.getAttribute('s');const sIdx=sAttr===null?-1:Number(sAttr);let v=cellText(cell,shared);if(v&&sIdx>=0&&dateXfs[sIdx]&&cell.getAttribute('t')!=='s')v=excelSerialToText(v);vals[at]=v;}out.push(vals.map(csvField).join(','));}
    return out.join('\n');
  }
  async function extractBillText(name,bytes,password){
    const magic=new TextDecoder('latin1').decode(bytes.subarray(0,4));
    if(magic==='%PDF')throw new Error('这是「交易明细证明」PDF，不能导入。请改选微信「下载账单 → 用于个人对账」得到的账单流水文件（CSV / XLSX / 压缩包）。');
    if(bytes[0]===0x50&&bytes[1]===0x4b){
      if(/\.xlsx$/i.test(name))return await xlsxToCsv(bytes);
      const entries=zipEntries(bytes).filter(e=>!/\/$/.test(e.name));
      const pick=entries.find(e=>/\.csv$/i.test(e.name))||entries.find(e=>/\.txt$/i.test(e.name))||entries.find(e=>/\.xlsx$/i.test(e.name));
      if(!pick)throw new Error('压缩包里没有找到 CSV 或 XLSX 账单文件');
      const inner=await readZipEntry(bytes,pick,password);
      return /\.xlsx$/i.test(pick.name)?await xlsxToCsv(inner):decodeBillText(inner);
    }
    return decodeBillText(bytes);
  }
  function openWechat() {
    if(!activeState().budgetReady){onboarding();return;}
    wechatCandidate=null;wechatZipBytes=null;
    const html=[modalHeading('导入微信账单'),
      '<p class="helper">微信“我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账”。下载到手机后直接选那个文件即可（CSV / XLSX / 压缩包都支持）。</p>',
      '<div class="notice">不用一笔笔抄写。文件只在本机解析，不上传给 AI。这里是文件导入，不是钱包绑定或实时同步。</div>',
      '<div class="field"><label for="wechat-file">选择账单文件</label><input id="wechat-file" type="file" accept=".csv,.txt,.xlsx,.zip,text/csv,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="微信账单文件"><p class="helper">手机浏览器下载的文件一般在「我的手机 / Download / com.huawei.hmos.browser」。支持 CSV、TXT、XLSX 和微信的加密压缩包；“交易明细证明”PDF 无法导入。</p></div>',
      '<div class="field" id="wechat-pw-wrap" hidden><label for="wechat-password">压缩包密码</label><input id="wechat-password" type="text" inputmode="numeric" placeholder="微信“微信支付”消息里收到的密码" aria-label="压缩包密码"><p class="helper">填好后点“解压并读取”。</p><button class="secondary" type="button" data-action="unzip-wechat">解压并读取</button></div>',
      '<details><summary class="muted">也可以粘贴 CSV 文本</summary><textarea class="backup-text" id="wechat-text" aria-label="微信账单CSV文本" placeholder="包含交易时间、收/支、金额等列的完整 CSV"></textarea></details>',
      '<div class="error" id="wechat-error" role="alert"></div>',
      '<div class="form-actions"><button class="secondary" data-action="close">取消</button><button class="primary" data-action="preview-wechat">检查并预览</button></div>'
    ].join('');
    showModal(html);
    document.getElementById('wechat-file').addEventListener('change',async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>15000000)throw new Error('账单文件过大，请分时间段导出（每个文件最大 15MB）');const bytes=new Uint8Array(await f.arrayBuffer());wechatZipBytes=bytes;const text=await extractBillText(f.name,bytes,'');document.getElementById('wechat-text').value=text;document.getElementById('wechat-error').textContent='文件已读取，点击“检查并预览”。';}catch(err){if(/密码/.test(err.message)&&wechatZipBytes){const w=document.getElementById('wechat-pw-wrap');if(w)w.hidden=false;}document.getElementById('wechat-error').textContent=err.message;}});
  }
  function previewWechat() {
    try {if(!window.WechatImport)throw new Error('导入组件尚未加载，请重新打开应用');const text=$('#wechat-text').value;if(text.length>15000000)throw new Error('账单文件过大');wechatCandidate=WechatImport.parseWechatCsv(text,{existingTransactions:activeState().transactions});wechatEpoch=ledgerEpoch;wechatPreviewLimit=50;showWechatPreview();}
    catch(err){$('#wechat-error').textContent=err.message;}
  }
  function showWechatPreview() {
    const r=wechatCandidate, txs=r.transactions;
    const expense=txs.filter(t=>t.type==='expense').reduce((a,t)=>a+t.amount,0), income=txs.filter(t=>t.type==='income').reduce((a,t)=>a+t.amount,0);
    showModal(`${modalHeading('先核对，再批量入账')}<div class="notice">可导入 ${txs.length} 笔 · 重复 ${r.duplicates.length} 笔 · 跳过 ${r.skipped.length} 笔<br>支出 ¥${money(expense)} / 收入 ¥${money(income)}</div><p class="helper">导入记录暂不绑定资金账户，仅参加历史收支统计，不影响账户余额。分类可编辑；退款及状态不明的记录请核对。已有手工/AI录入的同笔消费也请核对，交易编号去重仅适用于账单导入记录。</p>${r.warnings.length?`<details open><summary class="error">${r.warnings.length} 条需要留意</summary><div class="helper">${r.warnings.slice(0,50).map(w=>`第 ${Number(w.row)} 行：${esc(w.message)}`).join('<br>')}${r.warnings.length>50?'<br>其余提示请分段导入核对。':''}</div></details>`:''}${r.skipped.length?`<details><summary class="helper">查看跳过原因</summary><div class="helper">${r.skipped.slice(0,50).map(w=>`第 ${Number(w.row)} 行：${esc(w.reason)}`).join('<br>')}</div></details>`:''}<div style="max-height:290px;overflow:auto;margin-top:14px">${txs.slice(0,wechatPreviewLimit).map(t=>`<div class="transaction" style="grid-template-columns:34px 1fr auto"><div class="category-icon">${category(t.category).icon}</div><div><div class="transaction-name">${esc(t.note)}</div><div class="transaction-meta">${t.date} · ${t.type==='income'?'收入':category(t.category).name}</div></div><div class="transaction-amount ${t.type==='income'?'income':''}">${t.type==='income'?'+':'−'}${money(t.amount)}</div></div>`).join('')}</div>${txs.length>wechatPreviewLimit?`<button class="text-button" data-action="more-wechat" style="margin-top:14px">已展示 ${wechatPreviewLimit}/${txs.length} 笔，查看更多</button>`:''}<div id="wechat-confirm-error" class="error" role="alert"></div><div class="form-actions"><button class="secondary" data-action="close">暂不导入</button><button class="primary" data-action="confirm-wechat" ${txs.length?'':'disabled'}>确认导入 ${txs.length} 笔</button></div>`);
  }
  function confirmWechat() {
    try {if(!wechatCandidate||wechatEpoch!==ledgerEpoch||!activeState().budgetReady)throw new Error('账本已变更，请重新检查文件后导入');const ids=new Set(activeState().transactions.map(t=>t.id));const records=wechatCandidate.transactions.filter(t=>!ids.has(t.id));if(!records.length)throw new Error('这些账单已存在，无需重复导入');commit({...activeState(),transactions:[...activeState().transactions,...records]});ledgerEpoch++;invalidateFloating();wechatCandidate=null;$('#modal').close();page='home';reference=C.today();render();afterSave([{type:'expense',date:C.today()}],`已导入 ${records.length} 笔微信账单，图表和额度已更新`);}
    catch(err){$('#wechat-confirm-error').textContent=err.message;}
  }
  document.addEventListener('click',async e=>{
    const b=e.target.closest('[data-action]');if(!b)return;const action=b.dataset.action;
    try {
      if(action==='navigate'){clearTimeout(toastTimer);$('#toast').classList.remove('visible');page=b.dataset.page;render();window.scrollTo(0,0);if(page==='ai'||page==='settings')checkConnection();}
      else if(action==='period'){period=b.dataset.value;render();}
      else if(action==='shift'){reference=C.shiftPeriod(period,reference,Number(b.dataset.value));render();}
      else if(action==='today'){reference=C.today();render();}
      else if(action==='add')openRecord();
      else if(action==='add-account')openAccount();
      else if(action==='new-transfer')openRecord(null,'transfer');
      else if(action==='new-repayment')openRecord(null,'repayment');
      else if(action==='float-open'){page='settings';render();refreshFloatingStatus();}
      else if(action==='assistant-select')await chooseAvatar(b.dataset.value);
      else if(action==='receipt-retry'){if(receiptPending)await parseReceipt(receiptPending);}
      else if(action==='receipt-review')showReceiptDrafts();
      else if(action==='discard-drafts'){drafts=[];receiptMode=false;receiptWarnings=[];$('#modal').close();render();}
      else if(action==='float-start')await toggleFloating(true);
      else if(action==='float-stop')await toggleFloating(false);
      else if(action==='float-refresh'){await refreshFloatingStatus();readFloatingCapture();}
      else if(action==='float-review')reviewFloating();
      else if(action==='float-replace')reviewFloating(b.dataset.id);
      else if(action==='float-discard')clearFloatingPending();
      else if(action==='capture-image')capture('image');
      else if(action==='capture-voice')capture('voice');
      else if(action==='capture-cancel')cancelCapture();
      else if(action==='capture-stop'){if(captureSession?.kind==='voice'){b.disabled=true;$('#capture-state').textContent='正在整理识别结果…';nativeCall('stopVoice',[]).catch(()=>toast('停止录音失败，请点取消'));}}
      else if(action==='edit')openRecord(b.dataset.id);
      else if(action==='close')$('#modal').close();
      else if(action==='choose-category'){selectedCategory=b.dataset.value;selectedSub=(C.subcategoriesOf(selectedCategory)[0]||{id:'unknown'}).id;document.querySelectorAll('.category-choice').forEach(x=>x.classList.toggle('active',x===b));const grid=$('#sub-grid');if(grid)grid.innerHTML=subChoices();}
      else if(action==='choose-sub'){selectedSub=b.dataset.value;document.querySelectorAll('.sub-choice').forEach(x=>x.classList.toggle('active',x===b));}
      else if(action==='drill'){drillCat=drillCat===b.dataset.value?'':b.dataset.value;drillSub='';render();}
      else if(action==='drill-sub'){const parts=String(b.dataset.value).split('|');drillCat=parts[0];drillSub=drillSub===parts[1]?'':parts[1];render();}
      else if(action==='drill-to-bill'){page='list';categoryFilter=b.dataset.value;render();window.scrollTo(0,0);}
      else if(action==='fix-cat'){const one=activeState().transactions.find(x=>x.id===b.dataset.id);if(!one)throw new Error('这笔账单找不到了，请刷新');showModal(`${modalHeading('这笔该归哪儿？')}<p class="page-intro">「${esc(one.note||'未写备注')}」现在算作「${category(one.category).name} · ${esc(C.subName(one.category,one.sub))}」。选一个新分类，统计和账单会立刻跟着变。</p><div class="fix-grid">${C.categories.map(c=>`<button type="button" class="fix-choice ${c.id===one.category?'active':''}" data-action="assign-cat" data-id="${one.id}" data-value="${c.id}"><span>${c.icon}</span>${c.name}</button>`).join('')}</div><div class="form-actions"><button type="button" class="ghost" data-action="close">取消</button></div>`);}
      else if(action==='assign-cat'){const list=activeState().transactions,id=b.dataset.id,cat=b.dataset.value;const old=list.find(x=>x.id===id);if(!old)throw new Error('这笔账单找不到了，请刷新');const guess=C.classify(old.note,old.type);const sub=guess.category===cat?guess.sub:(C.subcategoriesOf(cat)[0]||{id:'unknown'}).id;commit({...activeState(),transactions:list.map(x=>x.id===id?{...x,category:cat,sub:sub,fixed:true}:x)});$('#modal').close();drillCat=cat;drillSub='';render();toast(`已改到「${category(cat).name}」`);}
      else if(action==='reclass'){const before=activeState().transactions;const next=before.map(t=>{if(t.fixed||!['income','expense'].includes(t.type))return t;const g=C.classify(t.note,t.type);return {...t,category:g.category,sub:g.sub};});const changed=next.filter((t,i)=>t.category!==before[i].category||t.sub!==before[i].sub).length;if(!changed){toast('分类已经是最新的，没有需要调整的记录');return;}commit({...activeState(),transactions:next});render();toast(`已重新分类 ${changed} 笔，其余保持不变`);}
      else if(action==='demo'){clearTimeout(toastTimer);$('#toast').classList.remove('visible');ledgerEpoch++;invalidateFloating();drafts=[];demo=true;demoState ||= C.seedDemo(C.today());page='home';reference=C.today();$('#modal').close();render();}
      else if(action==='leave-demo'){clearTimeout(toastTimer);$('#toast').classList.remove('visible');ledgerEpoch++;invalidateFloating();drafts=[];demo=false;page='home';render();if(!state.budgetReady&&!loadError)onboarding();}
      else if(action==='delete'){const id=b.dataset.id;showModal(`${modalHeading('删除这笔账单？')}<p class="page-intro">删除后，相应的统计与剩余额度会一并更新。</p><div class="form-actions"><button class="secondary" data-action="close">取消</button><button class="danger-button" data-action="confirm-delete" data-id="${esc(id)}">确认删除</button></div>`);}
      else if(action==='confirm-delete'){commit({...activeState(),transactions:activeState().transactions.filter(t=>t.id!==b.dataset.id)});$('#modal').close();render();toast('账单已删除');}
      else if(action==='example'){inputSource='text';aiInput=b.dataset.value;$('#ai-input').value=aiInput;$('#ai-input').focus();}
      else if(action==='check-ai')checkConnection(true);
      else if(action==='parse')parseAi();
      else if(action==='unzip-wechat'){const pwEl=$('#wechat-password');const pw=pwEl?pwEl.value.trim():'';(async()=>{try{if(!wechatZipBytes)throw new Error('请先选择压缩包');if(!pw)throw new Error('请输入压缩包密码');const text=await extractBillText('账单.zip',wechatZipBytes,pw);$('#wechat-text').value=text;$('#wechat-error').textContent='已解压并读取，点击“检查并预览”。';}catch(err){$('#wechat-error').textContent=err.message;}})();}
      else if(action==='wechat')openWechat();
      else if(action==='preview-wechat')previewWechat();
      else if(action==='confirm-wechat')confirmWechat();
      else if(action==='more-wechat'){wechatPreviewLimit+=50;showWechatPreview();}
      else if(action==='export')exportBackup();
      else if(action==='raw-backup')exportBackup(true);
      else if(action==='migration-backup'){exportBackup();$('#backup-text').value=localStorage.getItem('huayoushu.ledger.pre-v2')||'';}
      else if(action==='import')importBackup();
      else if(action==='download-backup'){if(window.HYS_NATIVE){if(!window.HysNative?.saveBackup){toast('当前容器不支持文件保存，请复制备份全文');return;}const result=await nativeCall('saveBackup',[$('#backup-text').value]);toast(result==='saved'?'备份文件已保存':result==='cancelled'?'已取消保存':'备份未保存，请重试或复制全文');}else{download(`花有数-${demo?'示例-':''}${C.today()}.json`,$('#backup-text').value);toast('已尝试下载备份文件，请核对浏览器下载记录');}}
      else if(action==='copy-backup'){const ta=$('#backup-text');ta.focus();ta.select();try{await navigator.clipboard.writeText(ta.value);toast('完整备份已复制，请保存到应用之外');}catch(_){if(document.execCommand('copy'))toast('备份已复制');else toast('已选中全文，请长按文本选择复制');}}
      else if(action==='validate-import'){try{const txt=$('#import-text').value.replace(/^\uFEFF/,'');if(txt.length>15000000)throw new Error('备份过大');importCandidate=C.validateState(JSON.parse(txt));showModal(`${modalHeading('备份检查通过')}<p class="page-intro">备份包含 ${importCandidate.transactions.length} 笔记录。恢复将替换当前${demo?'示例':'真实'}账本的 ${activeState().transactions.length} 笔记录与预算。</p><p class="helper">请确认已保存当前账本备份，替换后无法自动撤销。</p><div class="form-actions"><button class="secondary" data-action="close">取消</button><button class="primary" data-action="confirm-import">确认替换并恢复</button></div>`);}catch(err){$('#import-error').textContent='无法恢复：'+err.message;}}
      else if(action==='confirm-import'){if(!importCandidate)throw new Error('请重新选择备份');if(loadError&&!demo){if(localStorage.getItem(KEY)!==lastStored)throw new Error('其他页面已更新账本，请先刷新，避免覆盖新记录');const serialized=JSON.stringify(importCandidate);localStorage.setItem(KEY,serialized);lastStored=serialized;state=importCandidate;loadError='';}else commit(importCandidate);ledgerEpoch++;invalidateFloating();drafts=[];importCandidate=null;$('#modal').close();render();toast('账本已恢复');if(!activeState().budgetReady)onboarding();}
      else if(action==='csv'){if(window.HYS_NATIVE){toast('鸿蒙版请使用 JSON 完整备份；CSV 可在电脑网页版导出');return;}const q=v=>'"'+String(v).replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""')+'"';const rows=[['日期','类型','分类','金额（元）','备注','资金账户','账户状态'],...[...activeState().transactions].sort(sortTransactions).map(t=>[t.date,typeNames[t.type]||t.type,category(t.category).name,rawMoney(t.amount),t.note,t.accountId?accountName(t.accountId):'',t.pendingAccount?'账户待归属':t.accountId?'已归属':'历史/导入 · 账户未确认'])];download(`花有数-${C.today()}.csv`,rows.map(r=>r.map(q).join(',')).join('\r\n'),'text/csv;charset=utf-8');toast('已尝试导出 CSV，完整恢复请使用 JSON 备份');}
    } catch(err){toast(err.message);}
  });
  window.addEventListener('resize',()=>chartInstances.forEach(c=>c.resize()));
  window.addEventListener('storage',e=>{if(e.key===KEY&&!demo&&!$('#modal').open){try{state=C.validateState(JSON.parse(e.newValue));lastStored=e.newValue;loadError='';ledgerEpoch++;invalidateFloating();render();}catch(_){toast('另一个页面的账本更新无效，请刷新核对');}}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&captureSession?.kind==='voice')cancelCapture();if(!document.hidden){refreshFloatingStatus();readFloatingCapture();}});
  window.addEventListener('storage',e=>{if(e.key===KEY)invalidateFloating();});
  $('#modal').addEventListener('cancel',e=>{if(captureSession){cancelCapture();return;}if(!activeState().budgetReady && !loadError)e.preventDefault();});
  render();
  if(!state.budgetReady&&!loadError)onboarding();
  checkConnection();
  refreshFloatingStatus();readFloatingCapture();
})();
