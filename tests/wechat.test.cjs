'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../web/wechat.js');
const C = require('../web/core.js');
const fs = require('node:fs');
const vm = require('node:vm');
const header = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
const csvCell = value => '"' + String(value).replace(/"/g, '""') + '"';
const line = values => values.map(csvCell).join(',');
const row = changes => Object.assign({ '交易时间': '2026-10-22 12:30:10', '交易类型': '商户消费', '交易对方': '测试餐馆', '商品': '午饭', '收/支': '支出', '金额(元)': '¥28.50', '支付方式': '零钱', '当前状态': '支付成功', '交易单号': '4200000000202610220000000001', '商户单号': 'synthetic-order-1', '备注': '/' }, changes);
const source = (items, headers = header) => '\uFEFF微信支付账单明细\r\n微信昵称：[合成测试]\r\n说明：以下均为虚构测试数据\r\n\r\n' + line(headers) + '\r\n' + items.map(item => line(headers.map(key => item[key] || ''))).join('\r\n') + '\r\n';
const parse = (items, extra = {}, headers = header) => W.parseWechatCsv(source(items, headers), { today: '2026-10-23', createdAt: '2026-10-23T04:00:00.000Z', ...extra });

test('CSV handles BOM, CRLF, commas, escaped quotes and multiline cells', () => {
  assert.deepEqual(W.parseCsv('\uFEFFa,b\r\n"咖啡,茶","他说""好""\r\n下一行"\r\n'), [['a', 'b'], ['咖啡,茶', '他说"好"\n下一行']]);
  const rows = W.parseCsv('a,b\r\n"c\nd",e\r\nf,g');
  assert.equal(rows[2].line, 4);
  assert.deepEqual(W.parseCsv('a,b,'), [['a', 'b', '']]);
  assert.throws(() => W.parseCsv('"unclosed'), /未闭合/);
  assert.throws(() => W.parseCsv('"a"oops,b'), /异常/);
});

test('finds personal bill header after instructions and returns core-compatible preview only', () => {
  const result = parse([row()]);
  assert.equal(result.transactions.length, 1);
  const item = result.transactions[0];
  assert.equal(item.amount, 2850);
  assert.equal(item.date, '2026-10-22');
  assert.equal(item.category, 'food');
  assert.equal(item.type, 'expense');
  assert.match(item.id, /^wx-[a-f0-9]{32}$/);
  assert.ok(!item.id.includes('420000'));
  assert.equal(item.note, '午饭 · 测试餐馆');
  assert.deepEqual(C.validateState({ ...C.createInitialState(), transactions: result.transactions }).transactions, result.transactions);
  assert.equal(result.warnings.length, 0);
});

test('column order and common header variants are accepted', () => {
  const headers = ['交易单号', '金额（元）', '收入/支出', '交易状态', '交易日期', '商品名称', '交易对方'];
  const result = parse([{ '交易单号': 'alias-order-1', '金额（元）': '￥1,234.56', '收入/支出': '支出', '交易状态': '交易成功', '交易日期': '2024/2/29 8:05:09', '商品名称': '图书', '交易对方': '测试书店' }], {}, headers);
  assert.equal(result.transactions[0].amount, 123456);
  assert.equal(result.transactions[0].date, '2024-02-29');
  assert.equal(result.transactions[0].category, 'study');
});

test('money is exact cents and malformed, signed or over-precise amounts are review warnings', () => {
  const amounts = ['0.01', '0.10', '0', '-1.00', '+1', '1.001', '1e3', '12,34.00', '美元10'];
  const result = parse(amounts.map((amount, i) => row({ '金额(元)': amount, '交易单号': 'money-' + i })));
  assert.deepEqual(result.transactions.map(t => t.amount), [1, 10]);
  assert.equal(result.warnings.length, 7);
});

test('deduplicates both existing ledger and repeated input without mutating either', () => {
  const first = parse([row()]).transactions;
  const snapshot = JSON.stringify(first);
  const second = parse([row(), row()], { existingTransactions: first });
  assert.equal(second.transactions.length, 0);
  assert.equal(second.duplicates.length, 2);
  assert.equal(JSON.stringify(first), snapshot);
  const within = parse([row(), row()]);
  assert.equal(within.transactions.length, 1);
  assert.equal(within.duplicates.length, 1);
});

test('same order with conflicting amounts excludes all new copies instead of selecting one', () => {
  const result = parse([row(), row({ '金额(元)': '100.00' }), row()]);
  assert.equal(result.transactions.length, 0);
  assert.ok(result.warnings.some(w => w.message.includes('冲突')));
  const existing = parse([row()]).transactions;
  const changed = parse([row({ '金额(元)': '100.00' })], { existingTransactions: existing });
  assert.equal(changed.transactions.length, 0);
  assert.equal(changed.duplicates.length, 1);
  assert.equal(existing[0].amount, 2850);
});

test('full refunds, closed payments and non-bookkeeping balances are explicitly skipped', () => {
  const result = parse([
    row({ '交易单号': 'refunded', '当前状态': '已全额退款' }),
    row({ '交易单号': 'closed', '当前状态': '已关闭' }),
    row({ '交易单号': 'transfer', '收/支': '不计收支' }),
    row({ '交易单号': 'topup', '交易类型': '零钱充值' }),
    row({ '交易单号': 'withdraw', '交易类型': '零钱提现' })
  ]);
  assert.equal(result.transactions.length, 0);
  assert.equal(result.skipped.length, 5);
  assert.equal(result.warnings.length, 0);
});

test('partial or ambiguous refunds and fees are warnings, never automatic expenses or income', () => {
  const result = parse([
    row({ '交易单号': 'partial', '当前状态': '已退款(¥5.00)' }),
    row({ '交易单号': 'refund', '当前状态': '退款成功', '收/支': '收入' }),
    row({ '交易单号': 'returned', '当前状态': '已退还', '收/支': '不计收支' }),
    row({ '交易单号': 'fee', '商品': '提现手续费' })
  ]);
  assert.equal(result.transactions.length, 0);
  assert.equal(result.warnings.length, 4);
});

test('refund for previously imported payment asks for manual correction, never deletes history', () => {
  const existing = parse([row()]).transactions;
  const result = parse([row({ '当前状态': '已全额退款' })], { existingTransactions: existing });
  assert.equal(result.transactions.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.warnings[0].message, /原消费已在账本/);
  assert.equal(existing[0].amount, 2850);
});

test('payment and refund in one file are linked regardless of ordering', () => {
  for (const items of [[row(), row({ '当前状态': '已全额退款' })], [row({ '当前状态': '已全额退款' }), row()]]) {
    const result = parse(items);
    assert.equal(result.transactions.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.warnings.some(w => w.message.includes('同一交易单号')));
  }
});

test('income, pending payment, missing order and unknown direction are distinguished', () => {
  const result = parse([
    row({ '交易单号': 'salary', '收/支': '收入', '当前状态': '已到账', '商品': '工资', '交易对方': '合成公司', '金额(元)': '5000' }),
    row({ '交易单号': 'pending', '当前状态': '等待对方收钱' }),
    row({ '交易单号': '/' }),
    row({ '交易单号': 'unknown', '收/支': '' })
  ]);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].type, 'income');
  assert.equal(result.transactions[0].category, 'other');
  assert.equal(result.transactions[0].amount, 500000);
  assert.equal(result.warnings.length, 3);
});

