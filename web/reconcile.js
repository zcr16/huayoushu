(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.LedgerReconcile=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const clean=s=>String(s||'').trim().toLowerCase().replace(/\s+/g,'');
  const channel=t=>{const s=clean(t.paymentChannel||t.channelHint);return /微信|wechat|weixin/.test(s)?'wechat':/支付宝|alipay/.test(s)?'alipay':s;};
  const order=t=>clean(t.receiptId||t.externalId);
  const time=t=>t.transactionTime?String(t.transactionTime).slice(11):String(t.time||'');
  function compare(a,b){
    const aid=order(a),bid=order(b),ac=channel(a),bc=channel(b);
    if(aid&&bid&&aid!==bid)return null;
    if(ac&&bc&&ac!==bc)return null;
    if(aid&&aid===bid&&ac&&ac===bc&&(a.type!==b.type||a.amount!==b.amount||(a.date&&b.date&&a.date!==b.date)))return {status:'suspected',reason:'交易单号相同，但金额、日期或类型有差异，请核对'};
    if(a.type!==b.type||a.amount!==b.amount)return null;
    if(a.date&&b.date&&a.date!==b.date)return null;
    if(aid&&bid&&aid===bid&&ac&&ac===bc)return {status:'matched',reason:'完整交易单号与支付渠道一致'};
    if(a.sourceFingerprint&&a.sourceFingerprint===b.sourceFingerprint)return {status:'matched',reason:'同一次图片识别的该笔交易已保存'};
    if(!a.date||a.date!==b.date)return null;
    const at=time(a),bt=time(b),am=clean(a.merchant),bm=clean(b.merchant);
    if(at&&bt&&at!==bt&&!(at.length!==bt.length&&at.slice(0,5)===bt.slice(0,5)))return null;
    if(am&&bm&&am!==bm)return null;
    return {status:'suspected',reason:at&&bt?'日期、金额和交易时间接近，请核对是否同一笔':am&&bm?'同日同商户同金额，请核对是否同一笔':'同日同金额，仅作为重复线索'};
  }
  function classify(drafts,ledger){
    return drafts.map((d,index)=>{
      const matches=[];
      ledger.forEach(t=>{const hit=compare(d,t);if(hit)matches.push({...hit,scope:'ledger',id:t.id,note:t.note,date:t.date,time:time(t)});});
      drafts.slice(0,index).forEach((t,i)=>{const hit=compare(d,t);if(hit)matches.push({...hit,scope:'batch',index:i,note:t.note,date:t.date,time:time(t)});});
      const exact=matches.find(m=>m.status==='matched');
      return {index,status:exact?'matched':matches.length?'suspected':'new',reason:exact?.reason||matches[0]?.reason||'未发现已有记录',matches};
    });
  }
  return {classify,compare};
});
