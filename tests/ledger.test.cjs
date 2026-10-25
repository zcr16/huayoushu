'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../web/core.js');

const DATE = '2026-10-23';
function account(id, type = 'asset', openingBalance = 0, openingDate = '2026-10-01') {
  return { id, name: id, type, openingBalance, openingDate };
}
function tx(id, type, amount, accountId, targetAccountId) {
  return { id, type, amount, accountId, ...(targetAccountId ? { targetAccountId } : {}), category: 'food', sub: 'meal', date: DATE, note: id, createdAt: DATE + 'T04:00:00.000Z' };
}
function book(transactions = [], accounts = [account('bank', 'asset', 100000), account('wallet'), account('credit', 'liability')]) {
  return { ...C.createInitialState(), accounts, transactions, budgets: { day: 10000, week: 40000, month: 100000 }, budgetReady: true };
}
function balances(state, asOf = DATE) {
  return Object.fromEntries(C.getAccountBalances(state, asOf).map(a => [a.id, a.balance]));
}
function assertBalanced(entries) {
  assert.ok(entries.length >= 2);
  let debit = 0, credit = 0;
  for (const e of entries) {
    assert.ok(Number.isSafeInteger(e.debit) && Number.isSafeInteger(e.credit));
    assert.ok((e.debit > 0 && e.credit === 0) || (e.credit > 0 && e.debit === 0));
    debit += e.debit;
    credit += e.credit;
  }
  assert.equal(debit, credit);
}

test('credit purchase and repayment count consumption exactly once', () => {
  const state = C.validateState(book([tx('purchase', 'expense', 20000, 'credit'), tx('repay', 'repayment', 20000, 'bank', 'credit')]));
  assert.deepEqual(balances(state), { bank: 80000, wallet: 0, credit: 0 });
  const summary = C.getSummary(state.transactions, 'month', DATE);
  assert.equal(summary.expense, 20000);
  assert.equal(summary.income, 0);
  assert.equal(summary.count, 2);
  assert.equal(C.getBudgetStatuses(state, DATE).month.spent, 20000);
  assert.equal(C.getBreakdown(state.transactions, 'month', DATE).count, 1);
  for (const row of C.getJournal(state)) assertBalanced(row.entries);
});

test('internal transfer preserves total assets and all spending reports', () => {
  const state = C.validateState(book([tx('move', 'transfer', 50000, 'bank', 'wallet')]));
  assert.deepEqual(balances(state), { bank: 50000, wallet: 50000, credit: 0 });
  const summary = C.getSummary(state.transactions, 'month', DATE);
  assert.equal(summary.expense, 0);
  assert.equal(summary.income, 0);
  assert.equal(C.getBreakdown(state.transactions, 'month', DATE).merchants.length, 0);
  assert.equal(C.getBudgetStatuses(state, DATE).month.spent, 0);
});

test('payment channel does not change the actual funding account', () => {
  const state = C.validateState(book([{ ...tx('lunch', 'expense', 2500, 'bank'), paymentChannel: '微信' }]));
  assert.deepEqual(balances(state), { bank: 97500, wallet: 0, credit: 0 });
  assert.equal(state.transactions[0].paymentChannel, '微信');
  assert.deepEqual(state.transactions[0].entries, [
    { accountId: 'sys:expense:food', accountType: 'expense', debit: 2500, credit: 0 },
    { accountId: 'bank', accountType: 'asset', debit: 0, credit: 2500 }
  ]);
});

test('opening balances are equity entries, never income or spending', () => {
  const state = book([], [account('bank', 'asset', 500000), account('credit', 'liability', 20000)]);
  const journal = C.getJournal(state);
  assert.equal(journal.length, 2);
  for (const row of journal) {
    assert.equal(row.type, 'opening');
    assertBalanced(row.entries);
    assert.ok(row.entries.some(e => e.accountType === 'equity'));
  }
  assert.equal(C.getSummary(state.transactions, 'month', DATE).income, 0);
  assert.deepEqual(balances(state), { bank: 500000, credit: 20000 });
});

