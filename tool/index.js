/**
 * 值得买助手 · 常驻能力层（tool 上下文）。
 *
 * 职责：
 *   1) Key 管理：无 Key 徽标「设置」直达面板；面板发事件存 secrets 并立即验证连通性
 *   2) 向宿主 Agent 注册 4 个查询工具（好价/商品/口碑/型号），对话里直查
 *   3) 好价早报：每天定时 discount_search 拉 top N，ai.chat 批量润色一次（失败降级列表）
 *   4) 降价监控：storage 存监控列表，定时轮询，命中降价 → 气泡 + 徽标 + 事件
 *
 * 网络走 Node 全局 fetch（见 mcp-client.js 头注释）；Key 只进 secrets，
 * 不落 storage、不进日志、不进事件载荷。
 */
'use strict';

const { McpClient, DEFAULT_ENDPOINT } = require('./mcp-client');

// ---- 常量 ----
const SECRET_KEY = 'smzdm_api_key';

const EVT = {
  KEY_SAVE: 'smzdm:key-save',             // panel -> tool
  KEY_CLEAR: 'smzdm:key-clear',           // panel -> tool
  KEY_QUERY: 'smzdm:key-query',           // panel -> tool（打开面板时拉当前状态）
  KEY_STATUS: 'smzdm:key-status',         // tool -> panel/card
  SEARCH: 'smzdm:search',                 // panel -> tool
  SEARCH_RESULT: 'smzdm:search-result',   // tool -> panel
  MONITOR_ADD: 'smzdm:monitor-add',       // panel -> tool
  MONITOR_REMOVE: 'smzdm:monitor-remove', // panel -> tool
  MONITOR_CHANGED: 'smzdm:monitor-changed',// tool -> panel/card
  SETTINGS_SAVE: 'smzdm:settings-save',   // panel -> tool
  SETTINGS_CHANGED: 'smzdm:settings-changed', // tool -> panel/card
  MORNING: 'smzdm:morning',               // tool -> panel/card
  DEAL_ALERT: 'smzdm:deal-alert'          // tool -> panel/card
};

const STORE = {
  SETTINGS: 'smzdm:settings',
  MONITOR: 'smzdm:monitor',
  MORNING_CACHE: 'smzdm:cache:morning'
};

const DEFAULT_SETTINGS = {
  morningEnabled: true,
  morningTime: '08:30',
  morningCount: 5,
  monitorEnabled: true,
  monitorHours: 2,
  monitorMax: 8
};

const REQUEST_FROM = {
  agent: 'smzdm-helper-agent',
  morning: 'smzdm-helper-morning',
  monitor: 'smzdm-helper-monitor'
};

const MORNING_QUERY = '好价';
const MAX_MONITOR = 20;
const BUBBLE_MS_MORNING = 15 * 1000;
const BUBBLE_MS_ALERT = 30 * 1000;   // 命中降价：显式给足 30s（宿主默认只有 4s）
const RETRY_ONCE = 1;

// ---- 运行期状态（进程内，不跨激活复用）----
let sdk = null;
let client = null;
const timerIds = new Set();
let keyValid = false;        // 当前会话已通过 initialize 验证
let lastVerifyError = '';

