(function (root, factory) {
  'use strict';
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.LedgerCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WechatImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const MAX_TEXT_LENGTH = 15000000;
  const MAX_ROWS = 60000;
  const aliases = {
    time: ['交易时间', '交易日期', '支付时间'],
    kind: ['交易类型', '交易种类'],
    counterparty: ['交易对方', '交易对手', '商户名称', '对方名称'],
    goods: ['商品', '商品名称', '商品说明', '交易商品'],
    direction: ['收/支', '收支', '收支类型', '收入/支出'],
    amount: ['金额(元)', '交易金额(元)', '收支金额(元)', '金额', '交易金额'],
    method: ['支付方式', '收/付款方式', '付款方式', '收付款方式'],
    status: ['当前状态', '交易状态', '状态'],
    order: ['交易单号', '微信交易单号', '微信支付订单号', '微信订单号', '交易订单号'],
    merchantOrder: ['商户单号', '商户订单号'],
    note: ['备注', '交易备注'],
    currency: ['币种', '货币种类', '货币']
  };
  const successStatuses = new Set(['支付成功', '交易成功', '转账成功', '收款成功', '已支付', '已完成', '已到账', '已入账', '已收钱', '已收款', '对方已收钱', '对方已收款', '已存入零钱', '已存入零钱通', '已领取']);
  const closedStatuses = new Set(['已关闭', '交易关闭', '已取消', '交易取消', '支付失败', '交易失败', '已作废']);
  const fullRefundStatuses = new Set(['已全额退款', '全额退款', '全额退款成功']);

  function clean(value) { return String(value == null ? '' : value).replace(/^\uFEFF/, '').trim().replace(/^[`']/, '').trim(); }
  function headerName(value) { return clean(value).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')'); }

  // RFC 4180-style quoting, including embedded commas, escaped quotes and newlines.
  // A non-enumerable line property preserves source line numbers in diagnostics.
  function parseCsv(text) {
    if (typeof text !== 'string') throw new Error('请读取 CSV 文本文件');
    if (text.length > MAX_TEXT_LENGTH) throw new Error('CSV 过大，请分批导入（单次最多 15MB 文本）');
    if (/^PK\x03\x04|^\u00D0\u00CF/.test(text)) throw new Error('这不是 CSV 文本，请解压账单后选择 CSV；表格文件需另存为 UTF-8 CSV');
    text = text.replace(/^\uFEFF/, '');
    if (text.includes('\u0000')) throw new Error('文件编码不受支持，请另存为 UTF-8 CSV');
    let field = '', row = [], quoted = false, afterQuote = false, line = 1, startLine = 1;
    const rows = [];
    function pushField() {
      if (field.length > 20000) throw new Error('第 ' + startLine + ' 行字段过长');
      row.push(field); field = ''; afterQuote = false;
      if (row.length > 100) throw new Error('CSV 列数过多，请使用微信个人账单原始列');
    }
    function pushRow() {
      pushField(); Object.defineProperty(row, 'line', { value: startLine }); rows.push(row); row = [];
      if (rows.length > MAX_ROWS) throw new Error('CSV 行数过多，请分批导入');
    }
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else { quoted = false; afterQuote = true; }
        } else {
          if (char === '\r') { if (text[i + 1] === '\n') i += 1; field += '\n'; line += 1; }
          else { field += char; if (char === '\n') line += 1; }
        }
      } else if (char === ',') {
        pushField();
      } else if (char === '\r' || char === '\n') {
        pushRow(); if (char === '\r' && text[i + 1] === '\n') i += 1;
        line += 1; startLine = line;
      } else if (afterQuote) {
        if (char !== ' ' && char !== '\t') throw new Error('第 ' + line + ' 行 CSV 引号后有异常字符');
      } else if (char === '"') {
        if (field.trim() !== '') throw new Error('第 ' + line + ' 行 CSV 引号格式不正确');
        field = ''; quoted = true;
      } else { field += char; }
    }
    if (quoted) throw new Error('CSV 引号未闭合，请使用完整的原始账单文件');
    if (field !== '' || row.length || afterQuote) pushRow();
    return rows;
  }

  // Stable non-cryptographic 128-bit fingerprint. This is an import key, not
  // encryption or a promise that an identifier has been irreversibly anonymized.
  function stableId(order) {
    const input = 'huayoushu-wechat-order-v1\u0000' + clean(order);
    let a = 2166136261, b = 2246822507, c = 3266489909, d = 668265263;
    for (let i = 0; i < input.length; i += 1) {
      const value = input.charCodeAt(i);
      a = Math.imul(a ^ value, 16777619);
      b = Math.imul(b ^ value, 2246822519);
      c = Math.imul(c ^ value, 3266489917);
      d = Math.imul(d ^ value, 668265263);
    }
    return 'wx-' + [a, b, c, d].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function findColumns(row) {
    const names = row.map(headerName), result = {};
    Object.keys(aliases).forEach(key => {
      const matches = names.map((name, index) => aliases[key].includes(name) ? index : -1).filter(index => index >= 0);
      if (matches.length > 1) result[key] = -2;
      else if (matches.length) result[key] = matches[0];
    });
    return result;
  }

  function parseTimestamp(value) {
    const text = clean(value);
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) throw new Error('交易时间格式无法识别');
    const date = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
    if (!C.isValidDate(date) || Number(match[4] || 0) > 23 || Number(match[5] || 0) > 59 || Number(match[6] || 0) > 59) throw new Error('交易日期或时间无效');
    return date;
  }

  function parseMoney(value) {
    let amount = clean(value).replace(/^(?:人民币|CNY|RMB|[¥￥])\s*/i, '').replace(/\s*元$/, '');
    if (amount.includes(',')) {
      if (!/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(amount)) throw new Error('金额的千分位格式无效');
      amount = amount.replace(/,/g, '');
    }
    return C.parseAmount(amount);
  }

  function guessCategory(text, type) {
    return C.classify(text, type).category;
  }

  function parseWechatCsv(text, options) {
    if (!C) throw new Error('请先加载账本核心模块');
    options = options || {};
    const existing = options.existingTransactions || [];
    if (!Array.isArray(existing)) throw new Error('现有账本记录须为数组');
    const referenceDate = options.today || C.today();
    if (!C.isValidDate(referenceDate)) throw new Error('当前日期无效');
    const createdAt = options.createdAt || new Date().toISOString();
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('导入时间无效');
    const rows = parseCsv(text);
    let headerIndex = -1, columns;
    for (let index = 0; index < rows.length; index += 1) {
      const found = findColumns(rows[index]);
      if (['time', 'direction', 'amount', 'status'].every(key => found[key] !== undefined)) { headerIndex = index; columns = found; break; }
    }
    if (headerIndex < 0) throw new Error('未找到微信个人账单表头，需要交易时间、收/支、金额(元)、当前状态等列；请选择个人对账 CSV');
    if (Object.values(columns).includes(-2)) throw new Error('账单表头有重复的关键列，请保留原始微信账单列');
    const result = { transactions: [], skipped: [], warnings: [], duplicates: [], counts: { rows: 0, importable: 0, skipped: 0, warnings: 0, duplicates: 0 } };
    const existingById = new Map(existing.map(transaction => [transaction.id, transaction]));
    const seen = new Map(), refundedIds = new Set();
    const dataRows = [];
    function warning(item, message) { result.warnings.push({ row: item.row, message: message, reason: message }); }
    function skip(item, reason) { result.skipped.push({ row: item.row, reason: reason }); }
    rows.slice(headerIndex + 1).forEach(row => {
      if (row.every(cell => !clean(cell))) return;
      const repeated = findColumns(row);
      if (['time', 'direction', 'amount', 'status'].every(key => repeated[key] !== undefined)) { skip({ row: row.line }, '重复的表头'); return; }
      const record = { row: row.line, width: row.length };
      Object.keys(columns).forEach(key => { record[key] = clean(row[columns[key]]); });
      if (row.length === 1 && /^(?:[-=]{3}|说明|注[:：]|温馨提示|本次导出|共\d+|共计|收入[:：]|支出[:：]|不计收支[:：])/.test(record.time || clean(row[0]))) { skip(record, '账单说明或统计行'); return; }
      record.id = record.order && !/^(?:\/|-{1,2}|无|N\/A)$/i.test(record.order) ? stableId(record.order) : null;
      if (record.id && /退款|退货|退回|退还|撤销/.test((record.status || '') + (record.kind || ''))) refundedIds.add(record.id);
      dataRows.push(record);
    });
    result.counts.rows = dataRows.length;
    const candidates = new Map();
    const conflictingIds = new Set();
    dataRows.forEach(item => {
      const status = item.status || '', direction = item.direction || '', kind = item.kind || '';
      if (item.width <= Math.max(columns.time, columns.direction, columns.amount, columns.status)) { warning(item, '列数不完整，该行未导入'); return; }
      if (fullRefundStatuses.has(status)) {
        skip(item, '已全额退款，不作为新增消费导入');
        if (item.id && existingById.has(item.id)) warning(item, '这笔已全额退款的原消费已在账本中，请手动核对并调整原记录');
        return;
      }
      if (/退款|退货|退回|退还|撤销/.test(status + kind)) { warning(item, '涉及退款、退回或撤销，需核对实际净支出，该行未自动导入'); return; }
      if (closedStatuses.has(status)) { skip(item, '交易未成功或已关闭'); return; }
      if (direction === '不计收支' || direction === '/' || direction === '-' || direction === '不计收入支出') { skip(item, '微信标记为不计收支'); return; }
      if (!['收入', '支出', '收', '支'].includes(direction)) { warning(item, '收支方向不明确，该行未导入'); return; }
      if (/零钱充值|零钱提现|零钱通|信用卡还款|理财通|基金|^充值$|^提现$|^银行卡转入$|^转入$|^转出$/.test(kind)) { skip(item, '账户间资金转移、还款或理财，不作为日常消费/收入导入'); return; }
      if (/手续费/.test(kind + ' ' + (item.goods || '') + ' ' + (item.note || ''))) { warning(item, '涉及手续费，请核对手续费与本金，避免重复或误计消费，该行未自动导入'); return; }
      if (!successStatuses.has(status)) { warning(item, '无法确认交易成功状态“' + status.slice(0, 40) + '”，该行未导入'); return; }
      if (item.currency && !/^(?:CNY|RMB|人民币|人民币元|元)$/i.test(item.currency)) { warning(item, '非人民币账单，未自动换算或导入'); return; }
      if (!item.id) { warning(item, '缺少交易单号，无法可靠去重，该行需手动核对'); return; }
      if (item.order.length > 256 || !/^[A-Za-z0-9_.:-]+$/.test(item.order)) { warning(item, '交易单号格式异常，该行未导入'); return; }
      if (refundedIds.has(item.id)) { warning(item, '同一交易单号在文件中还涉及退款，已暂停导入原消费，请一并核对'); return; }
      try {
        const date = parseTimestamp(item.time);
        if (date > referenceDate) throw new Error('交易日期晚于今天');
        const amount = parseMoney(item.amount);
        const type = direction === '收入' || direction === '收' ? 'income' : 'expense';
        const useful = value => value && !/^(?:\/|-{1,2}|无|N\/A)$/i.test(value);
        const pieces = [item.goods, item.counterparty, item.note].filter(useful).filter((value, index, all) => all.indexOf(value) === index);
        let note = pieces.join(' · ') || ('微信' + (kind || (type === 'income' ? '收入' : '支出')));
        if (note.length > 200) { note = note.slice(0, 197) + '…'; warning(item, '备注较长，已截取前 198 个字符；金额与日期未改变'); }
        const guessed = C.classify([item.goods, item.counterparty, kind].join(' '), type);
        const transaction = { id: item.id, type: type, amount: amount, category: guessed.category, sub: guessed.sub, date: date, note: note, createdAt: createdAt };
        const signature = type + ':' + amount + ':' + date;
        const previous = existingById.get(item.id) || seen.get(item.id);
        if (previous) {
          result.duplicates.push({ row: item.row, id: item.id, reason: existingById.has(item.id) ? '该交易已在账本中' : '文件中重复的交易单号' });
          if (previous.type + ':' + previous.amount + ':' + previous.date !== signature) {
            warning(item, '同一交易单号的金额、日期或收支方向发生冲突，未覆盖原账本，请人工核对');
            conflictingIds.add(item.id); candidates.delete(item.id);
          }
          return;
        }
        seen.set(item.id, transaction);
        if (!conflictingIds.has(item.id)) candidates.set(item.id, { transaction: transaction, row: item.row });
      } catch (error) { warning(item, error.message + '，该行未导入'); }
    });
    candidates.forEach(candidate => {
      if (!conflictingIds.has(candidate.transaction.id)) result.transactions.push(candidate.transaction);
    });
    if (existing.length + result.transactions.length > C.MAX_TRANSACTIONS) throw new Error('导入后超过账本支持的 ' + C.MAX_TRANSACTIONS + ' 条记录，请缩小导入范围');
    // Reuse exactly the same monetary, identifier and date contract as storage.
    const normalized = C.validateState(Object.assign(C.createInitialState(), { transactions: result.transactions }));
    result.transactions = normalized.transactions;
    result.counts.importable = result.transactions.length;
    result.counts.skipped = result.skipped.length;
    result.counts.warnings = result.warnings.length;
    result.counts.duplicates = result.duplicates.length;
    return result;
  }

  return Object.freeze({ parseCsv: parseCsv, parseWechatCsv: parseWechatCsv, stableId: stableId, guessCategory: guessCategory, MAX_TEXT_LENGTH: MAX_TEXT_LENGTH });
});
