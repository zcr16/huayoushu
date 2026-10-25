'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const core = require('../web/core.js');

function transaction(overrides = {}) {
  return Object.assign({ id: 'record-1', type: 'expense', amount: 1500, category: 'food', date: '2026-10-23', note: '午餐', createdAt: '2026-10-23T04:00:00.000Z' }, overrides);
}
function stateWith(items = [transaction()]) {
  const state = core.createInitialState();
  state.transactions = items;
  return state;
}

test('money parsing uses exact integer cents', () => {
  assert.equal(core.parseAmount('0.01'), 1);
  assert.equal(core.parseAmount('12.30'), 1230);
  assert.equal(core.parseAmount(' 100.5 '), 10050);
  assert.equal(core.parseAmount(1.1), 110);
  assert.equal(core.parseAmount('999999999.99'), core.MAX_AMOUNT);
  assert.equal(core.parseAmount('0.1') + core.parseAmount('0.2'), 30);
  assert.equal(core.formatAmount(12345678), '123,456.78');
  assert.equal(core.formatAmount(-1), '-0.01');
  assert.equal(core.formatAmount(12345678, { grouping: false }), '123456.78');
});

test('invalid or ambiguous money is rejected', () => {
  for (const invalid of ['0', '0.00', '-1', '+1', '1.001', '1.', '.5', '01', '1e3', 'NaN', 'Infinity', '1,000', '1000000000', '', null, undefined, {}, true, Infinity, NaN]) {
    assert.throws(() => core.parseAmount(invalid), String(invalid));
  }
  assert.throws(() => core.formatAmount(1.5));
});

test('calendar validation includes leap centuries and malformed dates', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-10-23', '0001-01-01']) assert.equal(core.isValidDate(date), true, date);
  for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-1', '0000-01-01', '2026-10-23T00:00:00Z', null]) assert.equal(core.isValidDate(date), false, date);
});

test('natural weeks start Monday and cross year and month boundaries', () => {
  assert.deepEqual(core.getPeriodRange('week', '2026-01-01'), { period: 'week', start: '2025-12-29', end: '2026-01-04', label: '2025.12.29 — 2026.01.04' });
  assert.equal(core.getPeriodRange('week', '2026-01-04').start, '2025-12-29');
  assert.equal(core.getPeriodRange('week', '2026-01-05').start, '2026-01-05');
  assert.equal(core.getPeriodRange('week', '2026-11-01').start, '2026-10-26');
  assert.equal(core.getPeriodRange('month', '2024-02-20').end, '2024-02-29');
  assert.equal(core.getPeriodRange('month', '2100-02-20').end, '2100-02-28');
});

test('period navigation clamps short months and handles leap transitions', () => {
  assert.equal(core.shiftPeriod('day', '2024-02-28', 1), '2024-02-29');
  assert.equal(core.shiftPeriod('day', '2026-12-31', 1), '2027-01-01');
  assert.equal(core.shiftPeriod('week', '2026-01-01', -1), '2025-12-25');
  assert.equal(core.shiftPeriod('month', '2026-01-31', 1), '2026-02-28');
  assert.equal(core.shiftPeriod('month', '2024-03-31', -1), '2024-02-29');
  assert.equal(core.shiftPeriod('month', '2026-12-31', 1), '2027-01-31');
  assert.throws(() => core.getPeriodRange('year', '2026-01-01'));
  assert.throws(() => core.shiftPeriod('day', '2026-01-01', 0.5));
});

test('today uses the local calendar, including positive/negative offsets and DST', () => {
  const script = `const c=require(${JSON.stringify(require.resolve('../web/core.js'))}); process.stdout.write(JSON.stringify([c.today(new Date('2026-10-22T16:30:00Z')), c.addDays('2026-03-08',1),c.addDays('2026-11-01',1)]));`;
  const east = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Asia/Shanghai' }, encoding: 'utf8' }));
  const west = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }));
  assert.deepEqual(east, ['2026-10-23', '2026-03-09', '2026-11-02']);
  assert.deepEqual(west, ['2026-10-22', '2026-03-09', '2026-11-02']);
});

test('summary includes boundary dates, excludes outside, separates income and fills zero days', () => {
  const items = [
    transaction({ id: 'a', amount: 101, date: '2025-12-29' }),
    transaction({ id: 'b', amount: 209, category: 'transport', date: '2026-01-04' }),
    transaction({ id: 'c', type: 'income', amount: 5000, date: '2026-01-01' }),
    transaction({ id: 'd', amount: 9999, date: '2025-12-28' }),
    transaction({ id: 'e', amount: 9999, date: '2026-01-05' })
  ];
  const summary = core.getSummary(items, 'week', '2026-01-01');
  assert.equal(summary.expense, 310);
  assert.equal(summary.income, 5000);
  assert.equal(summary.balance, 4690);
  assert.equal(summary.count, 3);
  assert.equal(summary.trend.length, 7);
  assert.equal(summary.trend[1].expense, 0);
  assert.equal(summary.trend[0].expense, 101);
  assert.equal(summary.trend[6].expense, 209);
  assert.equal(summary.categories[0].id, 'transport');
  assert.equal(summary.categories[0].amount, 209);
  assert.equal(summary.categories.find(c => c.id === 'food').amount, 101);
  assert.equal(summary.categories.reduce((sum, c) => sum + c.amount, 0), summary.expense);
  assert.equal(core.getSummary([], 'month', '2024-02-01').trend.length, 29);
  assert.equal(core.getSummary([], 'day', '2026-10-23').categories.every(c => c.share === 0), true);
});

