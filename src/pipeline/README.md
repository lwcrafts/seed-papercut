# pipeline

分层 / 矢量化 / 拓扑制造检查管线将在后续票中落地于此目录：

- VLM 分层（Seed-Evolving 图像理解）
- 位图到 SVG 路径的矢量化
- 孤岛检测与连接桥拓扑算法
- 切割长度、闭合性、自相交等制造检查

当前阶段仅有数据契约：`src/types.ts` 中的 `LayerSet` / `Layer` / `FabCheck`。
示例烘焙数据见 `public/data/baked/example-layers.json`，其 `fabCheck` 字段全部为
`null`，待真实算法接入后填充，UI 不展示任何硬编码核验结论。
