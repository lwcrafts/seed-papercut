# pipeline

分层 / 矢量化 / 拓扑制造检查管线代码目录：

- VLM 分层（Seed-Evolving 图像理解）
- 位图到 SVG 路径的矢量化
- 孤岛检测与连接桥拓扑算法
- 切割长度、闭合性、自相交等制造检查

## 已落地

- `svg-export.ts`（票 15）：LayerSet → 每层 mm 制切割 SVG（width/height 物理尺寸 +
  一致 viewBox、红 #FF0000 stroke 0.1mm = 切割线、fill=none 线模式、朴素 path、
  无 mask/filter/text、kerf 不烤进几何）+ README.txt + 零依赖 STORE ZIP（CRC32、
  UTF-8 文件名、不压缩）打包下载；`validateLayerSetExport` 在导出前做浏览器内
  数字自检（声明尺寸 == sizeMm、子路径全部闭合、无禁用元素、DOMParser 可解析且
  path 数 > 0），不过则禁用导出按钮并提示。
- 当前烘焙数据（xiake.json）没有刻痕线，导出包中不含蓝色刻痕层，包内 README 已说明。
- 现场重跑（票 16）：Node 烘焙逻辑（`scripts/bake.mjs`）的浏览器化模块链 ——
  - `ark-client.ts`：方舟 API 浏览器直连（拆层 `images/generations`，优先
    `response_format: b64_json` 绕开 TOS 图层下载的 CORS 不确定性；evolving
    `chat/completions` 强制 SSE 流式）+ 错误归类（key/限流/超时/网络/审核/api/parse）；
  - `raster.ts`：图层 alpha 按 bounding_box 缩放回原画布合成、阈值二值化、
    半分辨率闭运算 + 去噪点（与 bake.mjs 同参）；
  - `topology.ts` / `vectorize.ts`：与 `scripts/topology.mjs` / `vectorize.mjs`
    同源移植（中值滤波、开运算、缝隙闭合、窄缝修复、外框纸环、孤岛 Dijkstra
    加桥、缝隙两段式、imagetracerjs 矢量化）；
  - `live-rerun.ts`：全链路编排状态机，阶段对齐 UI 五段
    （拆层中/语义映射中/矢量化中/拓扑修复中/完成），产出与烘焙数据同 schema
    的 LayerSet v2；
  - `vendor/imagetracer.js`：imagetracerjs 1.2.6 浏览器版（Unlicense），
    vendor 补丁：UMD 尾部改为直接挂 `self`（Vite CJS interop 会误走
    `module.exports` 分支导致全局未赋值）。
  - evolving prompt/schema 经 `?raw` / JSON 内联打进 bundle，离线可用。
  - Key 只存页面内存（password 输入框 + 闭包变量），不落盘、不进日志；
    selftest 断言 localStorage/sessionStorage/cookie 无 Key 字样。
  - 真跑脚本：`npm run rerun:live`（`scripts/rerun-live-manual.mjs`，需真实
    Key，不走 CI），耗时产物落 `.bake/selftest/live-rerun/`。

## 数据契约

数据契约为 `src/types.ts` 中的 `LayerSet` / `Layer` / `FabCheck`。
烘焙产物见 `public/data/baked/xiake.json`，其 fabCheck 由拓扑算法真实计算填充；
现场重跑产出同一 schema，完成后直接替换预览器数据源。