test('V1 migration preserves history and budgets without inventing account balances', () => {
  const original = { version: 1, transactions: [tx('old-lunch', 'expense', 2500), tx('old-pay', 'income', 800000)], budgets: { day: 5000, week: 30000, month: 100000 }, budgetReady: true };
  const snapshot = JSON.stringify(original);
  const migrated = C.validateState(original);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.accounts, []);
  assert.deepEqual(migrated.budgets, original.budgets);
  assert.ok(migrated.transactions.every(t => t.legacy));
  assert.equal(C.getSummary(migrated.transactions, 'month', DATE).expense, 2500);
  assert.equal(JSON.stringify(original), snapshot);
  migrated.accounts.push(account('bank', 'asset', 500000, DATE));
  assert.deepEqual(balances(migrated), { bank: 500000 });
  for (const t of migrated.transactions) assertBalanced(t.entries);
});

test('normalization is stable and V2 JSON backup round-trips exactly', () => {
  const normalized = C.validateState(book([
    { ...tx('lunch', 'expense', 2500, 'bank'), source: 'screenshot', externalId: 'wx-123' },
    tx('transfer', 'transfer', 10000, 'bank', 'wallet'),
    tx('salary', 'income', 800000, 'bank')
  ]));
  assert.deepEqual(C.validateState(JSON.parse(JSON.stringify(normalized))), normalized);
  assert.equal(normalized.transactions[0].source, 'screenshot');
  assert.equal(normalized.transactions[0].externalId, 'wx-123');
});

test('editing or deleting a transaction rebuilds every affected balance', () => {
  const first = C.validateState(book([tx('lunch', 'expense', 2500, 'bank')]));
  const edited = C.validateState({ ...first, transactions: [{ ...first.transactions[0], amount: 4000, accountId: 'credit' }] });
  assert.deepEqual(balances(first), { bank: 97500, wallet: 0, credit: 0 });
  assert.deepEqual(balances(edited), { bank: 100000, wallet: 0, credit: 4000 });
  assert.ok(edited.transactions[0].entries.every(e => e.debit === 4000 || e.credit === 4000));
  const deleted = C.validateState({ ...edited, transactions: [] });
  assert.deepEqual(balances(deleted), { bank: 100000, wallet: 0, credit: 0 });
});

test('invalid or deleted funding accounts never silently become legacy', () => {
  for (const id of ['missing', 123, {}, 'sys:unassigned']) {
    assert.throws(() => C.validateState(book([tx('lunch', 'expense', 2500, id)])), /账户/);
  }
  const normalized = C.validateState(book([tx('lunch', 'expense', 2500, 'bank')]));
  assert.throws(() => C.validateState({ ...normalized, accounts: normalized.accounts.filter(a => a.id !== 'bank') }), /不存在/);
  assert.equal(C.validateState(book([{ ...tx('lunch', 'expense', 2500, 'bank'), legacy: true }])).transactions[0].legacy, false);
});

test('account restrictions prevent misclassifying repayments as income or transfers', () => {
  const invalid = [
    tx('bad', 'income', 100, 'credit'),
    tx('bad', 'transfer', 100, 'bank', 'bank'),
    tx('bad', 'transfer', 100, 'bank', 'credit'),
    tx('bad', 'transfer', 100, 'credit', 'bank'),
    tx('bad', 'repayment', 100, 'bank', 'wallet'),
    tx('bad', 'repayment', 100, 'credit', 'bank'),
    tx('bad', 'repayment', 100, 'bank'),
    tx('bad', 'transfer', 100),
    tx('bad', 'expense', 100, 'bank', 'wallet')
  ];
  for (const t of invalid) assert.throws(() => C.validateState(book([t])), JSON.stringify(t));
});

test('transactions before account opening are rejected for both ends of a movement', () => {
  const accounts = [account('bank', 'asset', 100000, DATE), account('wallet', 'asset', 0, DATE)];
  assert.throws(() => C.validateState(book([{ ...tx('old', 'expense', 100, 'bank'), date: '2026-10-22' }], accounts)), /开账日期/);
  assert.throws(() => C.validateState(book([tx('move', 'transfer', 100, 'bank', 'wallet')], [account('bank'), account('wallet', 'asset', 0, '2026-10-24')])), /开账日期/);
  assert.doesNotThrow(() => C.validateState(book([tx('same-day', 'expense', 100, 'bank')], accounts)));
});