// ---- 小工具 ----
function clamp(n, lo, hi, def) {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function todayStr(now) {
  const d = now ? new Date(now) : new Date();
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 从价格描述里抠数字：'￥199' / '199.00元' / 199 -> 199（无法解析返回 null）。 */
function parsePrice(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---- 数据读写 ----

async function readSettings() {
  const raw = await sdk.storage.get(STORE.SETTINGS, {});
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    morningEnabled: s.morningEnabled !== false,
    morningTime: /^\d{2}:\d{2}$/.test(String(s.morningTime || '')) ? s.morningTime : DEFAULT_SETTINGS.morningTime,
    morningCount: clamp(s.morningCount, 3, 10, DEFAULT_SETTINGS.morningCount),
    monitorEnabled: s.monitorEnabled !== false,
    monitorHours: clamp(s.monitorHours, 1, 12, DEFAULT_SETTINGS.monitorHours),
    monitorMax: clamp(s.monitorMax, 3, 10, DEFAULT_SETTINGS.monitorMax)
  };
}

async function readMonitor() {
  const raw = await sdk.storage.get(STORE.MONITOR, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((it) => it && typeof it.keyword === 'string' && it.keyword.trim());
}

async function writeMonitor(list) {
  await sdk.storage.set(STORE.MONITOR, list.slice(0, MAX_MONITOR));
}

function publicMonitor(it) {
  return {
    id: it.id,
    keyword: it.keyword,
    targetPrice: it.targetPrice,
    lastPrice: it.lastPrice == null ? null : it.lastPrice,
    hitPrice: it.hitPrice == null ? null : it.hitPrice,
    hitAt: it.hitAt || 0,
    lastCheckedAt: it.lastCheckedAt || 0,
    lastError: it.lastError || ''
  };
}

// ---- Key 管理 ----

async function readApiKey() {
  const k = await sdk.secrets.get(SECRET_KEY);
  const t = typeof k === 'string' ? k.trim() : '';
  return t.length >= 8 && !/\s/.test(t) ? t : '';
}

function keyMissingMessage() {
  return '未设置什么值得买开放平台 Key：点宠物脚下的「设置」徽标，或打开值得买助手面板填写';
}

function makeClient() {
  return new McpClient({
    endpoint: process.env.SMZDM_MCP_ENDPOINT || DEFAULT_ENDPOINT,
    fetchFn: global.fetch,
    getApiKey: async () => {
      if (!sdk) return '';
      try { return await readApiKey(); } catch (err) { return ''; }
    },
    clientName: 'smzdm-helper',
    clientVersion: '0.1.1'
  });
}

/** 验证当前 secrets 里的 Key 能否走通 initialize。 */
async function verifyKey() {
  const apiKey = await readApiKey();
  if (!apiKey) {
    keyValid = false;
    lastVerifyError = '';
    return { ok: false, hasKey: false, valid: false, message: '' };
  }
  // Key 读取走 makeClient 注入的 provider（secrets 刚写入即可读到）
  try {
    client.invalidateSession();
    await client.initialize(true);
    keyValid = true;
    lastVerifyError = '';
    return { ok: true, hasKey: true, valid: true, message: '已连通' };
  } catch (err) {
    keyValid = false;
    lastVerifyError = truncate(String(err.message || err), 160);
    return { ok: false, hasKey: true, valid: false, message: '连通失败：' + lastVerifyError };
  }
}

async function emitKeyStatus(status) {
  try { await sdk.events.emit(EVT.KEY_STATUS, status); } catch (err) { /* 没有监听方时忽略 */ }
}

// ---- 徽标 ----

async function syncBadge() {
  if (!sdk) return;
  try {
    const apiKey = await readApiKey();
    if (!apiKey || !keyValid) {
      await sdk.badge.set({ segments: [{ tone: 'warning', text: '设置' }], onClick: 'openPanel' });
      return;
    }
    const segments = [];
    const cache = await sdk.storage.get(STORE.MORNING_CACHE, null);
    if (cache && cache.date === todayStr() && Array.isArray(cache.items) && cache.items.length) {
      const n = cache.items.length;
      segments.push({ tone: 'primary', text: '好价' + (n > 99 ? '多' : n) });
    }
    const list = await readMonitor();
    const hits = list.filter((it) => it.hitPrice != null).length;
    if (hits) segments.push({ tone: 'danger', text: '降' + (hits > 99 ? '多' : hits) });
    if (!segments.length) await sdk.badge.clear();
    else await sdk.badge.set({ segments: segments.slice(0, 2), onClick: 'openPanel' });
  } catch (err) {
    // 徽标名额被其它插件占用等，不打断主流程
  }
}

// ---- 远端结果归一化 ----

// 键表按 2026-10 实弹探测校准：
//   discount_search.rows -> title/url/price/mall_name（b2c_list 子数组无 title 类字段，不会误收）
//   product_search_pro   -> title/url("¥442.87" 字符串价格)/mall_name
//   content_search       -> works_title(可空)/works_link(无协议前缀)/website_cname，标题空时用正文兜底
//   content_graph_search -> entity_name/brand/entity_description，链接在 article_links 子数组里
const TITLE_KEYS = ['title', 'article_title', 'product_name', 'entity_name', 'works_title', 'name', 'subject', 'keyword'];
const URL_KEYS = ['url', 'article_url', 'works_link', 'url_wap', 'link', 'jump_url', 'pc_url'];
const PRICE_KEYS = ['price', 'product_price', 'act_price', 'min_price', 'price_desc'];
const MALL_KEYS = ['mall_name', 'mall', 'shop_name', 'site_name', 'channel', 'website_cname'];
const CONTENT_KEYS = ['content', 'works_content', 'entity_description'];

function firstKey(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

/** 深度找「像结果列表」的数组：元素是对象且多数带 title 类字段。深度限 4 层。 */
function findItemArrays(node, depth, out) {
  if (!node || typeof node !== 'object' || depth > 4 || out.length > 6) return;
  if (Array.isArray(node)) {
    const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    // 口碑条目 works_title 可能为空，标题与正文都纳入「像结果列表」判定
    if (objs.length && objs.filter((o) => firstKey(o, TITLE_KEYS) !== '' || firstKey(o, CONTENT_KEYS) !== '').length >= Math.max(1, objs.length >> 1)) {
      out.push(objs);
      return;
    }
    for (const x of node) findItemArrays(x, depth + 1, out);
    return;
  }
  for (const k of Object.keys(node)) findItemArrays(node[k], depth + 1, out);
}

/** url 为空时，在对象浅层（一层）的子数组里找第一个带链接的元素（graph 的 article_links）。 */
function pickNestedUrl(o, depth) {
  if (depth > 1 || !o || typeof o !== 'object') return '';
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        const u = String(firstKey(x, URL_KEYS) || '').trim();
        if (u) return u;
      }
    }
  }
  return '';
}

function normalizeItems(data) {
  const arrays = [];
  findItemArrays(data, 0, arrays);
  const seen = new Set();
  const items = [];
  for (const arr of arrays) {
    for (const o of arr) {
      const title = String(firstKey(o, TITLE_KEYS) || '').trim() ||
        truncate(String(firstKey(o, CONTENT_KEYS) || '').replace(/\s+/g, ' ').trim(), 60);
      if (!title) continue;
      let url = String(firstKey(o, URL_KEYS) || '').trim() || pickNestedUrl(o, 1);
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;   // works_link 返回的是无协议前缀域名
      const dedup = title + '|' + url;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const priceRaw = firstKey(o, PRICE_KEYS);
      items.push({
        title: truncate(title, 120),
        url,
        price: parsePrice(priceRaw),
        priceText: typeof priceRaw === 'string' && priceRaw ? truncate(priceRaw, 40) : '',
        mall: truncate(String(firstKey(o, MALL_KEYS) || ''), 20)
      });
      if (items.length >= 30) return items;
    }
  }
  return items;
}

// ---- 统一查询（Agent 工具与面板搜索共用）----

// discount_search 的 question_id 是必填（远端 schema required），任意非空字符串可通过，
// 语义是「本次提问的 id」——每次调用生成一个唯一值。
function newQuestionId() {
  return 'smzdm-helper-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function dealsArgs(productQuery, size, from) {
  return { product_query: productQuery, size, request_from: from, question_id: newQuestionId() };
}

// reviews/graph 的远端 schema 没有 request_from 参数（实弹验证多余参数会被忽略，但按 schema 干净传）
const QUERY_KINDS = {
  deals: {
    tool: 'discount_search',
    build: (p) => dealsArgs(p.query, clamp(p.size, 1, 20, 10), REQUEST_FROM.agent)
  },
  products: {
    tool: 'product_search_pro',
    build: (p) => {
      const args = { product_query: p.query, size: clamp(p.size, 1, 20, 10), request_from: REQUEST_FROM.agent };
      if (p.brand) args.brand_name = String(p.brand).slice(0, 40);
      const min = parsePrice(p.minPrice); if (min != null) args.min_price = min;
      const max = parsePrice(p.maxPrice); if (max != null) args.max_price = max;
      if (p.sort) args.sort = String(p.sort).slice(0, 20);
      return args;
    }
  },
  reviews: {
    tool: 'content_search',
    build: (p) => {
      const args = { query: p.query, return_size: clamp(p.size, 1, 20, 8) };
      if (p.platform) args.data_source = String(p.platform).slice(0, 20);
      return args;
    }
  },
  graph: {
    tool: 'content_graph_search',
    build: (p) => {
      const args = { query: p.query };
      if (p.categories) args.categories = Array.isArray(p.categories) ? p.categories.slice(0, 5).map(String) : String(p.categories);
      return args;
    }
  }
};

async function queryKind(kind, params) {
  const spec = QUERY_KINDS[kind];
  if (!spec) return { ok: false, error: '未知的查询类型: ' + kind };
  const apiKey = await readApiKey();
  if (!apiKey) return { ok: false, error: keyMissingMessage(), needKey: true };
  const q = String((params && params.query) || '').trim();
  if (!q) return { ok: false, error: 'query 不能为空' };
  const args = spec.build(Object.assign({}, params, { query: q }));
  let lastErr = '';
  for (let attempt = 0; attempt <= RETRY_ONCE; attempt++) {
    try {
      const r = await client.callTool(spec.tool, args);
      const items = normalizeItems(r.data);
      if (items.length || r.isError !== true) {
        return { ok: true, kind, tool: spec.tool, items, rawText: truncate(r.rawText, 1200) };
      }
      // isError:true 时透传远端给的文本（此前吞掉只报「远端返回错误结果」）
      lastErr = String(r.rawText || '远端返回错误结果（远端未给出错误文本）');
    } catch (err) {
      lastErr = String(err.message || err);
      if (/HTTP 401/.test(lastErr)) return { ok: false, error: 'Key 无效或已过期（401），请在面板里重新填写', needKey: true };
    }
  }
  return { ok: false, error: truncate(lastErr, 200) };
}

// ---- Agent 工具 ----

function registerTools() {
  const guard = (fn) => async (args) => {
    if (!sdk) return { ok: false, error: '插件已停用' };
    try { return await fn(args || {}); }
    catch (err) { return { ok: false, error: truncate(String(err.message || err), 200) }; }
  };

  sdk.tools.register({
    name: 'smzdm_好价搜索',
    promptHint: '搜索什么值得买的好价信息（优惠/爆料）。返回标题、价格、商城与链接。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '商品关键词，如 显卡 / 咖啡 / 空气炸锅' },
        size: { type: 'number', description: '返回条数，默认 10，上限 20' }
      },
      required: ['query']
    },
    handler: guard((args) => queryKind('deals', args))
  });

  sdk.tools.register({
    name: 'smzdm_商品搜索',
    promptHint: '在什么值得买按价格区间/品牌/排序搜索商品。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '商品关键词' },
        brand: { type: 'string', description: '可选，品牌名' },
        minPrice: { type: 'number', description: '可选，最低价' },
        maxPrice: { type: 'number', description: '可选，最高价' },
        sort: { type: 'string', description: '可选，排序方式' },
        size: { type: 'number', description: '返回条数，默认 10' }
      },
      required: ['query']
    },
    handler: guard((args) => queryKind('products', args))
  });

  sdk.tools.register({
    name: 'smzdm_口碑查询',
    promptHint: '查询全网（小红书/知乎/微信/头条/抖音/B站等）对某商品或品牌的讨论与口碑。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查口碑的关键词' },
        platform: { type: 'string', description: '可选，指定平台，如 小红书 / 知乎 / B站' },
        size: { type: 'number', description: '返回条数，默认 8' }
      },
      required: ['query']
    },
    handler: guard((args) => queryKind('reviews', args))
  });

  sdk.tools.register({
    name: 'smzdm_型号查询',
    promptHint: '用 3C 知识图谱查询具体数码型号的参数、对比与选购建议。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '具体型号，如 iPhone 17 Pro / RTX5080' },
        categories: { type: 'string', description: '可选，品类限定' }
      },
      required: ['query']
    },
    handler: guard((args) => queryKind('graph', args))
  });
}

