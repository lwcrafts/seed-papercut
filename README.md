# 纸雕光影灯分层图纸提取器 / Layered Papercut Shadow Box

把一张平面插画，变成一套真的能做出来的纸雕光影灯图纸：6 层激光切割 SVG、浏览器里的 3D 灯箱预览、逐层制造检查。

本仓库是 **Seed-2.1-pro 第三期 case 征集**的参赛作品。纯静态 Web 应用（GitHub Pages），没有后端。

## 它做了什么

输入一张「纸雕灯设计效果图」，管线自动产出：

- 6 层 mm 制激光切割 SVG（红色 0.1mm 切割线、朴素 path，LightBurn / Illustrator 可直接打开），打包为零依赖 ZIP（`<sceneId>-L1..6.svg` + 装配说明 README.txt）
- Three.js 灯箱预览：四机位、爆炸分解、LED 色温与亮度调节、单层穿透
- 逐层制造检查：孤岛数 / 连接桥 / 切割总长 / 最小缝隙 / 通过与否，全部直读烘焙产物里的真实算法结果
- 现场重跑：观众填自己的方舟 Key，可在浏览器里对预置场景全链路重跑（约 5–7 分钟）

预置场景：**侠客策马**（烘焙结果提交在 `public/data/baked/`）。站点带数据驱动的场景切换骨架：当前只有 1 个场景时切换器自动隐藏；加新场景 = 烘焙出一份 JSON + 在 `src/app/main.ts` 的场景清单里加一条。

## 管线

```
拆层    Seed-2.1-pro（doubao-seedream-5-0-pro-260628）layer_decomposition
        → z0 满版底图 + 11± 层透明 PNG（name / description / bounding_box）
映射    Seed-Evolving（doubao-seed-evolving，模板 prompt + strict json_schema，SSE 流式）
        → 11± 层归并为 L1–L6 语义分层
蒙版    各层 alpha 阈值二值化（闭运算 r=1 + 去小噪点，bbox 回位合成）
矢量化  imagetracerjs（vendored，闭合路径）
拓扑    孤岛检测 + 自动加桥（4 邻接 BFS + Dijkstra + DSU 链式，桥宽 3mm，
        缝隙红线 1mm 两段式核算）→ fabCheck
导出    每层 mm 制 SVG（红 0.1mm 切割线）+ 零依赖 STORE ZIP
预览    Three.js 灯箱（纸张挤出 / 多光源 / 木框 / 爆炸分解）
```

拆层与语义映射跑在火山方舟上（完整模型 ID 见 `src/pipeline/ark-client.ts`）；蒙版、矢量化、拓扑修复与制造检查全部是本地确定性算法——制造结论不交给模型自报，由几何算法核算。

## 本地开发

```bash
npm install
npm run dev              # vite 开发服务器
npm run build            # tsc --noEmit + vite build → dist/
npm run selftest:browser # headless 自测（需先 build）：装配合成 / fabCheck / ZIP 导出 / 重跑状态机 / 文案红线 / README
npm run check:copy       # 文案红线词表检查（已并入 selftest）
```

## 烘焙新场景（bake）

`scripts/bake.mjs` 从场景原图走完整管线，产出 `public/data/baked/<sceneId>.json` 并把场景图放进 `public/scenes/`：

```bash
npm run bake -- xiake          # 全链路；已有中间产物则复用（不重复调用模型）
npm run bake -- xiake --fresh  # 忽略缓存重新调用（拆层约 2 分钟 + 语义映射约 4–9 分钟，产生你方舟账号下的模型用量）
```

Key 读取顺序：环境变量 `ARK_API_KEY` → 仓库外 `v2/.env`。只进内存，不打印、不落盘。中间产物缓存在 `.bake/<sceneId>/`（已 gitignore）；响应存档脱敏后落在 `.scratch/seed-papercut/research/bake-run/`。

## 现场重跑（rerun:live）

页面上的「用你的 Key 现场重跑」：观众填自己的方舟 Key，浏览器直连方舟接口，对预置场景重跑同一管线，五段进度实时显示（拆层中 / 语义映射中 / 矢量化中 / 拓扑修复中 / 完成）。Key 只保存在页面内存里：不写入本地存储、不经过任何中间服务器（站点本来就没有服务器）；失败时自动回退烘焙结果并显著标注「演示数据」。

本地手动真跑（不走 CI）：

```bash
npm run build
ARK_API_KEY=xxx node scripts/rerun-live-manual.mjs   # 各段耗时与截图落 .bake/selftest/live-rerun/
```

## GitHub Pages 部署

站点部署在项目页路径 `https://lwcrafts.github.io/seed-papercut/`（vite `base: '/seed-papercut/'`）。推送 `main` 后，`.github/workflows/deploy.yml` 自动 build + deploy 到 GitHub Pages。

## 数据契约：LayerSet v2

类型定义见 [`src/types.ts`](src/types.ts)，烘焙示例见 [`public/data/baked/xiake.json`](public/data/baked/xiake.json)：

```jsonc
{
  "schemaVersion": 2,
  "sceneId": "xiake",
  "sourceImage": "scenes/xiake.jpg",
  "viewBox": "0 0 2048 1536",
  "sizeMm": { "width": 200, "height": 150 },   // 成品物理尺寸
  "layers": [ // 恒 6 项，L1 靠 LED → L6 靠观者
    { "index": 1, "name": "…", "depth": 0.05, "pathD": ["M …"],
      "fabCheck": { "islands": [], "bridgesAdded": [], "cutLengthMm": 0, "minGapMm": 0, "pass": true } }
  ],
  "pipeline": { "decomposeModel": "doubao-seedream-5-0-pro-260628",
    "mapModel": "doubao-seed-evolving", "zItems": 12, "mapSource": "evolving", "bakedAt": "…" }
}
```

页面同时兼容载入 legacy v1 JSON（含 `svgPath` / `svgContent` 的旧格式）。

## 文案红线

站点与导出物不使用极限词与导流词；模型对外口径统一写作 **Seed-2.1-pro / Seed-Evolving**（代码注释与文档的技术上下文保留完整模型 ID）。词表固化在 `scripts/check-copy.mjs`，改动文案后跑 `npm run check:copy`。

## 致谢

- [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) — 位图矢量化（vendored 于 `src/pipeline/vendor/` 与 `scripts/vendor/`）
- [three.js](https://threejs.org/) — 灯箱 3D 预览
- 火山方舟 Seed-2.1-pro / Seed-Evolving — 拆层与语义映射

## License

[MIT](./LICENSE)
