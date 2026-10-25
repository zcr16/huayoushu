const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const { browserOptions } = require('./browser.cjs');
const C=require('../web/core.js'),WEB=path.join(__dirname,'../web'),OUT=path.join(__dirname,'../work/ui-smart');
const day=C.today(),KEY='huayoushu.ledger.v1';
const old={id:'old',type:'expense',amount:2500,date:day,note:'午饭',merchant:'饭店',category:'food',accountId:'bank',receiptId:'ORDER00001',paymentChannel:'微信支付',createdAt:day+'T12:00:00Z'};
const seed=C.validateState({...C.createInitialState(),budgetReady:true,budgets:{day:100000,week:500000,month:2000000},accounts:[{id:'bank',name:'银行卡',type:'asset',currency:'CNY',openingBalance:100000,openingDate:day}],transactions:[old]});
const drafts=[{type:'expense',amount:1200,date:day,time:'12:00',note:'咖啡',merchant:'咖啡店',category:'food',receiptId:'ORDER00002',paymentChannel:'微信支付'}, {...old,time:'11:00'}, {type:'expense',amount:2500,date:day,note:'另一笔',category:'other',paymentChannel:'微信支付'}];
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const browser=await chromium.launch(browserOptions());
 const errors=[];
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!=='http://hys.test')return route.abort();
   if(process.env.HYS_TEST_PACKAGED==='1'&&url.pathname==='/')return route.fulfill({body:fs.readFileSync(path.join(__dirname,'../harmonyos/entry/src/main/resources/rawfile/index.html')),contentType:'text/html'});
   const file=path.resolve(WEB,url.pathname==='/'?'index.html':'.'+url.pathname);
   if(!file.startsWith(path.resolve(WEB)+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(file),contentType:{'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream'});
  });
  await context.addInitScript(({seed,drafts,KEY})=>{
   localStorage.setItem(KEY,JSON.stringify(seed));localStorage.setItem('huayoushu.connection.v1',JSON.stringify({mode:'cloud',base:'https://cloud.invalid',token:'synthetic-token-0123456789'}));
   window.HYS_NATIVE=true;
   const m=window.mock={calls:[],receipts:[],drafts,active:false,pending:null,fail:false,hold:false,held:null,sequence:0};
   const reply=(id,p)=>setTimeout(()=>window.__hysBridgeResolve(id,JSON.stringify(p)),0);
   const status=()=>({supported:true,active:m.active,busy:false,permission:'granted',capturePermission:'granted',pending:!!m.pending});
   const image=()=>({captureId:'image_'+(++m.sequence),imageBase64:'////syntheticjpeg000000000',mime:'image/jpeg'});
   window.HysNative={
    getFloatingStatus:id=>reply(id,status()),startFloatingBall:(id,avatar)=>{m.calls.push({method:'start',avatar});m.active=true;reply(id,status());},stopFloatingBall:id=>{m.active=false;reply(id,status());},
    getFloatingCapture:id=>reply(id,m.pending||{empty:true}),ackFloatingCapture:(id,key)=>{if(m.pending?.captureId===key)m.pending=null;reply(id,{acknowledged:true});},
    pickReceiptImage:id=>{m.calls.push({method:'pick'});reply(id,image());},
    recognizeScreenshot:id=>{throw Error('OCR must not be the image flow');},
    httpJson:(id,url,method,headers,body)=>{
     if(url.endsWith('/api/health'))return reply(id,{status:200,body:JSON.stringify({provider:'dashscope',configured:true,draftProtocolVersion:2,receiptVision:true})});
     assertUrl();function assertUrl(){if(!url.endsWith('/api/receipt'))throw Error('Unexpected request');}
     m.receipts.push(JSON.parse(body));const finish=()=>reply(id,{status:m.fail?503:200,body:JSON.stringify(m.fail?{code:'AI_UNAVAILABLE'}:{receiptProtocolVersion:1,drafts:m.drafts,warnings:[]})});
     if(m.hold)m.held=finish;else finish();
    }
   };
   m.float=()=>{m.pending={...image(),captureId:'float_'+(++m.sequence),source:'floating',createdAt:Date.now()};window.__hysFloatingCaptureReady();};
  },{seed,drafts,KEY});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('http://hys.test');
  await page.locator('[data-action="capture-image"]').first().click();await page.locator('#receipt-form').waitFor();
  assert.equal(await page.locator('[data-receipt-row]').count(),3);
  assert.equal(await page.locator('#receipt-form input[type=checkbox]:checked').count(),1);
  assert.equal(await page.locator('.receipt-row.matched input[type=checkbox]').isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>Object.keys(mock.receipts[0]).sort()),['imageBase64','mime','today']);
  // A bulk selection must work immediately; the extra apply button is optional.
  await page.locator('#receipt-account-options summary').click();
  await page.locator('#receipt-account-all').selectOption('bank');
  assert.equal(await page.locator('[name="account-0"]').inputValue(),'bank');
  // An unselected row with an invalid native input must not swallow submission.
  await page.evaluate(day=>document.querySelector('[name="date-2"]').value=day, C.addDays(day,1));
  await page.screenshot({path:path.join(OUT,'whole-image-review.png'),fullPage:true});
  // Re-dispatching a retained submit handler must never write the batch twice.
  await page.evaluate(()=>{const form=document.querySelector('#receipt-form');form.requestSubmit();form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),2);
  assert.equal(await page.locator('[data-page="home"][aria-current="page"]').count(),1);
  assert.equal(await page.locator('#modal').evaluate(el=>el.open),false);
  assert.equal(await page.evaluate(()=>scrollY),0);
  assert.match(await page.locator('#toast').innerText(),/已保存 1 笔，已返回首页/);
  const state=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);assert.equal(state.transactions[1].transactionTime,day+'T12:00');assert.equal(state.transactions[1].entries.length,2);
  assert.equal(state.transactions[1].entries.reduce((n,e)=>n+e.debit-e.credit,0),0);
  console.log('PASS optional bulk account auto-applies; selected-only atomic save returns home and resists double submit');
  await page.locator('[data-action="navigate"][data-page="settings"]').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.assistant-option img').length===3&&[...document.querySelectorAll('.assistant-option img')].every(img=>img.complete&&img.naturalWidth===256&&img.naturalHeight===256));
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.assistant-option img')].every(img=>img.src.startsWith('data:image/png;base64,'))),true);
  await page.locator('[data-action="assistant-select"][data-value="star"]').click();
  await page.locator('[data-action="float-start"]').click();
  assert.equal(await page.evaluate(()=>mock.calls.findLast(c=>c.method==='start').avatar),'star');
  await page.locator('[data-action="assistant-select"][data-value="star"]').click();
  assert.equal(await page.locator('.pet-wave').count(),1);assert.equal(await page.evaluate(()=>mock.receipts.length),1);
  await page.screenshot({path:path.join(OUT,'assistant-picker.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  console.log('PASS three embedded characters, persistent selection, safe tap feedback and 390px layout');
  await page.locator('[data-action="navigate"][data-page="home"]').first().click();await page.evaluate(()=>mock.float());await page.locator('#receipt-form').waitFor();
  assert.equal(await page.locator('#receipt-form input[type=checkbox]:checked').count(),0);
  assert.equal(await page.locator('.receipt-row.matched').count(),2);
  console.log('PASS floating click automatically recognizes whole image and repeat receipt skips saved orders');
  await page.locator('[data-action="discard-drafts"]').last().click();
  await page.evaluate(()=>{mock.fail=true;});await page.locator('[data-action="capture-image"]').first().click();
  await page.locator('[data-action="receipt-retry"]').waitFor();
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),2);
  await page.evaluate(()=>{mock.fail=false;mock.drafts=[{type:'expense',amount:500,date:'',note:'未知日期',category:'other'}];});
  await page.locator('[data-action="receipt-retry"]').click();await page.locator('#receipt-form').waitFor();
  assert.equal(await page.locator('[name="date-0"]').inputValue(),'');
  await page.locator('#receipt-form button.primary').click();assert.match(await page.locator('#receipt-error').innerText(),/日期/);
  assert.equal(await page.evaluate(()=>document.activeElement.name),'date-0');
  assert.equal(await page.locator('[name="date-0"]').inputValue(),'');
  assert.equal(await page.locator('[name="date-0"]').evaluate(el=>el.closest('details').open),true);
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),2);
  console.log('PASS cloud failure preserves ledger, manual retry, unknown dates stay blank and focus the correction');
  await page.locator('[data-action="discard-drafts"]').last().click();
  // One bad row must roll back the entire selection, preserving inputs for retry.
  await page.evaluate(day=>{mock.drafts=[{type:'expense',amount:700,date:day,note:'有效的一笔',category:'food',receiptId:'ORDER00003',paymentChannel:'微信支付'},{type:'expense',amount:800,date:'',note:'日期不明的一笔',category:'other',receiptId:'ORDER00004',paymentChannel:'微信支付'}];},day);
  await page.locator('[data-action="capture-image"]').first().click();await page.locator('#receipt-form').waitFor();
  await page.locator('#receipt-account-options summary').click();
  await page.locator('#receipt-account-all').selectOption('bank');
  await page.locator('#receipt-form button.primary').click();
  assert.equal(await page.evaluate(()=>document.activeElement.name),'date-1');
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),2);
  assert.equal(await page.locator('[name="account-0"]').inputValue(),'bank');
  await page.locator('[name="date-1"]').fill(C.addDays(day,-1));
  await page.locator('#receipt-form button.primary').click();
  assert.match(await page.locator('#receipt-error').innerText(),/开账日期/);
  assert.equal(await page.evaluate(()=>document.activeElement.name),'date-1');
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),2);
  await page.locator('[name="date-1"]').fill(day);
  // Simulate storage failure without touching any actual ledger or external service.
  await page.evaluate(KEY=>{const original=Storage.prototype.setItem;window.restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(key,value){if(key===KEY)throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);};},KEY);
  await page.locator('#receipt-form button.primary').click();
  assert.match(await page.locator('#receipt-error').innerText(),/保存失败/);
  assert.equal(await page.locator('#modal').evaluate(el=>el.open),true);
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),2);
  await page.evaluate(()=>restoreStorage());
  await page.locator('#receipt-form button.primary').click();
  const saved=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
  assert.equal(saved.transactions.length,4);
  assert.equal(saved.transactions.slice(2).every(t=>t.entries.length===2&&t.entries.reduce((n,e)=>n+e.debit-e.credit,0)===0),true);
  assert.equal(await page.locator('[data-page="home"][aria-current="page"]').count(),1);
  console.log('PASS multi-row date/opening-date/storage failures remain atomic; correction and retry save once then return home');
  // Even tampering with disabled duplicate checkboxes cannot bypass submit-time dedup.
  await page.locator('[data-action="capture-image"]').first().click();await page.locator('#receipt-form').waitFor();
  assert.equal(await page.locator('#receipt-form input[type=checkbox]:checked').count(),0);
  await page.evaluate(()=>{document.querySelectorAll('#receipt-form input[type=checkbox]').forEach(el=>{el.disabled=false;el.checked=true;});});
  await page.locator('#receipt-account-options summary').click();
  await page.locator('#receipt-account-all').selectOption('bank');
  await page.locator('[name="date-1"]').fill(day);
  await page.locator('#receipt-form button.primary').click();
  assert.match(await page.locator('#receipt-error').innerText(),/已经入账/);
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),4);
  console.log('PASS exact ledger matches are rejected again at commit time');
  await page.locator('[data-action="discard-drafts"]').last().click();
  await page.evaluate(day=>{const item={type:'expense',amount:1400,date:day,note:'同批重复测试',category:'other',receiptId:'ORDER00005',paymentChannel:'微信支付'};mock.drafts=[item,{...item}];},day);
  await page.locator('[data-action="capture-image"]').first().click();await page.locator('#receipt-form').waitFor();
  assert.equal(await page.locator('[name="include-1"]').isDisabled(),true);
  await page.evaluate(()=>{const checkbox=document.querySelector('[name="include-1"]');checkbox.disabled=false;checkbox.checked=true;});
  await page.locator('#receipt-account-options summary').click();
  await page.locator('#receipt-account-all').selectOption('bank');
  await page.locator('#receipt-form button.primary').click();
  assert.equal(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)).transactions.length,KEY),5);
  assert.match(await page.locator('#toast').innerText(),/跳过 1 笔已记录交易/);
  assert.equal(await page.locator('[data-page="home"][aria-current="page"]').count(),1);
  console.log('PASS a duplicate within the same selected batch is counted only once');
  // A new user can save all four expenses without creating or selecting an account.
  const empty=C.validateState({...C.createInitialState(),budgetReady:true,budgets:seed.budgets});
  await page.evaluate(({KEY,empty,day})=>{
   const json=JSON.stringify(empty);localStorage.setItem(KEY,json);dispatchEvent(new StorageEvent('storage',{key:KEY,newValue:json}));
   mock.drafts=[500,600,700,800].map((amount,i)=>({type:'expense',amount,date:day,time:'10:0'+i,note:'直接保存测试'+i,category:'food',receiptId:'PENDING0000'+i,paymentChannel:'微信支付',accountHint:'未明确的银行卡'}));
  },{KEY,empty,day});
  await page.locator('[data-action="capture-image"]').first().click();await page.locator('#receipt-form').waitFor();
  assert.equal(await page.locator('#receipt-form input[type=checkbox]:checked').count(),4);
  await page.locator('#receipt-form button.primary').click();
  const pending=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
  assert.equal(pending.transactions.length,4);assert.equal(pending.accounts.length,0);
  assert.equal(pending.transactions.every(t=>t.pendingAccount===true&&t.legacy===false&&!t.accountId&&t.accountHint==='未明确的银行卡'&&t.entries.length===2&&t.entries.reduce((n,e)=>n+e.debit-e.credit,0)===0),true);
  assert.equal(C.getSummary(pending.transactions,'day',day).expense,2600);
  assert.deepEqual(C.getAccountBalances(pending),[]);
  assert.equal(await page.locator('[data-page="home"][aria-current="page"]').count(),1);
  assert.equal(await page.locator('.transaction-meta').filter({hasText:'账户待归属'}).count(),4);
  assert.equal(await page.locator('.transaction-meta').filter({hasText:'历史/导入'}).count(),0);
  assert.match(await page.locator('#toast').innerText(),/已保存 4 笔.*4 笔账户待归属/);
  console.log('PASS zero accounts -> four checked expenses save directly, appear at home as pending accounts, balanced with no invented bank balance');
  // Export and restore via the real JSON UI must preserve pending metadata and IDs.
  await page.locator('[data-action="navigate"][data-page="settings"]').first().click();
  await page.locator('[data-action="export"]').click();
  const backup=await page.locator('#backup-text').inputValue();
  assert.deepEqual(JSON.parse(backup),pending);
  await page.locator('#modal [data-action="close"]').first().click();
  await page.locator('[data-action="import"]').click();
  await page.locator('#import-text').fill(backup);await page.locator('[data-action="validate-import"]').click();
  await page.locator('[data-action="confirm-import"]').click();
  assert.deepEqual(await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY),pending);
  console.log('PASS JSON export/restore keeps all four pending transactions, source details, IDs and balanced entries');
  // Creating a real account alone must not deduct pending expenses from its balance.
  await page.locator('[data-action="navigate"][data-page="accounts"]').first().click();
  assert.match(await page.locator('.main').innerText(),/4 笔交易已保存，账户待归属/);
  await page.locator('[data-action="add-account"]').click();
  await page.locator('#account-name').fill('后补银行卡');await page.locator('#opening-balance').fill('100');
  await page.locator('#account-form button.primary').click();
  let current=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);const bankId=current.accounts[0].id;
  assert.equal(C.getAccountBalances(current)[0].balance,10000);
  await page.locator('[data-action="navigate"][data-page="list"]').first().click();
  await page.locator(`[data-action="edit"][data-id="${pending.transactions[0].id}"]`).click();
  assert.match(await page.locator('#record-help').innerText(),/账户待归属/);
  await page.locator('.journal-details summary').click();
  assert.match(await page.locator('.journal-details').innerText(),/账户待归属/);
  await page.locator('#note').fill('仍待归属也可改备注');await page.locator('#record-form button.primary').click();
  current=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
  assert.equal(current.transactions[0].pendingAccount,true);assert.equal(current.transactions.length,4);
  await page.locator(`[data-action="edit"][data-id="${pending.transactions[0].id}"]`).click();
  await page.locator('#record-account').selectOption(bankId);await page.locator('#record-form button.primary').click();
  current=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
  assert.equal(current.transactions.length,4);assert.equal(current.transactions[0].id,pending.transactions[0].id);
  assert.equal(current.transactions[0].accountId,bankId);assert.notEqual(current.transactions[0].pendingAccount,true);assert.equal(current.transactions[0].legacy,false);
  assert.equal(current.transactions[0].accountHint,'未明确的银行卡');assert.equal(C.getAccountBalances(current)[0].balance,9500);
  assert.equal(C.getSummary(current.transactions,'day',day).expense,2600);
  await page.locator(`[data-action="edit"][data-id="${pending.transactions[0].id}"]`).click();await page.locator('#record-form button.primary').click();
  current=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
  assert.equal(current.transactions.length,4);assert.equal(C.getAccountBalances(current)[0].balance,9500);
  console.log('PASS pending edits remain pending; later account assignment rewrites the same ID once, updates only that real balance, and never doubles the expense');
  assert.deepEqual(errors,[]);await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