// ---- 好价早报 ----

function composeMorningBubble(items, polished) {
  const top = items.slice(0, 3);
  if (Array.isArray(polished) && polished.length) {
    const parts = [];
    for (const it of top) {
      const p = polished.find((x) => x && x.title && it.title.includes(String(x.title).slice(0, 12)));
      const blurb = p && p.blurb ? String(p.blurb) : it.title;
      parts.push(truncate(blurb, 46));
    }
    return truncate('早报来了！' + parts.join('；'), 180);
  }
  const parts = top.map((it, i) =>
    (i + 1) + '. ' + truncate(it.title, 26) + (it.price != null ? '（' + it.price + '元）' : ''));
  return truncate('今日好价 ' + items.length + ' 条：' + parts.join('；'), 180);
}

/** 一次 ai.chat 批量润色全部条目；解析失败/限流时抛错，由调用方降级。 */
async function polishMorning(items) {
  const brief = items.slice(0, 8).map((it) => ({
    title: it.title,
    price: it.price,
    mall: it.mall
  }));
  const prompt =
    '你是桌宠的省钱军师。把下面的好价列表改写成晨间播报，每条配一句 30 字以内、' +
    '口语化带点性格的短评。只输出 JSON 数组，格式 [{"title":"原标题","blurb":"短评"}]，不要输出其它内容。\n' +
    JSON.stringify(brief);
  const text = await sdk.ai.chat(prompt);
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('AI 输出里没有 JSON 数组');
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('AI 输出解析失败');
  return arr.filter((x) => x && typeof x.blurb === 'string').slice(0, 8);
}