test('invalid leap dates, future dates and invalid time do not become valid records', () => {
  const dates = ['2026-02-29 12:30:00', '2026-10-24 12:30:00', '2026-10-22 24:00:00', '2026-10-22 12:61:00'];
  const result = parse(dates.map((date, i) => row({ '交易时间': date, '交易单号': 'date-' + i })));
  assert.equal(result.transactions.length, 0);
  assert.equal(result.warnings.length, 4);
});

test('quoted notes stay text, are length bounded, and do not expose original order identifiers', () => {
  const result = parse([row({ '商品': '咖啡,"加奶"\n外带', '备注': '<script>alert(1)</script>' + '好'.repeat(250) })]);
  assert.equal(result.transactions[0].amount, 2850);
  assert.ok(result.transactions[0].note.length <= 200);
  assert.ok(result.transactions[0].note.startsWith('咖啡,"加奶"\n外带'));
  assert.equal(result.transactions[0].order, undefined);
  assert.ok(result.warnings.some(w => w.message.includes('备注较长')));
});

test('rejects missing or duplicate headers and binary spreadsheet payloads', () => {
  assert.throws(() => W.parseWechatCsv('a,b\n1,2'), /未找到/);
  assert.throws(() => W.parseWechatCsv(source([row()], [...header, '金额'])) , /重复/);
  assert.throws(() => W.parseCsv('PK\x03\x04binary'), /不是 CSV/);
  assert.throws(() => W.parseCsv('a\u0000b'), /编码/);
  assert.throws(() => W.parseCsv('a'.repeat(W.MAX_TEXT_LENGTH + 1)), /过大/);
});

test('several thousand synthetic rows remain precise and duplicate-safe', () => {
  const items = Array.from({ length: 3000 }, (_, i) => row({ '交易单号': 'synthetic-bulk-' + i, '金额(元)': '0.01' }));
  const result = parse(items);
  assert.equal(result.transactions.length, 3000);
  assert.equal(result.transactions.reduce((sum, t) => sum + t.amount, 0), 3000);
  assert.equal(new Set(result.transactions.map(t => t.id)).size, 3000);
  assert.equal(parse(items, { existingTransactions: result.transactions }).transactions.length, 0);
});

test('module also exposes browser API without node, file, network or storage access', () => {
  const context = vm.createContext({ LedgerCore: C });
  vm.runInContext(fs.readFileSync(require.resolve('../web/wechat.js'), 'utf8'), context);
  assert.equal(typeof context.WechatImport.parseWechatCsv, 'function');
  assert.equal(context.WechatImport.stableId('sample'), W.stableId('sample'));
  assert.equal(Object.isFrozen(context.WechatImport), true);
});
