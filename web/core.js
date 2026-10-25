(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LedgerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // All monetary values below are integer cents. These limits also guarantee
  // that sums remain below Number.MAX_SAFE_INTEGER, even for a full import.
  const MAX_AMOUNT = 99999999999;
  const MAX_TRANSACTIONS = 50000;
  const MAX_ACCOUNTS = 100;
  const transactionTypes = ['expense', 'income', 'transfer', 'repayment'];
  // 大学生账本的第一层分类：没有“房租”，日常开销都归到“生活”。
  const categories = Object.freeze([
    { id: 'food', name: '餐饮', icon: '🍜', color: '#F29468' },
    { id: 'shopping', name: '购物', icon: '🛍️', color: '#C39BD3' },
    { id: 'life', name: '生活', icon: '🧺', color: '#79B8A1' },
    { id: 'transport', name: '交通', icon: '🚇', color: '#7F9DE0' },
    { id: 'hotel', name: '住宿', icon: '🏨', color: '#B28CC5' },
    { id: 'health', name: '健康', icon: '💊', color: '#DC8497' },
    { id: 'study', name: '学习', icon: '📖', color: '#73B8C6' },
    { id: 'ai', name: 'AI 服务', icon: '✦', color: '#6C8AE4' },
    { id: 'fun', name: '娱乐', icon: '🎮', color: '#E5B95C' },
    { id: 'social', name: '人情', icon: '🎁', color: '#AD9A7C' },
    { id: 'other', name: '其他', icon: '🧾', color: '#A1ABB2' }
  ].map(Object.freeze));
  const legacyCategoryIds = { home: 'life', food: 'food' };
  const categoryIds = new Set(categories.map(function (item) { return item.id; }));
  const subcategories = Object.freeze([
    { id: 'meal', category: 'food', name: '三餐食堂' },
    { id: 'fruit', category: 'food', name: '水果生鲜' },
    { id: 'snack', category: 'food', name: '零食' },
    { id: 'drink', category: 'food', name: '饮品奶茶' },
    { id: 'bbq', category: 'food', name: '夜宵火锅' },
    { id: 'online', category: 'shopping', name: '网购' },
    { id: 'daily', category: 'shopping', name: '日用百货' },
    { id: 'clothes', category: 'shopping', name: '服饰鞋包' },
    { id: 'care', category: 'shopping', name: '保健营养' },
    { id: 'digital', category: 'shopping', name: '数码电子' },
    { id: 'laundry', category: 'life', name: '洗衣洗护' },
    { id: 'phone', category: 'life', name: '话费流量' },
    { id: 'utility', category: 'life', name: '水电燃气' },
    { id: 'print', category: 'life', name: '打印复印' },
    { id: 'metro', category: 'transport', name: '地铁公交' },
    { id: 'train', category: 'transport', name: '火车高铁' },
    { id: 'taxi', category: 'transport', name: '打车' },
    { id: 'longway', category: 'transport', name: '长途机票' },
    { id: 'stay', category: 'hotel', name: '酒店住宿' },
    { id: 'gym', category: 'health', name: '健身运动' },
    { id: 'medical', category: 'health', name: '医疗药品' },
    { id: 'exam', category: 'study', name: '考试报名' },
    { id: 'book', category: 'study', name: '书籍资料' },
    { id: 'course', category: 'study', name: '培训课程' },
    { id: 'api', category: 'ai', name: 'AI 接口 / API' },
    { id: 'subscription', category: 'ai', name: 'AI 会员订阅' },
    { id: 'media', category: 'fun', name: '影音会员' },
    { id: 'game', category: 'fun', name: '游戏' },
    { id: 'outing', category: 'fun', name: '玩乐门票' },
    { id: 'transfer', category: 'social', name: '转账红包' },
    { id: 'gift', category: 'social', name: '礼物' },
    { id: 'unknown', category: 'other', name: '待归类' }
  ].map(Object.freeze));
  const subByKey = new Map(subcategories.map(function (item) { return [item.category + '/' + item.id, item]; }));
  function subcategoriesOf(category) {
    return subcategories.filter(function (item) { return item.category === category; });
  }
  function subName(category, sub) {
    const found = subByKey.get(category + '/' + sub);
    return found ? found.name : '待归类';
  }
  const periods = ['day', 'week', 'month'];

  // 关键词分类器：先匹配更具体的行业词，再退回大词，顺序即优先级。
  const RULES = [
    // 微信转账给 OY / Ex 这类固定充值，按 AI 订阅算（用户口径：转给 OY 的就是 ex 充值）
    ['ai', 'subscription', /(?:^|[^a-z])oy(?:[^a-z]|$)|oy\s*充值|转账[^。]{0,12}oy|(?:^|[^a-z])ex(?:[^a-z]|$)|ex\s*充值|ex\s*会员/],
    ['ai', 'api', /深度求索|deepseek|openai|chatgpt|anthropic|claude|kimi|moonshot|通义|百炼|dashscope|硅基流动|openrouter|gemini|grok|api\s*服务|大模型/],
    ['ai', 'subscription', /ai\s*会员|chatgpt\s*plus|claude\s*pro|perplexity|cursor|copilot|midjourney|suno|文心一言|豆包|即梦|可灵|会员.*ai/],
    ['hotel', 'stay', /酒店|汉庭|全季|华住|亚朵|如家|锦江|民宿|宾馆|旅店|住宿|客房|青年旅舍/],
    ['transport', 'train', /12306|中铁|火车|高铁|动车|铁路|硬卧|软卧|上铁/],
    ['transport', 'metro', /地铁|轨道交通|公交|乘车码|一卡通|交通卡|轻轨|骑行|单车|小遛|哈啰|共享出行/],
    ['transport', 'taxi', /打车|滴滴|出租车|网约车|花小猪|曹操|t3\s*出行|高德打车/],
    ['transport', 'longway', /机票|航空|飞机|携程旅行|去哪儿|飞猪/],
    ['food', 'fruit', /水果|鲜果|果业|果园|果缘|果行|万果园|森鲜|生鲜|蔬菜|榴莲|西瓜|香蕉|草莓|车厘子/],
    ['food', 'snack', /零食|好想来|零食乐园|小吃|卤味|鸭脖|辣条/],
    ['food', 'drink', /奶茶|咖啡|茶饮|蜜雪|瑞幸|星巴克|喜茶|古茗|茶百道|库迪|coco|luckin|coffee|一点点|霸王茶姬|饮料|饮品|可乐|雪糕|冰淇淋|柠檬茶/],
    ['food', 'bbq', /烧烤|夜宵|小龙虾|串串|炸串|火锅|麻辣烫|冒菜|地摊/],
    ['food', 'meal', /食堂|餐厅|餐饮|饭|面|馄饨|饺子|包子|鲜肉包|炸鸡|粥|汉堡|subway|赛百味|麦当劳|金拱门|肯德基|kfc|寿喜烧|和牛|快餐|外卖|早餐|午餐|晚餐|午饭|晚饭|新宇|万里学院|饭卡|校园卡|贪吃|旅途易购|美宜佳|美团|饿了么|轻食|老乡鸡|黄牛汤|金枪鱼|烧饼|热干面/],
    ['shopping', 'care', /保健|营养|维生素|鱼油|益生菌|蛋白粉|锌|镁|钙|辅酶|胶原/],
    ['shopping', 'digital', /数码|电子|耳机|充电|数据线|路由器|主板|开发板|硬盘|鼠标|键盘|相机|电脑|显示器|内存卡|pcb|嘉立创|元件|邀请码/],
    ['shopping', 'clothes', /服饰|衣服|裤子|鞋|袜|帽|优衣库|内衣|外套|裙|衬衫|羽绒/],
    ['shopping', 'online', /淘宝|天猫|拼多多|京东|抖音电商|唯品会|闲鱼|商城|网上购物|快递/],
    ['shopping', 'daily', /超市|百货|日用|便利店|大润发|沃尔玛|罗森|全家|名创|联华|欧伟仕|华润万家|易购|店内购物|洗护用品|便利|丰巢|快件/],
    ['life', 'laundry', /洗衣|洗护|干洗|清洁|爱喜衣|洗鞋|烘干/],
    ['life', 'phone', /话费|流量|电信|移动通信|联通|宽带|网费|校园网/],
    ['life', 'utility', /电费|水费|燃气|物业|取暖|热水/],
    ['health', 'gym', /健身|游泳|瑜伽|球馆|体育馆|跆拳道|私教|运动中心|健身房/],
    ['health', 'medical', /医院|药店|药房|诊所|体检|挂号|口腔|牙科|卫生院|买药/],
    ['study', 'exam', /考试|报名|驾考|驾驶许可|资格|证书|财政|报名费|四六级|雅思|托福/],
    ['study', 'book', /书店|图书|买书|教材|资料|文具|笔记本/],
    ['life', 'print', /打印|复印|文印|打印店/],
    ['study', 'course', /培训|课程|学费|网课|辅导|讲座|网校/],
    ['other', 'unknown', /网易云|qq音乐|音乐会员|音乐主站|svip/],
    ['fun', 'media', /视频会员|爱奇艺|腾讯视频|优酷|b站|哔哩|netflix|spotify|会员/],
    ['fun', 'game', /游戏|王者|steam|点卡|电竞|皮肤|充值.*游戏/],
    ['fun', 'outing', /电影|影院|景区|门票|剧院|演唱会|ktv|乐园|旅游|展览|密室/],
    ['social', 'transfer', /转账|红包|发给|收款|借款|还款|代付|份子/],
    ['social', 'gift', /礼物|礼品|鲜花|蛋糕|生日|纪念日/]
  ];
  function classify(text, type) {
    const source = String(text === undefined || text === null ? '' : text).toLowerCase();
    if (type === 'income') {
      if (/转账|红包|生活费|借款|还款|代付|退款|退还|报销|奖学金|兼职/.test(source)) return { category: 'social', sub: 'transfer' };
      return { category: 'other', sub: 'unknown' };
    }
    for (let i = 0; i < RULES.length; i += 1) {
      const rule = RULES[i];
      if (rule[2].test(source)) return { category: rule[0], sub: rule[1] };
    }
    return { category: 'other', sub: 'unknown' };
  }
  function merchantOf(transaction) {
    const note = String(transaction && transaction.note ? transaction.note : '').trim();
    if (!note) return '未写备注';
    const parts = note.split('·').map(function (part) { return part.trim(); }).filter(Boolean);
    const tail = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return tail.replace(/订单|商户单号.*$/g, '').slice(0, 24) || '未写备注';
  }

  function createInitialState() {
    return { version: 2, currency: 'CNY', accounts: [], transactions: [], budgets: { day: 0, week: 0, month: 0 }, budgetReady: false };
  }

  function parseAmount(value) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('请输入正确的金额');
    const text = String(value).trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
      throw new Error('金额必须为正数，且最多保留两位小数');
    }
    const parts = text.split('.');
    const cents = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT) {
      throw new Error('金额须大于 0，且不超过 999,999,999.99 元');
    }
    return cents;
  }

  function formatAmount(cents, options) {
    if (!Number.isSafeInteger(cents)) throw new Error('金额必须以整数分保存');
    const negative = cents < 0 ? '-' : '';
    const absolute = Math.abs(cents);
    let whole = String(Math.floor(absolute / 100));
    if (!options || options.grouping !== false) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return negative + whole + '.' + String(absolute % 100).padStart(2, '0');
  }

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parts = value.split('-').map(Number);
    return parts[0] >= 1 && parts[0] <= 9999 && parts[1] >= 1 && parts[1] <= 12 &&
      parts[2] >= 1 && parts[2] <= daysInMonth(parts[0], parts[1]);
  }

  function toDate(value) {
    if (!isValidDate(value)) throw new Error('日期格式无效，请使用 YYYY-MM-DD');
    const parts = value.split('-').map(Number);
    // Local noon avoids UTC conversion and midnight daylight-saving edges.
    const result = new Date(2000, 0, 1, 12, 0, 0, 0);
    result.setFullYear(parts[0], parts[1] - 1, parts[2]);
    return result;
  }

  function today(value) {
    const date = value === undefined ? new Date() : value;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('无效的日期');
    const result = String(date.getFullYear()).padStart(4, '0') + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    if (!isValidDate(result)) throw new Error('日期超出支持范围');
    return result;
  }

  function normalizeDate(value) {
    if (value === undefined) return today();
    if (value instanceof Date) return today(value);
    if (!isValidDate(value)) throw new Error('日期格式无效，请使用 YYYY-MM-DD');
    return value;
  }

  function addDays(value, amount) {
    if (!Number.isSafeInteger(amount)) throw new Error('日期偏移必须是整数');
    const date = toDate(normalizeDate(value));
    date.setDate(date.getDate() + amount);
    return today(date);
  }

  function assertPeriod(period) {
    if (!periods.includes(period)) throw new Error('周期必须是 day、week 或 month');
  }

  function getPeriodRange(period, referenceDate) {
    assertPeriod(period);
    const reference = normalizeDate(referenceDate);
    const date = toDate(reference);
    let start = reference;
    let end = reference;
    let label;
    if (period === 'week') {
      start = addDays(reference, -((date.getDay() + 6) % 7));
      end = addDays(start, 6);
      label = start.replace(/-/g, '.') + ' — ' + end.replace(/-/g, '.');
    } else if (period === 'month') {
      start = reference.slice(0, 7) + '-01';
      end = reference.slice(0, 7) + '-' + daysInMonth(date.getFullYear(), date.getMonth() + 1);
      label = date.getFullYear() + '年' + (date.getMonth() + 1) + '月';
    } else {
      label = date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
    }
    return { period: period, start: start, end: end, label: label };
  }

  function shiftPeriod(period, referenceDate, direction) {
    assertPeriod(period);
    if (!Number.isSafeInteger(direction)) throw new Error('周期偏移必须是整数');
    const reference = normalizeDate(referenceDate);
    if (period !== 'month') return addDays(reference, direction * (period === 'week' ? 7 : 1));
    const date = toDate(reference);
    const originalDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + direction);
    date.setDate(Math.min(originalDay, daysInMonth(date.getFullYear(), date.getMonth() + 1)));
    return today(date);
  }

  function getSummary(transactions, period, referenceDate) {
    if (!Array.isArray(transactions)) throw new Error('账单必须是数组');
    const range = getPeriodRange(period, referenceDate);
    const result = { range: range, income: 0, expense: 0, balance: 0, count: 0, categories: [], trend: [] };
    const categoryMap = new Map(categories.map(function (category) {
      return [category.id, Object.assign({}, category, { amount: 0, count: 0, share: 0, percentage: 0 })];
    }));
    const daily = new Map();
    let current = range.start;
    while (true) {
      const point = { date: current, label: Number(current.slice(5, 7)) + '/' + Number(current.slice(8)), expense: 0, income: 0, balance: 0 };
      daily.set(current, point);
      result.trend.push(point);
      if (current === range.end) break;
      current = addDays(current, 1);
    }
    transactions.forEach(function (transaction) {
      if (transaction.date < range.start || transaction.date > range.end) return;
      if (!Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 || transaction.amount > MAX_AMOUNT ||
          !transactionTypes.includes(transaction.type) || !categoryMap.has(transaction.category) || !daily.has(transaction.date)) {
        throw new Error('账单数据无效，请先校验账本');
      }
      result.count += 1;
      if (transaction.type !== 'expense' && transaction.type !== 'income') return;
      result[transaction.type] += transaction.amount;
      const point = daily.get(transaction.date);
      point[transaction.type] += transaction.amount;
      if (transaction.type === 'expense') {
        const category = categoryMap.get(transaction.category);
        category.amount += transaction.amount;
        category.count += 1;
      }
    });
    if (!Number.isSafeInteger(result.income) || !Number.isSafeInteger(result.expense)) throw new Error('账本金额合计超出支持范围');
    result.balance = result.income - result.expense;
    result.categories = Array.from(categoryMap.values()).map(function (category) {
      category.share = result.expense ? category.amount / result.expense : 0;
      category.percentage = category.share * 100;
      return category;
    }).sort(function (a, b) { return b.amount - a.amount; });
    result.trend.forEach(function (point) { point.balance = point.income - point.expense; });
    return result;
  }

  // 分析页用的细分聚合：大类 → 子类 → 商家，另外算日均与最大单笔。
  function getBreakdown(transactions, period, referenceDate) {
    if (!Array.isArray(transactions)) throw new Error('账单必须是数组');
    const summary = getSummary(transactions, period, referenceDate);
    const start = summary.range.start, end = summary.range.end;
    const byCategory = new Map();
    const byIncome = new Map();
    const merchants = new Map();
    const days = new Set();
    let biggest = null;
    let expenseCount = 0;
    transactions.forEach(function (transaction) {
      if (transaction.date < start || transaction.date > end) return;
      if (transaction.type !== 'expense' && transaction.type !== 'income') return;
      if (transaction.type === 'income') {
        const incomeCategory = categories.find(function (item) { return item.id === transaction.category; }) || categories[categories.length - 1];
        const incomeName = { social: '转账/红包收入', other: '其他收入', food: '退款收入', shopping: '退款收入' }[incomeCategory.id] || incomeCategory.name;
        const incomeBucket = byIncome.get(incomeCategory.id) || { id: incomeCategory.id, name: incomeName, icon: incomeCategory.icon, color: incomeCategory.color, amount: 0, count: 0 };
        incomeBucket.amount += transaction.amount;
        incomeBucket.count += 1;
        byIncome.set(incomeCategory.id, incomeBucket);
        return;
      }
      expenseCount += 1;
      days.add(transaction.date);
      const category = categories.find(function (item) { return item.id === transaction.category; });
      if (!category) return;
      let bucket = byCategory.get(category.id);
      if (!bucket) {
        bucket = { id: category.id, name: category.name, icon: category.icon, color: category.color, amount: 0, count: 0, subs: new Map() };
        byCategory.set(category.id, bucket);
      }
      bucket.amount += transaction.amount;
      bucket.count += 1;
      const subId = transaction.sub || 'unknown';
      const sub = bucket.subs.get(subId) || { id: subId, name: subName(category.id, subId), amount: 0, count: 0 };
      sub.amount += transaction.amount;
      sub.count += 1;
      bucket.subs.set(subId, sub);
      const label = merchantOf(transaction);
      const merchant = merchants.get(label) || { label: label, amount: 0, count: 0 };
      merchant.amount += transaction.amount;
      merchant.count += 1;
      merchants.set(label, merchant);
      if (!biggest || transaction.amount > biggest.amount) {
        biggest = { amount: transaction.amount, note: transaction.note, date: transaction.date, category: category.id, sub: subId };
      }
    });
    const total = summary.expense;
    const dayCount = summary.trend.length || 1;
    const list = Array.from(byCategory.values()).map(function (bucket) {
      const subs = Array.from(bucket.subs.values()).sort(function (a, b) { return b.amount - a.amount; }).map(function (sub) {
        return { id: sub.id, name: sub.name, amount: sub.amount, count: sub.count, share: bucket.amount ? sub.amount / bucket.amount : 0 };
      });
      return { id: bucket.id, name: bucket.name, icon: bucket.icon, color: bucket.color, amount: bucket.amount, count: bucket.count,
        share: total ? bucket.amount / total : 0, subs: subs };
    }).sort(function (a, b) { return b.amount - a.amount; });
    const merchantList = Array.from(merchants.values()).sort(function (a, b) { return b.amount - a.amount; }).slice(0, 10);
    const incomes = Array.from(byIncome.values()).sort(function (a, b) { return b.amount - a.amount; }).map(function (item) {
      return { id: item.id, name: item.name, icon: item.icon, color: item.color, amount: item.amount, count: item.count, share: summary.income ? item.amount / summary.income : 0 };
    });
    return { range: summary.range, summary: summary, total: total, count: expenseCount, income: summary.income, incomes: incomes, incomeCount: summary.income ? incomes.reduce(function (sum, item) { return sum + item.count; }, 0) : 0,
      avgPerDay: Math.round(total / dayCount), activeDays: days.size, dayCount: dayCount,
      biggest: biggest, categories: list, merchants: merchantList };
  }

  function getBudgetStatus(spent, limit) {
    if (!Number.isSafeInteger(spent) || spent < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_AMOUNT) {
      throw new Error('预算与支出必须以非负整数分保存');
    }
    const remaining = limit ? limit - spent : null;
    let level = 'unset';
    let message = '尚未设置预算';
    if (limit > 0) {
      if (spent > limit) { level = 'exceeded'; message = '已超预算 ¥' + formatAmount(spent - limit); }
      else if (spent === limit) { level = 'reached'; message = '已达到预算额度'; }
      else if (spent >= Math.ceil(limit * 0.8)) { level = 'warning'; message = '已用预算的 80% 以上，留意后续花费'; }
      else { level = 'safe'; message = '预算充足，还可用 ¥' + formatAmount(remaining); }
    }
    return { spent: spent, limit: limit, remaining: remaining, ratio: limit ? spent / limit : 0, level: level, message: message };
  }

  function getBudgetStatuses(state, referenceDate) {
    const result = {};
    periods.forEach(function (period) {
      const summary = getSummary(state.transactions, period, referenceDate);
      result[period] = Object.assign({ period: period, range: summary.range }, getBudgetStatus(summary.expense, state.budgets[period]));
    });
    return result;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
  }

  function validateAccounts(value) {
    if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) throw new Error('账户数组无效，最多支持 ' + MAX_ACCOUNTS + ' 个账户');
    const ids = new Set();
    return value.map(function (account, index) {
      const prefix = '第 ' + (index + 1) + ' 个账户：';
      if (!isPlainObject(account) || !validId(account.id) || account.id.indexOf('sys:') === 0) throw new Error(prefix + 'ID 无效');
      if (ids.has(account.id)) throw new Error(prefix + 'ID 重复');
      ids.add(account.id);
      if (typeof account.name !== 'string' || !account.name.trim() || account.name.trim().length > 60) throw new Error(prefix + '名称须为 1 至 60 字符');
      if (account.type !== 'asset' && account.type !== 'liability') throw new Error(prefix + '类型须为资产或负债');
      if (account.currency !== undefined && account.currency !== 'CNY') throw new Error(prefix + '当前仅支持人民币账户');
      if (!Number.isSafeInteger(account.openingBalance) || account.openingBalance < 0 || account.openingBalance > MAX_AMOUNT) throw new Error(prefix + '期初余额须为非负整数分');
      if (!isValidDate(account.openingDate) || account.openingDate > today()) throw new Error(prefix + '开账日期须为今天或过去的有效日期');
      return { id: account.id, name: account.name.trim(), type: account.type, currency: 'CNY', openingBalance: account.openingBalance, openingDate: account.openingDate };
    });
  }

  function posting(accountId, accountType, debit, credit) {
    return { accountId: accountId, accountType: accountType, debit: debit, credit: credit };
  }

  // Entries are derived from the canonical business fields. We deliberately
  // rebuild them on every edit/import instead of trusting stale stored totals.
  function buildEntries(transaction, accounts) {
    return buildEntriesForAccounts(transaction, validateAccounts(accounts || []));
  }

  function buildEntriesForAccounts(transaction, list) {
    if (!isPlainObject(transaction) || !transactionTypes.includes(transaction.type) ||
        !Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 || transaction.amount > MAX_AMOUNT ||
        !isValidDate(transaction.date)) throw new Error('无法为无效交易生成分录');
    if (transaction.currency !== undefined && transaction.currency !== 'CNY') throw new Error('当前仅支持人民币交易');
    const amount = transaction.amount;
    const type = transaction.type;
    const isMovement = type === 'transfer' || type === 'repayment';
    const category = legacyCategoryIds[transaction.category] || transaction.category;
    if (!categoryIds.has(category)) throw new Error('分录分类无效');
    const missingAccount = transaction.accountId === undefined || transaction.accountId === '' || transaction.accountId === null;
    if (transaction.pendingAccount !== undefined && typeof transaction.pendingAccount !== 'boolean') throw new Error('账户待归属标记无效');
    const hasTarget = transaction.targetAccountId !== undefined && transaction.targetAccountId !== '' && transaction.targetAccountId !== null;
    if (transaction.pendingAccount === true && (!missingAccount || isMovement || hasTarget)) {
      throw new Error('账户待归属仅支持未绑定资金账户的收入或支出；转账及还款须核对双方账户');
    }
    if (missingAccount) {
      if (isMovement || transaction.targetAccountId) throw new Error('请选择资金账户');
      // Historical/unassigned transactions remain balanced against a visibly
      // unresolved asset account; they never alter a user's real bank balance.
      return type === 'expense' ?
        [posting('sys:expense:' + category, 'expense', amount, 0), posting('sys:unassigned', 'asset', 0, amount)] :
        [posting('sys:unassigned', 'asset', amount, 0), posting('sys:income:' + category, 'income', 0, amount)];
    }
    if (typeof transaction.accountId !== 'string') throw new Error('资金账户 ID 无效');
    const account = list.find(function (item) { return item.id === transaction.accountId; });
    if (!account) throw new Error('资金账户不存在，请重新选择');
    if (transaction.date < account.openingDate) throw new Error('交易日期早于“' + account.name + '”的开账日期；请保留为历史记录或核实日期');
    if (type === 'expense') {
      if (transaction.targetAccountId) throw new Error('消费只能指定一个付款账户');
      return [posting('sys:expense:' + category, 'expense', amount, 0), posting(account.id, account.type, 0, amount)];
    }
    if (type === 'income') {
      if (account.type !== 'asset') throw new Error('收入须存入资产账户；信用卡还款请选择“还款”');
      if (transaction.targetAccountId) throw new Error('收入只能指定一个收款账户');
      return [posting(account.id, 'asset', amount, 0), posting('sys:income:' + category, 'income', 0, amount)];
    }
    const target = list.find(function (item) { return item.id === transaction.targetAccountId; });
    if (!target) throw new Error('目标账户不存在，请重新选择');
    if (target.id === account.id) throw new Error('转出和转入账户不能相同');
    if (account.type !== 'asset') throw new Error('转账或还款的付款账户须为资产账户');
    if (type === 'transfer' && target.type !== 'asset') throw new Error('内部转账须在两个资产账户之间进行；信用卡还款请选择“还款”');
    if (type === 'repayment' && target.type !== 'liability') throw new Error('还款目标须为信用卡等负债账户');
    if (transaction.date < target.openingDate) throw new Error('交易日期早于“' + target.name + '”的开账日期；请核实日期');
    return [posting(target.id, target.type, amount, 0), posting(account.id, 'asset', 0, amount)];
  }

  function openingEntries(account) {
    const amount = account.openingBalance;
    if (!amount) return [];
    return account.type === 'asset' ?
      [posting(account.id, 'asset', amount, 0), posting('sys:equity:opening', 'equity', 0, amount)] :
      [posting('sys:equity:opening', 'equity', amount, 0), posting(account.id, 'liability', 0, amount)];
  }

  function getJournal(state) {
    const normalized = validateState(state);
    const journal = normalized.accounts.filter(function (account) { return account.openingBalance > 0; }).map(function (account) {
      return { id: 'opening:' + account.id, date: account.openingDate, note: account.name + '期初余额', type: 'opening', legacy: false, entries: openingEntries(account) };
    });
    normalized.transactions.forEach(function (transaction) {
      journal.push({ id: transaction.id, date: transaction.date, note: transaction.note, type: transaction.type,
        legacy: transaction.legacy === true,
        ...(transaction.pendingAccount === true ? { pendingAccount: true } : {}),
        ...(transaction.accountHint !== undefined ? { accountHint: transaction.accountHint } : {}),
        entries: transaction.entries });
    });
    return journal.sort(function (a, b) { return a.date.localeCompare(b.date) || a.id.localeCompare(b.id); });
  }

  function getAccountBalances(state, asOf) {
    const normalized = validateState(state);
    const date = asOf === undefined ? today() : normalizeDate(asOf);
    const byId = new Map(normalized.accounts.map(function (account) {
      return [account.id, Object.assign({}, account, { balance: account.openingDate <= date ? account.openingBalance : 0, opened: account.openingDate <= date })];
    }));
    normalized.transactions.forEach(function (transaction) {
      if (transaction.date > date || transaction.legacy) return;
      transaction.entries.forEach(function (entry) {
        const account = byId.get(entry.accountId);
        if (!account) return;
        account.balance += account.type === 'asset' ? entry.debit - entry.credit : entry.credit - entry.debit;
        if (!Number.isSafeInteger(account.balance)) throw new Error('账户余额合计超出支持范围');
      });
    });
    return Array.from(byId.values());
  }

  function validateState(value) {
    if (!isPlainObject(value) || (value.version !== 1 && value.version !== 2)) throw new Error('不是受支持的花有数备份（需要 version: 1 或 2）');
    if (value.currency !== undefined && value.currency !== 'CNY') throw new Error('当前仅支持人民币账本');
    if (!Array.isArray(value.transactions) || value.transactions.length > MAX_TRANSACTIONS) {
      throw new Error('账单数组无效，最多支持 ' + MAX_TRANSACTIONS + ' 条账单');
    }
    if (!isPlainObject(value.budgets)) throw new Error('预算数据无效');
    const normalized = createInitialState();
    normalized.accounts = validateAccounts(value.version === 1 ? [] : value.accounts);
    periods.forEach(function (period) {
      const amount = value.budgets[period];
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT) throw new Error('预算金额无效：' + period);
      normalized.budgets[period] = amount;
    });
    if (typeof value.budgetReady !== 'boolean') throw new Error('预算设置状态无效');
    if (value.budgetReady && !periods.some(function (period) { return normalized.budgets[period] > 0; })) {
      throw new Error('已完成预算设置的账本须至少设置一项正数预算');
    }
    normalized.budgetReady = value.budgetReady;
    const ids = new Set();
    normalized.transactions = value.transactions.map(function (item, index) {
      const prefix = '第 ' + (index + 1) + ' 条账单：';
      if (!isPlainObject(item)) throw new Error(prefix + '数据格式无效');
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.id)) throw new Error(prefix + 'ID 无效');
      if (ids.has(item.id)) throw new Error(prefix + 'ID 重复');
      ids.add(item.id);
      if (!transactionTypes.includes(item.type) || (value.version === 1 && item.type !== 'expense' && item.type !== 'income')) throw new Error(prefix + '收支类型无效');
      if (!Number.isSafeInteger(item.amount) || item.amount <= 0 || item.amount > MAX_AMOUNT) throw new Error(prefix + '金额须为正整数分');
      const mappedCategory = item.type === 'transfer' || item.type === 'repayment' ? 'other' : (legacyCategoryIds[item.category] || item.category);
      if (!categoryIds.has(mappedCategory)) throw new Error(prefix + '分类无效');
      const guessed = classify(item.note, item.type);
      let subId = typeof item.sub === 'string' ? item.sub : '';
      if (!subByKey.has(mappedCategory + '/' + subId)) {
        subId = guessed.category === mappedCategory ? guessed.sub : (subcategoriesOf(mappedCategory)[0] || { id: 'unknown' }).id;
      }
      if (!isValidDate(item.date)) throw new Error(prefix + '日期无效');
      if (typeof item.note !== 'string' || item.note.length > 500) throw new Error(prefix + '备注须为不超过 500 字符的文字');
      // ISO timestamps from Date.toISOString are used by both UI and demos.
      // Numeric Unix millisecond timestamps are also accepted for existing books.
      let createdAt = item.createdAt;
      if (typeof createdAt === 'number') {
        if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > 253402300799999) throw new Error(prefix + '创建时间无效');
        createdAt = new Date(createdAt).toISOString();
      } else if (typeof createdAt === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt) ||
            !isValidDate(createdAt.slice(0, 10)) || !Number.isFinite(Date.parse(createdAt))) throw new Error(prefix + '创建时间无效');
        const time = createdAt.slice(11, 19).split(':').map(Number);
        if (time[0] > 23 || time[1] > 59 || time[2] > 59) throw new Error(prefix + '创建时间无效');
        createdAt = new Date(createdAt).toISOString();
      } else {
        throw new Error(prefix + '创建时间无效');
      }
      if (item.currency !== undefined && item.currency !== 'CNY') throw new Error(prefix + '当前仅支持人民币交易');
      const result = { id: item.id, type: item.type, amount: item.amount, category: mappedCategory, sub: subId, date: item.date, note: item.note, createdAt: createdAt, ...(item.fixed === true ? { fixed: true } : {}) };
      // V1 records have no account context. Never guess one or deduct their
      // historical expenses again from a newly confirmed opening balance.
      if (value.version === 2 && item.accountId !== undefined && item.accountId !== null && item.accountId !== '') result.accountId = item.accountId;
      if (value.version === 2 && item.targetAccountId !== undefined && item.targetAccountId !== null && item.targetAccountId !== '') result.targetAccountId = item.targetAccountId;
      if (item.pendingAccount !== undefined && typeof item.pendingAccount !== 'boolean') throw new Error(prefix + '账户待归属标记无效');
      if (item.pendingAccount === true) {
        if (value.version !== 2) throw new Error(prefix + '旧版账本不支持账户待归属标记');
        result.pendingAccount = true;
      }
      // Explicitly pending new receipts are distinct from historical records.
      // Their unresolved postings still never change any real account balance.
      result.legacy = !result.accountId && result.pendingAccount !== true;
      ['source', 'externalId', 'paymentChannel', 'merchant', 'receiptId', 'sourceFingerprint', 'accountHint'].forEach(function (key) {
        if (item[key] === undefined) return;
        if (typeof item[key] !== 'string' || item[key].length > 200) throw new Error(prefix + key + ' 无效');
        result[key] = item[key];
      });
      if (item.transactionTime !== undefined) {
        if (typeof item.transactionTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(item.transactionTime) || item.transactionTime.slice(0,10) !== item.date) throw new Error(prefix + '交易时间无效');
        result.transactionTime = item.transactionTime;
      }
      try { result.entries = buildEntriesForAccounts(result, normalized.accounts); }
      catch (error) { throw new Error(prefix + error.message); }
      return result;
    });
    return normalized;
  }

  function seedDemo(referenceDate) {
    const reference = normalizeDate(referenceDate);
    const state = createInitialState();
    state.budgets = { day: 15000, week: 90000, month: 380000 };
    state.budgetReady = true;
    const notes = { food: ['早餐和咖啡', '午餐', '晚餐'], transport: ['地铁出行', '打车'], shopping: ['日常用品', '换季衣物'], life: ['水电费'], fun: ['电影票'], health: ['常备药品'], study: ['书籍'], social: ['朋友聚餐'], other: ['临时支出'] };
    let counter = 0;
    function append(type, amount, category, date, note) {
      counter += 1;
      state.transactions.push({ id: 'demo-' + counter, type: type, amount: amount, category: category, date: date, note: note, createdAt: date + 'T04:00:00.000Z' });
    }
    for (let offset = 34; offset >= 0; offset -= 1) {
      const date = addDays(reference, -offset);
      append('expense', 1800 + (offset % 5) * 650, 'food', date, notes.food[offset % 3]);
      append('expense', 600 + (offset % 3) * 200, 'transport', date, '地铁出行');
      if (offset % 4 === 0) append('expense', 4200 + (offset % 5) * 1250, 'shopping', date, notes.shopping[offset % 2]);
      if (offset % 7 === 2) append('expense', 4800, 'fun', date, '周末电影');
      if (offset % 11 === 1) append('expense', 5900, 'study', date, '阅读与学习');
      if (offset === 8) append('expense', 28600, 'life', date, '水电和网络');
      if (offset === 4) append('expense', 12800, 'social', date, '朋友聚餐');
      if (offset === 12) append('expense', 3600, 'health', date, '常备药品');
    }
    append('income', 850000, 'other', reference.slice(0, 7) + '-01', '工资收入');
    return validateState(state);
  }

  return Object.freeze({ categories: categories, subcategories: subcategories, subcategoriesOf: subcategoriesOf, subName: subName,
    classify: classify, merchantOf: merchantOf, getBreakdown: getBreakdown, MAX_AMOUNT: MAX_AMOUNT, MAX_TRANSACTIONS: MAX_TRANSACTIONS, MAX_ACCOUNTS: MAX_ACCOUNTS,
    createInitialState: createInitialState, parseAmount: parseAmount, formatAmount: formatAmount,
    today: today, isValidDate: isValidDate, addDays: addDays, getPeriodRange: getPeriodRange,
    shiftPeriod: shiftPeriod, getSummary: getSummary, getBudgetStatus: getBudgetStatus,
    getBudgetStatuses: getBudgetStatuses, validateState: validateState, seedDemo: seedDemo,
    validateAccounts: validateAccounts, buildEntries: buildEntries, getJournal: getJournal, getAccountBalances: getAccountBalances });
});