async function fetchMorningItems(count) {
  let lastErr = '';
  for (let attempt = 0; attempt <= RETRY_ONCE; attempt++) {
    try {
      const r = await client.callTool('discount_search', dealsArgs(MORNING_QUERY, count, REQUEST_FROM.morning));
      const items = normalizeItems(r.data);
      if (items.length) return items.slice(0, count);
      lastErr = (r.isError === true && r.rawText) ? String(r.rawText) : '没有拉到好价数据';
    } catch (err) {
      lastErr = String(err.message || err);
      if (/HTTP 401/.test(lastErr)) break;
    }
  }
  throw new Error(truncate(lastErr, 160));
}

async function runMorning(reason) {
  if (!sdk || !client) return;
  const settings = await readSettings();
  if (!settings.morningEnabled) return;
  if (!(await readApiKey())) { await syncBadge(); return; }

  let items;
  try { items = await fetchMorningItems(settings.morningCount); }
  catch (err) { return; }   // 静默跳过本轮（设计案：重试一次后放弃）

  let polished = null;
  try { polished = await polishMorning(items); } catch (err) { /* 无 ai key / 限流 → 列表模式 */ }

  await sdk.storage.set(STORE.MORNING_CACHE, {
    date: todayStr(),
    items,
    polished: polished || null,
    at: Date.now(),
    reason: reason || 'daily'
  });
  try { await sdk.pet.playAnim('speak'); } catch (err) { /* 动作失败忽略 */ }
  await sdk.pet.bubble(composeMorningBubble(items, polished), BUBBLE_MS_MORNING);
  await sdk.events.emit(EVT.MORNING, { items, polished: !!polished, reason: reason || 'daily' });
  await syncBadge();
}

