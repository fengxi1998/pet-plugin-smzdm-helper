#!/usr/bin/env node
/**
 * 交叉校验：registry-submit/<id>/registry-entry.json 必须与 ZIP 内 manifest 严格一致。
 *
 * 宿主安装管线（runtime.js installFromZip）会校验：
 *   - expectId 与包内 manifest.id 一致
 *   - expectVersion 与包内 manifest.version 一致
 *   - 包内 requestedGrants 不得超出登记的 permissions
 * 三项任一不符 → 宿主拒装，且表现为「安装失败」而非明确原因。
 * 这个脚本在提交 PR 前把同样的三项提前验掉。
 *
 * 用法：node scripts/verify-registry-entry.js <registry-entry.json> [zip路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const HOST = process.env.PET_PLUGIN_HOST_DIR
  || path.resolve(__dirname, '../../../repack3/tree/core/plugin-runtime');
const { loadManifest, requestedGrants } = require(path.join(HOST, 'manifest.js'));
const { extractZip } = require(path.join(HOST, 'zip.js'));

const entryPath = process.argv[2];
if (!entryPath) {
  console.error('用法: node scripts/verify-registry-entry.js <registry-entry.json> [zip路径]');
  process.exit(1);
}

const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
const ROOT = path.resolve(__dirname, '..');
const zipPath = process.argv[3] || path.join(ROOT, 'dist', 'plugin.zip');

let failed = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };

console.log('登记条目: ' + entryPath);
console.log('安装包:   ' + zipPath);
console.log('');

// ---- 登记表条目自身的字段合规（SCHEMA.md）----
const REQUIRED = ['id', 'name', 'author', 'repo', 'version', 'download', 'sha256', 'permissions'];
for (const f of REQUIRED) {
  entry[f] !== undefined && entry[f] !== '' ? ok('必填字段存在: ' + f) : bad('必填字段缺失: ' + f);
}
if (!/^github:.+/.test(entry.author)) bad('author 必须是 github:<用户名> 形式: ' + entry.author);
if (!/^[^/]+\/[^/]+$/.test(entry.repo)) bad('repo 必须是 owner/repo 形式: ' + entry.repo);
if (!/^[0-9a-f]{64}$/i.test(entry.sha256)) bad('sha256 必须是 64 位十六进制: ' + entry.sha256);
if (entry.description && entry.description.includes('\n')) bad('description 必须单行');
if (entry.description && [...entry.description].length > 200) bad('description 超过 200 码点');
if (entry.meshTier !== null && entry.meshTier !== undefined) bad('无官方 relay 授权时 meshTier 应为 null');

// ---- 与 ZIP 内 manifest 交叉核对 ----
if (!fs.existsSync(zipPath)) {
  bad('找不到安装包: ' + zipPath);
} else {
  const buf = fs.readFileSync(zipPath);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  actual === entry.sha256
    ? ok('sha256 与安装包一致: ' + actual)
    : bad('sha256 与安装包不一致：登记 ' + entry.sha256 + ' / 实际 ' + actual);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-registry-verify-'));
  try {
    extractZip(buf, tmp);
    const srcDir = fs.existsSync(path.join(tmp, 'manifest.json')) ? tmp : null;
    if (!srcDir) {
      bad('包内顶层没有 manifest.json');
    } else {
      const m = loadManifest(srcDir);
      m.id === entry.id ? ok('id 一致: ' + m.id) : bad('id 不一致：包内 ' + m.id + ' / 登记 ' + entry.id);
      m.version === entry.version
        ? ok('version 一致: ' + m.version)
        : bad('version 不一致：包内 ' + m.version + ' / 登记 ' + entry.version);
      if (m.description !== entry.description) {
        bad('description 与包内不一致：\n    包内 ' + m.description + '\n    登记 ' + entry.description);
      } else {
        ok('description 与包内一致');
      }

      const allowed = new Set(entry.permissions.map(String));
      const over = requestedGrants(m).filter((p) => !allowed.has(p));
      over.length === 0
        ? ok('包内权限未超出登记范围（' + requestedGrants(m).length + ' 项）')
        : bad('包内权限超出登记范围，宿主会拒装: ' + over.join('、'));

      const missing = entry.permissions.filter((p) => !requestedGrants(m).includes(p));
      missing.length === 0
        ? ok('登记权限与包内完全对应，无多填')
        : bad('登记里多填了包内未申请的权限: ' + missing.join('、') + '（会被宿主视为无意义授权）');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('');
if (failed) {
  console.log('校验失败：' + failed + ' 项不通过');
  process.exit(1);
}
console.log('全部校验通过：宿主会接受这个登记条目与安装包');
