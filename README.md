# 值得买助手 · 吐梨邦插件

接入**什么值得买开放平台**，让桌宠帮你盯优惠：好价搜索、降价监控、全网口碑，
早晨自动播报今日好价，关注的商品降价了冒泡提醒。

| 项目 | 值 |
|---|---|
| 插件 ID | `smzdm-helper` |
| 当前版本 | 0.1.1 |
| 最低宿主版本 | 0.29.3（Windows 11 实测） |
| SDK 契约 | `apiVersion: 1` |
| Node 内建模块 | **使用**（`nodeAccess: true`，原因见下方披露章节） |
| 联网域名 | **仅** `gw-openapi.zhidemai.com` |
| 凭据 | 什么值得买开放平台 Key，经宿主加密仓（`pet.secrets`）保存，**不明文落盘** |

## 功能

三类能力：

| kind | 入口 | 做什么 |
|---|---|---|
| `tool` | `tool/index.js` | 常驻层：注册 4 个 Agent 工具、定时巡检关注商品降价、早晨播报今日好价、状态徽标 |
| `panel` | `panel/index.html` | 管理台：设置（填 Key / 早报开关）、好价（今日好价列表）、监控（关注商品列表）三个页签 |
| `dashboard-card` | `block/index.html` | 看板卡片：今日好价条数、监控商品数、降价提醒入口 |

### tool 注册的 4 个工具（宿主 Agent 可直接调用）

| 工具 | 参数 | 行为 |
|---|---|---|
| `smzdm_好价搜索` | `keyword?`、`page?` | 搜索今日好价条目，可按关键字过滤 |
| `smzdm_商品搜索` | `keyword`、`page?` | 按关键字搜索商品 |
| `smzdm_口碑查询` | `keyword`、`page?` | 查询该商品的全网口碑 |
| `smzdm_型号查询` | `keyword`、`page?` | 按型号查价格区间 |

对宿主 Agent 说「帮我搜下 XX 的好价」「XX 的口碑怎么样」即可。

### 提醒机制

- **降价巡检**：定时检查监控列表里的商品，价格下降即冒泡提醒并更新卡片。
- **早晨播报**：每天定时汇总今日好价，用 `ai.chat` 改写成宠物口吻后播报。
- **无 Key 时**：徽标显示「设置」直达面板，查询类工具返回明确的缺凭据提示，不静默失败。

## 申请的权限（10 项）

| 权限 | 用途 |
|---|---|
| `storage` | 监控列表、插件设置与早报缓存存在插件私有存储，卸载即随之删除 |
| `secrets` | 什么值得买开放平台 Key 存宿主加密仓，**不明文落盘**（policy 第 4 条） |
| `pet` | 早报播报与降价提醒时让桌宠冒泡、播放动作，并设置宠物脚下的状态徽标 |
| `ui` | 打开与关闭插件面板 |
| `events` | 面板与常驻层之间同步设置与监控列表变更 |
| `scheduler` | 定时巡检关注商品降价、按天播报早报 |
| `tools` | 向宿主 Agent 注册 4 个查询工具 |
| `dashboard` | 在看板挂载本插件的卡片区块 |
| `ai`（实验） | 把好价与口碑条目改写成宠物口吻的播报文案 |
| `net:gw-openapi.zhidemai.com` | 什么值得买开放平台网关，**唯一访问的域名** |

**未申请、也不使用的**：`clipboard`、`appearance`、`files`、`character:read`、`errands`、`account:*`。

### `ai`（实验）的使用边界

走**宿主自带的大模型**（`pet.ai.chat`），**不读取也不需要任何 API Key**，
凭据只有用户自己的什么值得买 Key（走 `secrets`）。
只用于把结构化条目改写成播报文案，不参与数据获取。
宿主未配置大模型时静默降级为原始文案，不影响查询与提醒。

## Node 运行时能力披露（`nodeAccess: true`）

**为什么需要**：什么值得买开放平台的 MCP 端点是**有状态会话**——
`Mcp-Session-Id` 只在 `initialize` 的**响应头**里下发，后续每次请求都必须带回；
而宿主冻结的 `pet.net.fetch` 只回传 `{ status, body, contentType }`，**读不到响应头**，
无法维持会话（会话缺失/过期会得到 400 / 404）。
因此网络层改用 Node 运行时自带的**全局 `fetch`** 直接请求该域名。