// ---- 降价监控 ----

function composeAlertBubble(hits) {
  const parts = hits.slice(0, 2).map((h) =>
    truncate(h.keyword, 16) + ' 现价' + h.price + '元（目标' + h.targetPrice + '元）');
  return truncate('降价啦！' + parts.join('；') + '，价格以商品页为准', 180);
}

async function checkOneKeyword(it, settings) {
  let lastErr = '';
  for (let attempt = 0; attempt <= RETRY_ONCE; attempt++) {
    try {
      const r = await client.callTool('discount_search', dealsArgs(it.keyword, 5, REQUEST_FROM.monitor));
      const items = normalizeItems(r.data);
      if (items.length || r.isError !== true) return items;
      lastErr = String(r.rawText || '远端返回错误结果');
    } catch (err) {
      lastErr = String(err.message || err);
      if (/HTTP 401/.test(lastErr)) break;
    }
  }
  it.lastError = truncate(lastErr, 120);
  return null;
}

async function runMonitorCheck() {
  if (!sdk || !client) return;
  const settings = await readSettings();
  if (!settings.monitorEnabled) return;
  const list = await readMonitor();
  if (!list.length) return;
  if (!(await readApiKey())) return;

  const now = Date.now();
  const targets = list.slice(0, settings.monitorMax);
  const hits = [];

  for (const it of targets) {
    it.lastError = '';
    const items = await checkOneKeyword(it, settings);
    it.lastCheckedAt = now;
    if (!items || !items.length) continue;

    // 取返回结果里的最低价作为当前价
    let best = null;
    for (const x of items) {
      if (x.price == null) continue;
      if (!best || x.price < best.price) best = x;
    }
    it.lastPrice = best ? best.price : null;

    const target = parsePrice(it.targetPrice);
    if (best && target != null && best.price <= target) {
      const isNewHit = it.hitPrice == null || it.hitPrice !== best.price;
      it.hitPrice = best.price;
      it.hitAt = now;
      if (isNewHit) {
        hits.push({
          keyword: it.keyword,
          title: best.title,
          price: best.price,
          targetPrice: target,
          url: best.url
        });
      }
    } else if (best && target != null && it.hitPrice != null && best.price > target) {
      it.hitPrice = null;   // 涨回去了，解除命中态
    }
  }

  await writeMonitor(list);
  await sdk.events.emit(EVT.MONITOR_CHANGED, {
    items: list.slice(0, settings.monitorMax).map(publicMonitor),
    nextCheckAt: now + settings.monitorHours * 3600 * 1000
  });

  if (hits.length) {
    try { await sdk.pet.playAnim('unread'); } catch (err) { /* 忽略 */ }
    await sdk.pet.bubble(composeAlertBubble(hits), BUBBLE_MS_ALERT);
    await sdk.events.emit(EVT.DEAL_ALERT, { items: hits, note: '价格以商品页为准' });
  }
  await syncBadge();
}

