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

## 数据契约

数据契约为 `src/types.ts` 中的 `LayerSet` / `Layer` / `FabCheck`。
烘焙产物见 `public/data/baked/xiake.json`，其 fabCheck 由拓扑算法真实计算填充。
