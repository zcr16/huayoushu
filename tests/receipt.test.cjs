'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateReceiptOutput,validateReceiptInput,createServer}=require('../server.cjs');
const R=require('../web/reconcile.js'),C=require('../web/core.js');
const day='2026-10-25';
const draft=(extra={})=>({type:'expense',amountText:'25.00',date:day,time:'12:30',merchant:'午饭店',note:'午饭',category:'food',paymentChannel:'微信支付',receiptId:'',...extra});
const row=(extra={})=>({id:'one',type:'expense',amount:2500,date:day,merchant:'午饭店',paymentChannel:'微信支付',...extra});
test('whole-image output keeps multiple actual transactions, missing date is not today',()=>{
 const x=validateReceiptOutput({drafts:[draft(),draft({date:'',amountText:'12.30'})],warnings:['已排除退款']},day);
 assert.equal(x.drafts.length,2);assert.equal(x.drafts[0].time,'12:30');assert.equal(x.drafts[1].amount,1230);assert.equal(x.drafts[1].date,'');assert.equal(x.drafts[1].dateNeedsConfirmation,true);
});
test('invalid amount/date/time and truncated batches are rejected; masked IDs cannot dedup',()=>{
 for(const d of [draft({date:'2026-02-30'}),draft({time:'25:20'}),draft({amountText:'大约25'}),draft({date:'2026-10-26'})])assert.throws(()=>validateReceiptOutput({drafts:[d],warnings:[]},day));
 assert.throws(()=>validateReceiptOutput({drafts:Array(51).fill(draft()),warnings:[]},day));
 assert.equal(validateReceiptOutput({drafts:[draft({receiptId:'123***456'})],warnings:[]},day).drafts[0].receiptId,undefined);
});
test('image contract rejects non-image and embedded ledger',()=>{
 const body={mime:'image/jpeg',imageBase64:Buffer.from([255,216,255,0,0,0,0,0,0]).toString('base64'),today:day};
 assert.doesNotThrow(()=>validateReceiptInput(body));
 for(const b of [{...body,mime:'text/html'},{...body,transactions:[]},{...body,imageBase64:'not a jpeg file'}])assert.throws(()=>validateReceiptInput(b));
});
test('exact order match across known payment channel is already recorded; different orders remain separate',()=>{
 const old=row({receiptId:'100000001'});
 assert.equal(R.classify([row({receiptId:'100000001'})],[old])[0].status,'matched');
 assert.equal(R.classify([row({receiptId:'100000002'})],[old])[0].status,'new');
 assert.equal(R.classify([row({receiptId:'100000001',paymentChannel:''})],[old])[0].status,'suspected');
 assert.equal(R.classify([row({receiptId:'100000001',amount:2600})],[old])[0].status,'suspected');
});
test('same amount/date only is possible duplicate; creation time is not payment time',()=>{
 const old=row({createdAt:day+'T12:30:00Z'});
 assert.equal(R.classify([row({time:'12:30'})],[old])[0].status,'suspected');
 assert.equal(R.classify([row({time:'12:31'})],[row({transactionTime:day+'T12:30'})])[0].status,'new');
 assert.equal(R.classify([row({date:'2026-10-24'})],[old])[0].status,'new');
});
test('same capture-row dedups, independent screenshots do not claim identity; detects batch repeats',()=>{
 assert.equal(R.classify([row({sourceFingerprint:'cap:0'})],[row({sourceFingerprint:'cap:0'})])[0].status,'matched');
 assert.equal(R.classify([row({sourceFingerprint:'new:0'})],[row({sourceFingerprint:'old:0'})])[0].status,'suspected');
 assert.equal(R.classify([row({receiptId:'100000001'}),row({receiptId:'100000001'})],[])[1].matches[0].scope,'batch');
});
test('receipt metadata survives ledger backup round-trip with balanced entries',()=>{
 const state=C.createInitialState();state.accounts=[{id:'bank',name:'银行卡',type:'asset',currency:'CNY',openingBalance:10000,openingDate:day}];
 state.transactions=[{...row(),accountId:'bank',category:'food',note:'午饭',createdAt:day+'T12:30:00Z',transactionTime:day+'T12:29:10',sourceFingerprint:'cap:0',receiptId:'100000001'}];
 const saved=C.validateState(state);assert.equal(saved.transactions[0].transactionTime,day+'T12:29:10');assert.equal(saved.transactions[0].merchant,'午饭店');assert.equal(saved.transactions[0].entries.length,2);
 assert.deepEqual(C.validateState(JSON.parse(JSON.stringify(saved))),saved);
 state.transactions[0].transactionTime='2026-10-24T12:29';assert.throws(()=>C.validateState(state));
});
test('vision route shares auth/rate limits, never sends history, uses separate vision model',async t=>{
 const calls=[],token='synthetic-test-token-123456';
 const server=createServer({env:{HYS_AI_PROVIDER:'dashscope',HYS_AI_TOKEN:token,DASHSCOPE_API_KEY:'synthetic-key',HYS_VISION_MODEL:'qwen3-vl-flash'},fetchImpl:async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({drafts:[draft(),draft({amountText:'12.00'})],warnings:[]})}}]});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal((await(await fetch(base+'/api/health')).json()).receiptVision,true);
 const body={mime:'image/jpeg',imageBase64:Buffer.from([255,216,255,0,0,0,0,0,0]).toString('base64'),today:day};
 const send=auth=>fetch(base+'/api/receipt',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(body)});
 assert.equal((await send('wrong')).status,401);assert.equal(calls.length,0);
 const response=await send(token);assert.equal(response.status,200);assert.equal((await response.json()).drafts.length,2);
 assert.equal(calls[0].model,'qwen3-vl-flash');assert.equal(calls[0].messages[1].content[1].type,'image_url');assert.ok(!JSON.stringify(calls[0]).includes('transactions'));
});