// ---- 调度 ----

async function armTimers() {
  if (!sdk) return;
  for (const id of timerIds) {
    try { await sdk.scheduler.cancel(id); } catch (err) { /* 已失效的忽略 */ }
  }
  timerIds.clear();
  const settings = await readSettings();
  timerIds.add(await sdk.scheduler.every(
    settings.monitorHours * 3600 * 1000,
    () => { runMonitorCheck().catch(() => {}); }
  ));
  timerIds.add(await sdk.scheduler.daily(
    settings.morningTime,
    () => { runMorning('daily').catch(() => {}); }
  ));
}

// ---- 面板事件 ----

function bindPanelEvents() {
  sdk.events.on(EVT.KEY_SAVE, (data) => {
    onKeySave(data).catch(() => {});
  });
  sdk.events.on(EVT.KEY_CLEAR, () => {
    onKeyClear().catch(() => {});
  });
  sdk.events.on(EVT.KEY_QUERY, () => {
    if (!sdk) return;
    readApiKey().then((apiKey) => {
      emitKeyStatus({
        hasKey: !!apiKey,
        valid: !!apiKey && keyValid,
        message: apiKey ? (keyValid ? '已连通' : (lastVerifyError ? '连通失败：' + lastVerifyError : '尚未验证')) : '未设置 Key'
      }).catch(() => {});
    }).catch(() => {});
  });
  sdk.events.on(EVT.SEARCH, (data) => {
    if (!sdk) return;
    const reqId = data && data.reqId;
    queryKind(String(data && data.kind || 'deals'), (data && data.params) || {})
      .then((r) => sdk.events.emit(EVT.SEARCH_RESULT, Object.assign({ reqId }, r)))
      .catch((err) => sdk && sdk.events.emit(EVT.SEARCH_RESULT, {
        reqId, ok: false, error: truncate(String(err.message || err), 200)
      }));
  });
  sdk.events.on(EVT.MONITOR_ADD, (data) => {
    onMonitorAdd(data).catch(() => {});
  });
  sdk.events.on(EVT.MONITOR_REMOVE, (data) => {
    onMonitorRemove(data).catch(() => {});
  });
  sdk.events.on(EVT.SETTINGS_SAVE, (data) => {
    onSettingsSave(data).catch(() => {});
  });
}

async function onKeySave(data) {
  if (!sdk) return;
  const key = String((data && data.key) || '').trim();
  if (key.length < 8 || key.length > 128 || /\s/.test(key)) {
    await emitKeyStatus({ hasKey: false, valid: false, message: 'Key 格式不对：应为平台颁发的 API Key（8-128 位，不含空格）' });
    await syncBadge();
    return;
  }
  await sdk.secrets.set(SECRET_KEY, key);
  const status = await verifyKey();
  await emitKeyStatus(status);
  await syncBadge();
  if (status.ok) {
    // 刚通就跑一轮监控，让用户立刻看到效果
    runMonitorCheck().catch(() => {});
  }
}

