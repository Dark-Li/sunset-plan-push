# Sunset Push · 朝霞 / 晚霞预测图定时推送到微信

把 [Sunset Plan](https://sunset-plan.vercel.app)（朝晚霞定量预报）的**同一套评分模型**搬到 Node 里，
在 GitHub Actions 上定时跑：抓取指定地点的实时气象数据 → 打分 → 用 **Canvas 1:1 复刻站点的「生成预测图」** →
上传图片 → 通过 [Server酱](https://sct.ftqq.com/) 推送到微信。

```
Open-Meteo（ECMWF / GFS / ICON / 空气质量）
        │
        ▼
lib/model.js   ← 评分模型（从站点前端 bundle 原样提取，见下文）
        │
        ▼
lib/card.js    ← 组装“分享预测图”入参
        │
        ▼
lib/render.js  ← Canvas 绘制 750×H @2x PNG（与站点版式一致）
        │
        ├─→ gh-pages 分支（GitHub Pages）→ https://<owner>.github.io/<repo>/out/xxx.png
        ▼
lib/serverchan.js → sctapi.ftqq.com（SCT） / <num>.push.ft07.com（SC3） → 微信
```

## 快速开始

1. **Fork / 上传本仓库**到你的 GitHub（私有仓库也可以，Actions 免费额度足够）。
2. 在仓库 **Settings → Secrets and variables → Actions** 新增 Secret：
   `SERVERCHAN_SENDKEY` = 你的 SendKey
   （[sct.ftqq.com](https://sct.ftqq.com) 拿 `SCT...`；[sc3.ft07.com](https://sc3.ft07.com) 拿 `sctp...`，两种都支持）。
3. 修改 `config.json`，填上你要关注的地点。
4. 仓库 **Settings → Pages**：Source 选 **Deploy from a branch**，分支选 `gh-pages`，目录 `/ (root)`。
   > 第一次运行结束后 `gh-pages` 分支才会出现，出现后再来设置即可；图片路径是 `out/xxx.png`。
5. **Actions → Sunset Push → Run workflow**，`dry_run` 先留 `true` 跑一遍，确认图片和日志都正常，
   再取消勾选跑一次真实推送。

## 配置 `config.json`

地点**只需写名字**，经纬度会自动查：

```jsonc
{
  "locations": [
    { "name": "重庆" },
    { "name": "云南 大理" }        // 同名地方多时加省份
    // 也可以继续手写坐标（精确到某个山头很有用）；两者都写时以坐标为准
    // { "name": "洱海东岸", "latitude": 25.72, "longitude": 100.24 }
  ],
  "pushes": [
    // 决定“哪些地点、哪些霞”参与推送；具体哪天发由下面的 schedule 决定
    { "place": "重庆", "mode": "both" },
    { "place": "云南 大理", "mode": "sunset" }
  ]
}
```

### 名字定位怎么工作

1. 先查 Open-Meteo 地名接口（站点城市搜索同源）；
2. 中文地名库有缺漏时（例如「大理」只会返回四川泸州的一个同名村镇、「林芝」查不到），
   自动改用 OSM / Photon 补齐；
3. 结果按“可信度”排序：**城市 / 区县** 优先，机场、火车站、社区这类同名设施会被排除，
   村镇级结果会打印 ⚠ 警告；
4. 找不到可信结果时**直接报错并列出近似候选**，绝不悄悄用错坐标。

几个写法示例：

| 写法 | 结果 |
|---|---|
| `重庆` | 重庆 · 重庆市 (29.56, 106.56) |
| `大理` | 大理市 · 云南省 (25.60, 100.25) |
| `新疆 喀什` | 喀什 · 新疆 (39.47, 75.99) |
| `西藏 林芝` | 林芝市 · 西藏 (29.65, 94.36) |
| `Chongqing` | 重庆 · 重庆市 (29.56, 106.56) |

每次运行会打印解析结果，方便核对：

```
[地点] 「重庆」→ 重庆（重庆市 · 重庆市 · 中国）29.56026,106.55771
```

> 如果要精确到某个观景点（湖边、山顶），建议还是直接写 `latitude`/`longitude`。

多个地点会合并成**多次** Server酱 推送（每个地点每个霞别一条），方便按地点区分。
注意 Server酱 免费额度每天有限制，地点多的时候建议只保留你最关心的。

## 每天两次推送

`.github/workflows/sunset-push.yml` 里默认两班（**cron 是 UTC**，已换算成北京时间）：

| 班次 | 时间 | cron (UTC) | 推送内容 |
|---|---|---|---|
| 午后 | **13:00** | `0 5 * * *` | **当天晚霞** + **明天朝霞** |
| 晚间 | **20:00** | `0 12 * * *` | **明天朝霞** + **明天晚霞** |

> GitHub 定时任务在整点前后容易排队延迟，实际触发可能晚十几分钟；单次失败不会自动重试，
> 需要补发时到 **Actions → Sunset Push → Run workflow** 选 `slot` 手动跑一次即可（不会重复推送）。

### 怎么改推送内容

在 `config.json` 的 `schedule` 里改，`day` 只认 `today` / `tomorrow`：

```jsonc
"schedule": {
  "afternoon": {
    "label": "午后",
    "tasks": [
      { "mode": "sunset",  "day": "today"  },   // 当天晚霞
      { "mode": "sunrise", "day": "tomorrow" }  // 明天朝霞
    ]
  },
  "evening": {
    "label": "晚间",
    "tasks": [
      { "mode": "sunrise", "day": "tomorrow" }, // 明天朝霞
      { "mode": "sunset",  "day": "tomorrow" }  // 明天晚霞
    ]
  }
}
```

- 删掉 `schedule` 字段 = 使用上面这套默认安排；
- `tasks` 里加 `"place": "沈阳"` 表示该任务只针对这个地点，不加则对所有地点生效；
- 每条任务会单独推送一条消息（标题会写明「今天/明天」）。

### 改推送时间

必须同时改两处：cron 时间 + 对应的工作流里 `SLOT` 映射。比如想把午后班改到 12:30（UTC 04:30）：

```yaml
- cron: '30 4 * * *'   # 原 '0 5 * * *'
```

工作流里按 cron 字符串判断班次，位置在「确定推送参数」这一步：

```bash
case "$SCHEDULE" in
  "0 5 * * *")   SLOT=afternoon ;;
  *)             SLOT=evening ;;
esac
```

> 想按当地日出日落定时，可先跑 `node scripts/cron-helper.mjs 41.79 123.43` 换算。
## 本地运行

```bash
npm install

npm run preview                    # 午后班预览：当天晚霞 + 明天朝霞（不发送）
node scripts/push.mjs --slot evening --dry-run   # 晚间班预览：明天朝霞 + 明天晚霞
node scripts/push.mjs --slot evening --dry-run --place 沈阳   # 只看某个地点
node scripts/probe.mjs sunset 2026-10-20         # 只看评分数据

# 真实推送（PowerShell）
$env:SERVERCHAN_SENDKEY='SCTxxxx'
node scripts/push.mjs --slot evening
```

生成的图片在 `out/` 目录下，文件名形如 `沈阳-sunset-2026-10-19.png`（地点-霞别-日期）。

## 实现说明

### 评分模型是怎么来的

站点的「生成图片」**完全在前端用 Canvas 绘制**，没有服务端渲染接口。所以这里是直接复刻：

- `lib/extract.mjs`：从线上 bundle 按标记切出与评分相关的压缩代码片段（原样保留，便于核对）；
- `lib/clean.mjs`：去掉 bundle 里重复出现的同名函数、处理同名变量遮蔽；
- `lib/model.raw.js`：**自动生成**，请勿手改（`Y2/PX/NX` 等函数与线上逐字节一致）；
- `lib/model.js`：把压缩变量映射成可读名字，并用 Node `fetch` 复刻站点的请求链路：
  - 主预报 `models=ecmwf_ifs025`（云量、温湿、位势高度、降水等）
  - `gfs_seamless`（能见度、边界层高度、湿度廓线）
  - `icon_seamless`（模式对比）
  - `air-quality-api` 的 `aerosol_optical_depth`
  - **沿太阳方位 16 个距离点扫描云量**，得到云边界距离 D（`0/25/50/…/600 km`）
- `lib/satellite.js`：**国家卫星气象中心（NSMC）实况红外云图**扫描，对应站点的 `G6()`

评分包含 8 个维度（云况、云边界、通透度、阴蔽、可见性、降雨、时长、色彩），
以及霞光穿透距离、可见时段、反射色（550nm 透过率 → sRGB）等。

### 与线上站点对齐的几个关键点

复刻过程中有三处很容易踩坑，都按站点实际行为处理：

1. **实况云图会覆盖数值预报的云边界**：站点用卫星图沿太阳方向找最近的一片云，
   若比数值预报更近就以其为准。`boundaryDistanceKm` 本身**保持数值预报值**，
   实况值通过 `satelliteCloserBoundaryKm` / `satelliteBoundaryKm` 单独传入，由 `Y2` 内部决定生效——
   提前把 D 改成实况值会让评分偏高（重庆实测会从 57 变成 61）。
2. **「模式报晴空」走另一套云底高度**：三层云量之和 `< 8` 时，站点不使用 ECMWF 位势高度反演值，
   而用湿度廓线/分层云带/露点估算的默认高度，这会显著影响「时长」「色彩」两个维度。
3. **晴空分支的卫星参数**：此时站点传入的是「正对太阳方向」的扫描结果，且不叠加 closer 覆盖。

已验证结果（2026-10-18，与网页逐个数字核对）：

| 城市 | 霞别 | 本地 | 网页 |
|---|---|---|---|
| 重庆 | 晚霞 | 57 一般 · H5.6 · D175 · 13分25秒 | 57 一般 · H5.6 · D0(实况) · 13分25秒 ✓ |
| 重庆 | 朝霞 | 19 较差 · H10.7 · 18分33秒 | 19 较差 · H10.7 · 18分33秒 ✓ |
| 北京 | 晚霞 | 70 良好 · 时长 10分40秒 | 70 良好 · 时长 10分40秒 ✓ |
| 上海 | 晚霞 | 10 极差 · 8 项维度全同 | 10 极差 ✓ |
| 成都 | 晚霞 | 64 良好 · 8 项维度全同 | 64 良好 ✓ |

> 站点「逐项指标」里的云底高度与「参数微调」里的 H 可能显示两个值（前者是展示口径、
> 后者是实际参与评分的值），本地预测图统一取展示口径，与网页顶部的指标一致。

### 和线上站点的差异

- 站点在部分晴空场景还会叠加一次「卫星分支高度」，这类边界情况下本地可能与该展示值不完全一致，
  但**评分结果（总分与 8 个维度）保持一致**。
- 图片版式、配色、文字与站点一致；只把字体栈里的 `system-ui` 补成中文字体，
  否则 GitHub Actions 的 Linux 环境会渲染不出中文（工作流里已安装 `fonts-noto-cjk`）。

### 推送内容

标题形如 `上海 10月20日晚霞 67 分 · 良好`，正文是 Markdown：

- 评分 / 评级 / 时刻 / 可见时段 / 色彩 / 云状 / 云底 / 云边界 / 通透度 / AOD
- 关键提示（例如“霞光深入距离小于云边界距离，本地头顶无火烧云”）
- 预测图（`![](https://<owner>.github.io/<repo>/out/xxx.png)`）与大图链接

### 图片为什么走 GitHub Pages

Server酱 的 `desp` 只支持 **https 外链图片**，而 Actions 里的本地文件它访问不到。
所以工作流的顺序是：
**生成图片 → 提交到 `gh-pages` → 轮询等图片真的能访问（最多 4 分钟）→ 再推送**。
如果 GitHub Pages 一直没部署成功，推送仍会发出，只是正文里少了图片。

> Fork 后如果使用私有仓库注意：私有仓库的 GitHub Pages 对公开访问可能受限，图片可能无法被 Server酱 抓取，
> 此时可改用 Cloudflare R2、imgur 等其它图床，只要把 `IMAGE_BASE_URL` 换成对应地址即可。

### 其它可调项

| 环境变量 | 说明 |
|---|---|
| `SERVERCHAN_SENDKEY` | 必填，SendKey |
| `IMAGE_BASE_URL` | 图片公网前缀；工作流会自动设置成 GitHub Pages 地址 |
| `PUSH_SLOT` | `afternoon` / `evening`，决定本次发哪几天（也可用 `--slot`） |
| `CONFIG_FILE` | 指定其它配置文件路径 |
| `IMAGE_WAIT_MS` | 等待图片可用的最长时间（默认 240000） |

命令行参数：`--slot afternoon|evening`、`--mode both|sunset|sunrise`、`--place 名称`、
`--dry-run`、`--score-threshold N`（低于 N 分不生成图片）。

## 目录结构

```
config.json                  地点与推送规则
scripts/push.mjs             主流程（抓取 → 评分 → 出图 → 推送）
scripts/wait-images.mjs      等待图片公网可用
scripts/cron-helper.mjs      日出日落 → cron 换算
scripts/probe.mjs            只打印评分数据
scripts/regress.mjs          多城市回归对比（排查与网页的差异时用）
lib/model.js                 数据抓取 + 评分入口
lib/model.raw.js             从站点 bundle 提取的算法片段（自动生成）
lib/satellite.js             NSMC 实况云图扫描
lib/card.js                  预测图入参
lib/render.js                Canvas 绘制预测图
lib/serverchan.js            Server酱推送
lib/geocode.js              地名 → 经纬度（只写名字也能用）
.github/workflows/           Actions
```

> 排查时可用：
> `node scripts/regress.mjs` 输出多城市评分；对照网页的数值即可看出是数据还是模型的问题。

### 关于地点

现在只写名字即可，程序会自动定位并打印解析结果。如果想手动指定：

- `name` 是**展示名**（推送标题、图片文件名都用它）；
- 若同时写了 `latitude`/`longitude`，以坐标为准，`name` 可任意取（比如「洱海东岸」）。

> 历史提醒：早期版本必须手写坐标，且 `name` 只是标签——把“重庆”写成上海的坐标会拿到上海的天气。
> 现在按名字定位已不会出现这类错配；但手动写坐标时仍需自行确认正确。

## 免责声明

预报与评分算法版权属于 Sunset Plan 原作者（站点作者标注为 “Genie”），本项目仅为个人化推送整合，
请遵守原站使用条款；数据来自 Open-Meteo（非商业使用免费）。预测仅供参考。