**用到了什么**：
- 全局 `fetch` —— 仅用于请求 `gw-openapi.zhidemai.com` 这一个域名
- `process.env.SMZDM_MCP_ENDPOINT` —— 可选覆盖端点，**仅供本地测试指向 mock server**，
  生产环境不设置时使用默认端点

**没有用到**：文件系统、进程管理、子进程、剪贴板、shell 等任何其他 Node 能力。
代码中**没有** `require()` 任何 Node 内建模块（`fs` / `child_process` / `http` 等），
唯一的 `require` 是插件自己的相对模块 `./mcp-client`。

**对用户的影响**：宿主安装弹窗会按最坏情况措辞提示该插件可访问你的电脑。
这是因为「声明 + 披露制」下 `nodeAccess: true` 的统一提示策略，
不代表本插件实际会读写你的文件。

## 数据与隐私

- **凭据**：什么值得买 Key 只经 `pet.secrets` 存进宿主加密仓，不写进 `storage`、
  不写进日志、不进任何明文文件。
- **出网数据**：只向 `gw-openapi.zhidemai.com` 发送查询关键词与商品标识，
  以及用于鉴权的 `x-api-key` 请求头。**不上传**本地文件、剪贴板、系统信息或任何其它数据。
- **落盘数据**：监控列表（商品 id / 名称 / 价格）与设置存在插件私有存储，卸载即随之删除。

## 安装

**市场安装（推荐）**：桌宠「设置 → 插件中心 → 插件市场」搜索「值得买助手」。

**手动安装（开发调试用）**：下载 `plugin.zip` 解压后，在
「设置 → 插件中心 → 开发者模式 → 手动安装 → 从文件夹安装」选择解压目录。
手动安装不经过审核，只用于本地调试。

装好后需在插件面板的「设置」页签里填写自己的什么值得买开放平台 Key。

## 开发

```bash
# 校验 manifest、打包清单与政策红线（含联网域名核对与 nodeAccess 披露校验）
node scripts/build.js

# 只校验不产出（CI 的 PR 检查用）
node scripts/build.js --check-only

# 校验标签与 manifest.version 一致（CI 发布前用）
node scripts/build.js --check-only --check-tag v0.1.1

# 用宿主真实安装管线校验产出的包（解压 / manifest / 权限比对）
node scripts/verify-install.js
```

`scripts/build.js` 在打包前会强制检查：

- manifest 字段合法（ID 格式、`x.y.z` 版本号、description 单行且 ≤200 码点）
- manifest 声明的入口全部在打包清单里，且清单文件全部存在
- **政策红线扫描**：Node 内建模块 `require`、动态 `require`、`eval`/`new Function`
- **联网域名核对**：代码里出现的每个域名都必须已在 `manifest.permissions` 声明
  `net:<hostname>`，未声明即构建失败（变量形式的 URL 会回溯全包域名一起核对）
- **nodeAccess 披露校验**：一旦代码里出现 `process.env` 等 Node 运行时能力，
  `manifest.nodeAccess` 必须为 `true`，否则构建失败

ZIP 顶层直接是 `manifest.json`（宿主安装管线的解析要求），文件顺序固定、时间戳归零，
保证同样的源码打出同样的包与摘要。

## 验证记录

| 项目 | 结果 |
|---|---|
| 宿主 manifest 校验 | 通过（宿主 `loadManifest` 真实路径） |
| 宿主安装管线校验 | `scripts/verify-install.js` 全项通过 |
| 联网域名核对 | 代码中仅 `gw-openapi.zhidemai.com`，与 `net:` 声明精确一致 |
| 凭据处理 | Key 仅走 `pet.secrets`，`storage` 中无任何凭据字段 |
| 面板与卡片真渲染 | Chromium 实渲染三个页签 + 卡片，零运行时异常 |
| emoji / CSP 门禁 | 通过（无 emoji、无远端脚本与资源） |

## 已知取舍

- **需要自己的开放平台 Key**：插件不内置凭据。什么值得买开放平台需自行申请，
  没 Key 时插件会明确提示而不是静默失败。
- **有状态会话需要重建**：MCP 会话过期（404/400）时会重新 `initialize` 再重试一次。
- **早报依赖宿主大模型**：未配置大模型时播报文案退回原始条目，可读性略差但功能不受影响。

## 许可证

MIT，见 [LICENSE](LICENSE)。
