/**
 * 值得买开放平台 MCP Streamable HTTP 客户端（tool 上下文专用）。
 *
 * 为什么不用宿主 pet.net.fetch：它只回传 {status, body, contentType}，读不到响应头，
 * 而本端点是有状态会话——Mcp-Session-Id 只经 initialize 响应头下发，后续请求必须带回。
 * 因此直接走 Node 全局 fetch（tool 插件跑在宿主 utilityProcess 的内嵌 Node 20+ 里，
 * 全局 fetch 可用，终端用户零依赖）。endpoint 可注入以便单测指向本地 mock server。
 *
 * 实测协议行为（2026-10-30 探测）：
 *   - 鉴权：请求头 x-api-key（Authorization: Bearer 无效，401）
 *   - initialize 响应头下发 Mcp-Session-Id；无会话/自造会话 → 400 "Missing session ID"
 *   - 会话过期 → 404；收到 404/400 会话类错误时重新 initialize 再重试一次
 *   - 响应可能是 application/json 或 text/event-stream，双解析兜底
 */
'use strict';

const DEFAULT_ENDPOINT = 'https://gw-openapi.zhidemai.com/ai-mcp/streamable/mcp';
const PROTOCOL_VERSION = '2025-06-18';

/** 解析 SSE 文本里的全部 data 载荷（事件按空行分隔），非 JSON 载荷（心跳等）忽略。 */
function parseSsePayloads(text) {
  const out = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') continue;
    try { out.push(JSON.parse(raw)); } catch (err) { /* 心跳/注释类载荷，忽略 */ }
  }
  return out;
}

/** 双解析：按 content-type 选路，json 解析失败时回落 SSE 解析（防 content-type 谎报）。 */
function parseRpcResponse(text, contentType) {
  const ct = String(contentType || '');
  if (ct.includes('text/event-stream')) {
    const payloads = parseSsePayloads(text);
    if (payloads.length) return payloads;
    throw new Error('SSE 响应中没有可解析的 JSON-RPC 载荷');
  }
  try { return [JSON.parse(text)]; }
  catch (err) {
    const payloads = parseSsePayloads(text);
    if (payloads.length) return payloads;
    throw new Error('响应既不是 JSON 也不是 SSE：' + String(text || '').slice(0, 200));
  }
}

function rpcErrText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  const data = error.data && typeof error.data === 'object' ? ' ' + JSON.stringify(error.data).slice(0, 200) : '';
  return (error.message || JSON.stringify(error).slice(0, 200)) + data;
}

class McpClient {
  /**
   * @param {object} opts
   *   endpoint    MCP 端点（默认什么值得买开放平台）
   *   fetchFn     fetch 实现（默认 global.fetch，单测可注入）
   *   getApiKey   () => string，每次请求现取（支持运行中换 Key）
   *   timeoutMs   单请求超时，默认 30s
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    this.fetchFn = opts.fetchFn || global.fetch;
    this.getApiKey = typeof opts.getApiKey === 'function' ? opts.getApiKey : () => '';
    this.clientName = opts.clientName || 'smzdm-helper';
    this.clientVersion = opts.clientVersion || '0.1.0';
    this.timeoutMs = opts.timeoutMs || 30 * 1000;
    this.sessionId = '';
    this.nextId = 0;
    this.initPromise = null;
  }

  async post(body, { sessionId = this.sessionId } = {}) {
    // provider 可能同步返回 string，也可能返回 Promise（读 secrets 要跨进程 RPC），统一 await
    let apiKey = '';
    try { apiKey = String((await this.getApiKey()) || '').trim(); } catch (err) { apiKey = ''; }
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream'
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? '请求超时（' + this.timeoutMs + 'ms）' : (err && err.message) || String(err);
      const e = new Error('MCP 请求失败: ' + msg);
      e.cause = err;
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    return {
      status: res.status,
      text,
      contentType: (res.headers && res.headers.get && res.headers.get('content-type')) || '',
      sessionId: (res.headers && res.headers.get && res.headers.get('mcp-session-id')) || ''
    };
  }

  describeError(res, label) {
    const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 160);
    if (res.status === 401) return label + ' 鉴权失败（HTTP 401）：x-api-key 缺失或无效';
    if (res.status === 403) return label + ' 被拒绝（HTTP 403）：' + snippet;
    return label + ' HTTP ' + res.status + (snippet ? '：' + snippet : '');
  }

  looksLikeSessionError(res) {
    return res.status === 400 && /session/i.test(String(res.text || ''));
  }

  /** 已有会话时直接复用；force 或无会话时重新 initialize。并发调用合并为一次。 */
  initialize(force = false) {
    if (!force && this.sessionId) return Promise.resolve(this.sessionId);
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize().finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  async _doInitialize() {
    const id = ++this.nextId;
    const res = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion }
      }
    }, { sessionId: '' });
    if (res.status !== 200) throw new Error(this.describeError(res, 'initialize'));

    const payloads = parseRpcResponse(res.text, res.contentType);
    const msg = payloads.find((p) => p && p.id === id) || payloads[0];
    if (!msg) throw new Error('initialize 响应为空');
    if (msg.error) throw new Error('initialize 失败: ' + rpcErrText(msg.error));
    if (!msg.result) throw new Error('initialize 响应缺少 result');

    const sid = res.sessionId;
    if (!sid) throw new Error('远端未下发 Mcp-Session-Id（请检查 Key 与协议版本）');
    this.sessionId = sid;

    // 发 initialized 通知完成握手；通知无应答语义，失败不阻断。
    try { await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch (err) { /* 忽略 */ }
    return sid;
  }

  /** 会话失效（404 / 400 Missing session）：丢会话、重 initialize、重试一次。 */
  async callTool(name, args) {
    try {
      return await this._callToolOnce(name, args);
    } catch (err) {
      if (err && err.sessionStale) {
        this.invalidateSession();
        await this.initialize(true);
        return await this._callToolOnce(name, args);
      }
      throw err;
    }
  }

  async _callToolOnce(name, args) {
    await this.initialize();
    const id = ++this.nextId;
    const res = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args || {} }
    });
    if (res.status === 404 || this.looksLikeSessionError(res)) {
      const err = new Error('MCP 会话失效，准备重连');
      err.sessionStale = true;
      throw err;
    }
    if (res.status !== 200) throw new Error(this.describeError(res, 'tools/call(' + name + ')'));

    const payloads = parseRpcResponse(res.text, res.contentType);
    const msg = payloads.find((p) => p && p.id === id) || payloads[0];
    if (!msg) throw new Error('tools/call(' + name + ') 响应为空');
    if (msg.error) throw new Error('远端工具 ' + name + ' 出错: ' + rpcErrText(msg.error));

    const result = msg.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    const rawText = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');

    let data = null;
    if (rawText) { try { data = JSON.parse(rawText); } catch (err) { data = null; } }
    if (!data && result.structuredContent && typeof result.structuredContent === 'object') {
      data = result.structuredContent;
    }
    return { isError: result.isError === true, rawText, data, content };
  }

  invalidateSession() { this.sessionId = ''; }

  dispose() { this.sessionId = ''; this.initPromise = null; }
}

module.exports = { McpClient, DEFAULT_ENDPOINT, PROTOCOL_VERSION, parseSsePayloads, parseRpcResponse };