test('as-of account balances exclude later activity and unopened accounts', () => {
  const state = book([
    { ...tx('before', 'expense', 100, 'bank'), date: '2026-10-22' },
    { ...tx('after', 'expense', 200, 'bank'), date: '2026-10-24' }
  ]);
  assert.deepEqual(balances(state, DATE), { bank: 99900, wallet: 0, credit: 0 });
  assert.deepEqual(balances(state, '2026-09-30'), { bank: 0, wallet: 0, credit: 0 });
  assert.ok(C.getAccountBalances(state, '2026-09-30').every(a => !a.opened));
});

test('invalid accounts, mixed currencies and non-integer money are rejected atomically', () => {
  const invalid = [
    account('bank', 'asset', -1), account('bank', 'asset', 1.5), account('bank', 'asset', C.MAX_AMOUNT + 1),
    account('bank', 'unknown'), { ...account('bank'), currency: 'USD' },
    { ...account('bank'), name: ' ' }, { ...account('bank'), name: 'x'.repeat(61) },
    account('sys:reserved'), account('bank', 'asset', 0, '2099-01-01')
  ];
  for (const a of invalid) assert.throws(() => C.validateState(book([], [a])), JSON.stringify(a));
  assert.throws(() => C.validateState(book([], [account('bank'), account('bank')])));
  assert.throws(() => C.validateState({ ...book(), currency: 'USD' }));
  assert.throws(() => C.validateState(book([{ ...tx('usd', 'expense', 100, 'bank'), currency: 'USD' }])));
  const state = book([tx('good', 'expense', 100, 'bank'), tx('bad', 'expense', 1.5, 'bank')]);
  const before = JSON.stringify(state);
  assert.throws(() => C.validateState(state));
  assert.equal(JSON.stringify(state), before);
});

test('large integer-cent transactions preserve exact balancing without float drift', () => {
  const state = C.validateState(book([tx('large', 'income', C.MAX_AMOUNT, 'bank'), tx('cent', 'expense', 1, 'bank')]));
  assert.equal(balances(state).bank, 100000 + C.MAX_AMOUNT - 1);
  for (const row of C.getJournal(state)) assertBalanced(row.entries);
});

test('derived journal is rebuilt rather than trusting backup-provided posting amounts', () => {
  const state = book([{ ...tx('lunch', 'expense', 2500, 'bank'), entries: [{ accountId: 'bank', accountType: 'asset', debit: 999999, credit: 0 }] }]);
  const normalized = C.validateState(state);
  assertBalanced(normalized.transactions[0].entries);
  assert.equal(balances(normalized).bank, 97500);
});

test('four selected receipts save with zero funding accounts as explicit pending records', () => {
  const records = [
    { ...tx('rice', 'expense', 2500), pendingAccount: true, accountHint: '微信支付' },
    { ...tx('tea', 'expense', 1250), pendingAccount: true },
    { ...tx('metro', 'expense', 600), pendingAccount: true },
    { ...tx('income', 'income', 10000), pendingAccount: true, accountHint: '收款方式不明' }
  ];
  const state = C.validateState(book(records, []));
  assert.equal(state.transactions.length, 4);
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(balances(state), {});
  assert.equal(C.getSummary(state.transactions, 'month', DATE).expense, 4350);
  assert.equal(C.getSummary(state.transactions, 'month', DATE).income, 10000);
  assert.equal(C.getBudgetStatuses(state, DATE).month.spent, 4350);
  for (const row of C.getJournal(state)) {
    assert.equal(row.pendingAccount, true);
    assert.equal(row.legacy, false);
    assertBalanced(row.entries);
    assert.ok(row.entries.some(entry => entry.accountId === 'sys:unassigned'));
  }
  assert.equal(C.getJournal(state).find(row => row.id === 'rice').accountHint, '微信支付');
});

test('pending income and expenses preserve every real balance including before account opening', () => {
  const records = [
    { ...tx('spend', 'expense', 2500), pendingAccount: true },
    { ...tx('receive', 'income', 10000), pendingAccount: true }
  ];
  const accounts = [account('bank', 'asset', 50000, DATE), account('credit', 'liability', 20000, DATE)];
  const normalized = C.validateState(book(records.map(t => ({ ...t, date: '2026-10-22' })), accounts));
  assert.deepEqual(balances(normalized), { bank: 50000, credit: 20000 });
  assert.ok(normalized.transactions.every(t => !t.accountId && t.pendingAccount && !t.legacy));
});