async function onKeyClear() {
  if (!sdk) return;
  try { await sdk.secrets.delete(SECRET_KEY); } catch (err) { /* 本来就没有时忽略 */ }
  keyValid = false;
  lastVerifyError = '';
  client.invalidateSession();
  await emitKeyStatus({ hasKey: false, valid: false, message: '已清除' });
  await syncBadge();
}

async function onMonitorAdd(data) {
  if (!sdk) return;
  const keyword = String((data && data.keyword) || '').trim();
  const target = parsePrice(data && data.targetPrice);
  if (!keyword || keyword.length > 40) {
    await sdk.events.emit(EVT.MONITOR_CHANGED, { error: '关键词必填且不超过 40 字' });
    return;
  }
  if (target == null || target <= 0) {
    await sdk.events.emit(EVT.MONITOR_CHANGED, { error: '目标价必须是大于 0 的数字' });
    return;
  }
  const list = await readMonitor();
  if (list.some((it) => it.keyword === keyword)) {
    await sdk.events.emit(EVT.MONITOR_CHANGED, { error: '这个关键词已经在监控列表里' });
    return;
  }
  list.push({
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    keyword,
    targetPrice: target,
    addedAt: Date.now(),
    lastPrice: null,
    hitPrice: null,
    hitAt: 0,
    lastCheckedAt: 0,
    lastError: ''
  });
  await writeMonitor(list);
  await sdk.events.emit(EVT.MONITOR_CHANGED, { items: list.map(publicMonitor) });
  await syncBadge();
  runMonitorCheck().catch(() => {});   // 新增后立即查一轮
}

async function onMonitorRemove(data) {
  if (!sdk) return;
  const id = String((data && data.id) || '');
  const list = await readMonitor();
  const rest = list.filter((it) => it.id !== id);
  await writeMonitor(rest);
  await sdk.events.emit(EVT.MONITOR_CHANGED, { items: rest.map(publicMonitor) });
  await syncBadge();
}

async function onSettingsSave(data) {
  if (!sdk) return;
  const cur = await readSettings();
  const next = Object.assign({}, cur);
  if (data && typeof data === 'object') {
    if (data.morningEnabled !== undefined) next.morningEnabled = data.morningEnabled === true;
    if (data.morningTime !== undefined && /^\d{2}:\d{2}$/.test(String(data.morningTime))) next.morningTime = data.morningTime;
    if (data.morningCount !== undefined) next.morningCount = clamp(data.morningCount, 3, 10, cur.morningCount);
    if (data.monitorEnabled !== undefined) next.monitorEnabled = data.monitorEnabled === true;
    if (data.monitorHours !== undefined) next.monitorHours = clamp(data.monitorHours, 1, 12, cur.monitorHours);
    if (data.monitorMax !== undefined) next.monitorMax = clamp(data.monitorMax, 3, 10, cur.monitorMax);
  }
  await sdk.storage.set(STORE.SETTINGS, next);
  await sdk.events.emit(EVT.SETTINGS_CHANGED, { settings: next });
  await armTimers();   // 间隔/时间变了要重挂定时器
}

// ---- 生命周期 ----

exports.activate = async function activate(pet) {
  sdk = pet;

  client = makeClient();   // key provider 已注入（每次请求现读 secrets）

  registerTools();
  bindPanelEvents();

  await armTimers();

  // 启动时若有 Key 就验证一次（异步，不阻塞激活）
  readApiKey().then(async (apiKey) => {
    if (!sdk) return;
    if (!apiKey) {
      await syncBadge();
      await emitKeyStatus({ hasKey: false, valid: false, message: '未设置 Key' });
      return;
    }
    const status = await verifyKey();
    await syncBadge();
    await emitKeyStatus(status);
    if (status.ok) runMonitorCheck().catch(() => {});
  }).catch(() => {});
};

exports.deactivate = async function deactivate() {
  if (!sdk) return;
  for (const id of timerIds) {
    try { await sdk.scheduler.cancel(id); } catch (err) { /* 已失效的忽略 */ }
  }
  timerIds.clear();
  try { await sdk.badge.clear(); } catch (err) { /* 徽标已被宿主回收 */ }
  if (client) client.dispose();
  client = null;
  sdk = null;
  keyValid = false;
  lastVerifyError = '';
};
