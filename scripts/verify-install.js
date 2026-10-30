#!/usr/bin/env node
/**
 * 用宿主**真实**的安装管线校验本地构建出的 plugin.zip：
 *   1) sha256 校验（对应宿主 installFromZip 第 1 步）
 *   2) 解压 → 定位 manifest.json（第 2 步，含「单个顶层目录」回退）
 *   3) loadManifest 校验 + requestedGrants 权限比对（第 3 步，与市场安装同一逻辑）
 *   4) 校验 ZIP 顶层结构符合宿主预期
 *
 * 目的：在推 GitHub 之前就把「宿主会拒装」的原因全部提前暴露出来。
 * 用法：node scripts/verify-install.js [zip路径]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.PET_PLUGIN_HOST_DIR
  || 'H:/ai/work/2026-10-29-06-59-14/repack3/tree/core/plugin-runtime';

const zipPath = process.argv[2] || path.join(ROOT, 'dist', 'plugin.zip');
let failed = 0;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };

// ---- 复用宿主的真实实现 ----
const { loadManifest, requestedGrants } = require(path.join(HOST, 'manifest.js'));
const { extractZip } = require(path.join(HOST, 'zip.js'));

function singleRootDir(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('__MACOSX'));
  if (items.length !== 1 || !items[0].isDirectory()) return null;
  const sub = path.join(dir, items[0].name);
  return fs.existsSync(path.join(sub, 'manifest.json')) ? sub : null;
}

console.log('宿主实现目录: ' + HOST);
console.log('校验安装包:   ' + zipPath);
console.log('');

if (!fs.existsSync(zipPath)) {
  console.error('找不到安装包: ' + zipPath);
  process.exit(1);
}

const buf = fs.readFileSync(zipPath);

// ---- 1) sha256 ----
const actual = crypto.createHash('sha256').update(buf).digest('hex');
const sumFile = zipPath + '.sha256';
if (fs.existsSync(sumFile)) {
  const declared = fs.readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0];
  declared === actual ? ok('sha256 与 .sha256 文件一致: ' + actual)
                     : bad('sha256 不一致：声明 ' + declared + ' / 实际 ' + actual);
} else {
  ok('sha256 (无 .sha256 参照文件): ' + actual);
}

// ---- 2) 解压 + 定位 manifest ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-verify-'));
try {
  extractZip(buf, tmp);
  ok('解压成功（宿主 extractZip 通过路径穿越与符号链接防护）');

  const hasTopManifest = fs.existsSync(path.join(tmp, 'manifest.json'));
  const srcDir = hasTopManifest ? tmp : singleRootDir(tmp);
  if (!srcDir) {
    bad('包内找不到 manifest.json（顶层没有，且不是「单个顶层目录」布局）');
  } else {
    ok(hasTopManifest ? 'manifest.json 位于 ZIP 顶层（宿主首选布局）'
                      : 'manifest.json 位于单个顶层目录内（宿主回退布局，同样支持）');
  }

  // ---- 3) manifest 校验 + 权限比对 ----
  const manifest = loadManifest(srcDir);
  ok('loadManifest 通过: id=' + manifest.id + ' version=' + manifest.version);

  // 登记表条目（模拟 pet-plugin-registry 中该插件的登记）
  const registryEntry = {
    id: manifest.id,
    version: manifest.version,
    permissions: manifest.permissions   // 登记表权限必须 ≥ 包内声明
  };
  const allowed = new Set(registryEntry.permissions.map(String));
  const over = requestedGrants(manifest).filter((p) => !allowed.has(p));
  over.length === 0
    ? ok('权限比对通过：包内声明未超出登记范围（' + requestedGrants(manifest).join(', ') + '）')
    : bad('权限超出登记范围，会被宿主拒装: ' + over.join('、'));

  if (registryEntry.id !== manifest.id) bad('登记表 id 与包内不一致');
  if (registryEntry.version !== manifest.version) bad('登记表 version 与包内不一致');

  // ---- 4) 入口文件存在性 ----
  const entries = [];
  if (manifest.entry?.tool) entries.push(manifest.entry.tool);
  if (manifest.entry?.panel?.src) entries.push(manifest.entry.panel.src);
  if (manifest.entry?.dashboardBlock?.src) entries.push(manifest.entry.dashboardBlock.src);
  if (manifest.entry?.character) entries.push(manifest.entry.character);
  let missing = 0;
  for (const rel of entries) {
    fs.existsSync(path.join(srcDir, rel))
      ? ok('入口存在: ' + rel)
      : (bad('入口缺失: ' + rel), missing++);
  }
  if (!entries.length) bad('manifest 未声明任何入口');

  // ---- 5) description 规范 ----
  const cps = [...(manifest.description || '')].length;
  const singleLine = !(manifest.description || '').includes('\n');
  (cps >= 1 && cps <= 200 && singleLine)
    ? ok('description 单行 ' + cps + ' 码点，符合 ≤200 规范')
    : bad('description 不合规：' + cps + ' 码点，单行=' + singleLine);

  // ---- 6) 解压后目录结构一览 ----
  const list = [];
  (function walk(d, p) {
    for (const n of fs.readdirSync(d).sort()) {
      const rel = p ? p + '/' + n : n;
      const st = fs.statSync(path.join(d, n));
      if (st.isDirectory()) walk(path.join(d, n), rel);
      else list.push(rel);
    }
  })(srcDir, '');
  console.log('');
  console.log('包内文件 (' + list.length + '):');
  for (const f of list) console.log('  - ' + f);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failed) {
  console.log('校验失败：' + failed + ' 项不通过');
  process.exit(1);
}
console.log('全部校验通过：宿主安装管线会接受这个包');