test('binding a pending receipt replaces its suspense entry once without duplicating spending', () => {
  const pending = C.validateState(book([{ ...tx('receipt', 'expense', 2500), pendingAccount: true,
    accountHint: '招行卡', source: 'vision', receiptId: 'order-1', sourceFingerprint: 'image-row-1' }]));
  const old = pending.transactions[0];
  const { pendingAccount, ...assigned } = old;
  assigned.accountId = 'bank';
  const edited = C.validateState({ ...pending, transactions: [assigned] });
  assert.equal(edited.transactions.length, 1);
  assert.equal(edited.transactions[0].id, old.id);
  assert.equal(edited.transactions[0].pendingAccount, undefined);
  assert.equal(edited.transactions[0].legacy, false);
  assert.equal(edited.transactions[0].accountHint, '招行卡');
  assert.equal(edited.transactions[0].receiptId, 'order-1');
  assert.equal(edited.transactions[0].sourceFingerprint, 'image-row-1');
  assert.deepEqual(balances(pending), { bank: 100000, wallet: 0, credit: 0 });
  assert.deepEqual(balances(edited), { bank: 97500, wallet: 0, credit: 0 });
  assert.equal(C.getSummary(pending.transactions, 'month', DATE).expense, C.getSummary(edited.transactions, 'month', DATE).expense);
  assert.ok(!edited.transactions[0].entries.some(entry => entry.accountId === 'sys:unassigned'));
  assertBalanced(edited.transactions[0].entries);
  assert.deepEqual(balances(C.validateState({ ...edited, transactions: [] })), { bank: 100000, wallet: 0, credit: 0 });
});

test('pending marker cannot conceal account references or movements and must be boolean', () => {
  const invalid = [
    { ...tx('bad', 'expense', 100, 'bank'), pendingAccount: true },
    { ...tx('bad', 'expense', 100), pendingAccount: true, targetAccountId: 'wallet' },
    { ...tx('bad', 'expense', 100), pendingAccount: true, targetAccountId: 0 },
    { ...tx('bad', 'transfer', 100), pendingAccount: true },
    { ...tx('bad', 'repayment', 100), pendingAccount: true },
    ...['true', 1, null, {}].map(value => ({ ...tx('bad', 'expense', 100), pendingAccount: value }))
  ];
  for (const record of invalid) {
    assert.throws(() => C.validateState(book([record])), /账户待归属/);
    assert.throws(() => C.buildEntries(record, book().accounts), /账户待归属/);
  }
  for (const hint of [201, null, {}, 'a'.repeat(201)]) {
    assert.throws(() => C.validateState(book([{ ...tx('bad-hint', 'expense', 100), pendingAccount: true, accountHint: hint }])), /accountHint/);
  }
});

test('pending metadata survives normalized JSON backup round-trip and unmarked history stays legacy', () => {
  const pending = C.validateState(book([{ ...tx('new-receipt', 'income', 1000), pendingAccount: true,
    accountHint: 'a'.repeat(200), transactionTime: DATE + 'T12:30:00', source: 'vision',
    receiptId: 'receipt-2', merchant: '商家', paymentChannel: '微信', sourceFingerprint: 'image-2',
    entries: [{ accountId: 'bank', accountType: 'asset', debit: 999999, credit: 0 }] }]));
  assert.deepEqual(C.validateState(JSON.parse(JSON.stringify(pending))), pending);
  assertBalanced(pending.transactions[0].entries);
  assert.ok(pending.transactions[0].entries.some(entry => entry.accountId === 'sys:unassigned'));
  const oldV2 = C.validateState(book([{ ...tx('old', 'expense', 100), accountHint: '旧版导入线索' }]));
  assert.equal(oldV2.transactions[0].legacy, true);
  assert.equal(oldV2.transactions[0].pendingAccount, undefined);
  const oldV1 = C.validateState({ ...book([tx('v1', 'expense', 100)]), version: 1 });
  assert.equal(oldV1.transactions[0].legacy, true);
  assert.equal(oldV1.transactions[0].pendingAccount, undefined);
  assert.throws(() => C.validateState({ ...book([{ ...tx('bad-v1', 'expense', 100), pendingAccount: true }]), version: 1 }), /旧版账本/);
});
