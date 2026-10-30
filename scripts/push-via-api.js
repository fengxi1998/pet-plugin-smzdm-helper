#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 推送本地目录到仓库（单次提交，原子生效）。
 *
 * 为什么不用 git push：
 *   本机 Node 的原生 https 直连 api.github.com 会被防火墙重置（socket hang up），
 *   git 协议到 github.com:443 也超时。但 **curl 直连稳定**（实测 401/0.36s，握手快）。
 *   → 传输层改用 curl 子进程，完全绕开 Node 网络栈。
 *
 * 流程（Git Data API）：
 *   1. POST /git/blobs   每个文件一个 blob
 *   2. POST /git/trees   用 blob sha 列表构造 tree
 *   3. POST /git/commits 提交（带上一分支的 commit 作 parent，实现快进）
 *   4. PATCH /git/refs/heads/{branch} 推进分支
 *
 * 用法：node scripts/push-via-api.js <仓库目录> <owner/repo> [分支] [提交信息]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN');
  process.exit(1);
}

const DIR = path.resolve(process.argv[2] || '.');
const REPO = process.argv[3] || 'fengxi1998/pet-plugin-todo-reminder';
const BRANCH = process.argv[4] || 'main';
const MESSAGE = process.argv[5] || 'feat: publish plugin';

const API = 'https://api.github.com';

/**
 * 用 curl 发请求：Node 的 https 在本机被重置，curl 才稳。
 *
 * 网络策略（实测）：
 *   api.github.com 直连（--noproxy '*'）通常可用，但偶发 21s 超时；
 *   走本机 http_proxy 也可用。两种路径都可能抖动 → 直连失败自动回退走代理。
 *   请求体走临时文件传给 curl（-d @file）：Windows 命令行 32K 上限，
 *   大文件 base64 后拼进命令行会 ENAMETOOLONG。
 */
function curlOnce(args, useProxy) {
  const full = useProxy
    ? args.map((a) => (a === '--noproxy' ? '--proxy' : (a === '*' ? '' : a)))
        .filter((a) => a !== '')
    : args;
  return execFileSync('curl', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function request(method, apiPath, body) {
  const tmp = path.join(require('os').tmpdir(), 'gh-resp-' + process.pid + '-' + Date.now() + '.json');
  const base = [
    '-sS', '--noproxy', '*', '--max-time', '45',
    '-o', tmp,
    '-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: pet-plugin-publisher',
    '-H', 'Content-Type: application/json'
  ];
  let bodyFile = null;
  if (body !== undefined) {
    bodyFile = path.join(require('os').tmpdir(), 'gh-req-' + process.pid + '-' + Date.now() + '.json');
    fs.writeFileSync(bodyFile, JSON.stringify(body));
    base.push('-d', '@' + bodyFile);
  }
  base.push(API + apiPath);

  try {
    let lastErr = null;
    // 先直连，失败再走代理（各重试 2 次）
    for (const useProxy of [false, true]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          curlOnce(base, useProxy);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!lastErr) break;
    }
    if (lastErr) {
      const msg = String(lastErr.stderr || lastErr.message || lastErr);
      throw new Error(msg.split('\n')[0]);
    }

    const out = fs.readFileSync(tmp, 'utf8');
    let json = null;
    try { json = JSON.parse(out); } catch (e) { /* 非 JSON 响应 */ }
    if (json && json.message && !json.sha && !json.commit && !json.tree && !json.object) {
      throw new Error(`HTTP 错误: ${json.message}`);
    }
    return json || {};
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (e) { /* 忽略 */ } }
  }
}

/** 判断 HTTP 状态（用于区分 404 与其他错误），同样带直连/代理回退 */
function requestStatus(apiPath) {
  const tmp = path.join(require('os').tmpdir(), 'gh-status-' + process.pid + '.txt');
  const base = [
    '-sS', '--noproxy', '*', '--max-time', '45',
    '-o', tmp, '-w', '%{http_code}',
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: pet-plugin-publisher',
    API + apiPath
  ];
  try {
    let lastErr = null;
    for (const useProxy of [false, true]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const code = curlOnce(base, useProxy).trim();
          lastErr = null;
          return code;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!lastErr) break;
    }
    if (lastErr) throw lastErr;
    return '000';
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  }
}

function collect(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '.git' || name === 'dist' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collect(full, rel));
    else out.push({ path: rel, data: fs.readFileSync(full) });
  }
  return out;
}

(async function main() {
  const files = collect(DIR);
  console.log(`待推送 ${files.length} 个文件（已排除 .git / dist / node_modules）`);

  // 1) blob（base64 后走请求体文件，避免命令行长度上限）
  const entries = [];
  let n = 0;
  for (const f of files) {
    const blob = request('POST', `/repos/${REPO}/git/blobs`, {
      content: f.data.toString('base64'),
      encoding: 'base64'
    });
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    n++;
    if (n % 5 === 0) process.stdout.write(`  blob ${n}/${files.length}\n`);
  }
  console.log('blobs 全部创建');

  // 2) tree
  const tree = request('POST', `/repos/${REPO}/git/trees`, { tree: entries });
  console.log('tree: ' + tree.sha);

  // 3) commit（带旧 commit 作 parent 实现快进）
  const branchStatus = requestStatus(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const parents = [];
  if (branchStatus === '200') {
    const ref = request('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    if (ref.object && ref.object.sha) parents.push(ref.object.sha);
    console.log('分支已存在，快进更新（parent=' + ref.object.sha.slice(0, 7) + '）');
  } else {
    console.log('分支不存在，将新建');
  }

  const commit = request('POST', `/repos/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: tree.sha,
    parents
  });
  console.log('commit: ' + commit.sha);

  // 4) 推进分支
  if (branchStatus === '200') {
    request('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.sha,
      force: false
    });
  } else {
    request('POST', `/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/' + BRANCH,
      sha: commit.sha
    });
  }
  console.log('分支已推进: ' + BRANCH + ' → ' + commit.sha);
})().catch((e) => {
  console.error('推送失败: ' + e.message);
  process.exit(1);
});