test('budget threshold distinguishes unset, 80 percent, reached and exceeded', () => {
  assert.equal(core.getBudgetStatus(100, 0).level, 'unset');
  assert.equal(core.getBudgetStatus(7999, 10000).level, 'safe');
  assert.equal(core.getBudgetStatus(8000, 10000).level, 'warning');
  assert.equal(core.getBudgetStatus(9999, 10000).level, 'warning');
  assert.equal(core.getBudgetStatus(10000, 10000).level, 'reached');
  assert.equal(core.getBudgetStatus(10001, 10000).level, 'exceeded');
  assert.equal(core.getBudgetStatus(10001, 10000).remaining, -1);
  assert.equal(core.getBudgetStatus(4, 6).level, 'safe');
  assert.equal(core.getBudgetStatus(5, 6).level, 'warning');
  assert.throws(() => core.getBudgetStatus(-1, 100));
  const state = stateWith([transaction(), transaction({ id: 'income', type: 'income', amount: 100000 })]);
  state.budgets = { day: 1000, week: 2000, month: 10000 };
  const statuses = core.getBudgetStatuses(state, '2026-10-23');
  assert.equal(statuses.day.level, 'exceeded');
  assert.equal(statuses.week.level, 'safe');
  assert.equal(statuses.month.spent, 1500);
});

test('valid imports are cloned, stripped of extra keys and normalize timestamps', () => {
  const original = stateWith([transaction({ createdAt: Date.UTC(2026, 9, 23, 4), extra: 'ignored' })]);
  original.extra = 'ignored';
  const imported = core.validateState(original);
  assert.equal(imported.transactions[0].createdAt, '2026-10-23T04:00:00.000Z');
  assert.equal(imported.extra, undefined);
  assert.equal(imported.transactions[0].extra, undefined);
  imported.transactions[0].note = 'changed';
  assert.equal(original.transactions[0].note, '午餐');
  assert.deepEqual(core.validateState(core.createInitialState()), core.createInitialState());
});

test('corrupt backups are rejected before replacement', () => {
  for (const bad of [null, [], {}, { version: 2 }, { ...stateWith(), transactions: 'oops' }, { ...stateWith(), budgetReady: 'true' }, { ...stateWith(), budgetReady: true }, { ...stateWith(), budgets: { day: -1, week: 0, month: 0 } }, { ...stateWith(), budgets: { day: 1.1, week: 0, month: 0 } }, { ...stateWith(), budgets: { day: 0, week: 0 } }]) assert.throws(() => core.validateState(bad));
  for (const change of [{ id: '' }, { id: '<script>' }, { amount: 0 }, { amount: -1 }, { amount: 1.1 }, { amount: '100' }, { amount: core.MAX_AMOUNT + 1 }, { category: 'unknown' }, { type: 'refund' }, { date: '2026-02-30' }, { note: 'a'.repeat(501) }, { note: {} }, { createdAt: 'yesterday' }, { createdAt: '2026-02-30T04:00:00Z' }, { createdAt: '2026-10-23T24:00:00Z' }, { createdAt: -1 }, { createdAt: null }]) {
    assert.throws(() => core.validateState(stateWith([transaction(change)])), JSON.stringify(change));
  }
  assert.throws(() => core.validateState(stateWith([transaction(), transaction()])));
  assert.throws(() => core.validateState(stateWith(new Array(core.MAX_TRANSACTIONS + 1).fill(transaction()))));
});

test('demo is deterministic, standalone and never mutates real state', () => {
  const real = stateWith();
  const before = JSON.stringify(real);
  const demo = core.seedDemo('2026-10-23');
  assert.ok(demo.transactions.length > 50);
  assert.equal(demo.budgetReady, true);
  assert.equal(JSON.stringify(real), before);
  assert.deepEqual(demo, core.seedDemo('2026-10-23'));
  assert.notEqual(demo.transactions, core.seedDemo('2026-10-23').transactions);
  assert.ok(demo.transactions.every(t => t.date <= '2026-10-23'));
  assert.deepEqual(core.validateState(demo), demo);
});

test('standalone browser script exposes frozen LedgerCore without CommonJS', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), context);
  assert.equal(context.LedgerCore.parseAmount('1.25'), 125);
  // Hotel and AI categories were added after the original nine-category UI.
  assert.ok(context.LedgerCore.categories.some(category => category.id === 'hotel'));
  assert.ok(context.LedgerCore.categories.some(category => category.id === 'ai'));
  assert.equal(new Set(context.LedgerCore.categories.map(category => category.id)).size, context.LedgerCore.categories.length);
  assert.equal(Object.isFrozen(context.LedgerCore), true);
});
