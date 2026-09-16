# 纸雕光影灯分层图纸提取器 / Layered Shadow Box Papercut

从一张纸雕光影灯的设计效果图出发，提取可用于分层切割制作的图纸，并在浏览器中以 3D 灯箱预览分层装配、灯光与爆炸分解效果。

本仓库是 **Seed-2.1-pro 第三期 case 征集** 的参赛作品代码仓库。

## 模型分工

- **Seed-Evolving（VLM 图像理解）**：负责对设计效果图进行视觉分层——识别前中后景、输出每层的名称、景深、描述与图层遮罩草案。
- **本地几何算法（浏览器 / Node 侧执行）**：负责遮罩矢量化、SVG 路径生成、孤岛检测、连接桥补接、切割长度 / 闭合性 / 自相交等制造检查。模型不输出制造结论，核验由确定性算法完成。
- **Three.js 预览器**：消费管线产出的 `LayerSet` JSON，渲染带木框、EVA 垫片、LED 背光的分层纸雕灯箱。

> 当前版本为骨架与预览器移植：分层与制造检查算法尚未接入，示例数据中的 `fabCheck` 字段全部为 `null`，页面不展示任何硬编码的核验结论。

## 数据契约（LayerSet）

类型定义见 [`src/types.ts`](src/types.ts)，示例数据见 [`public/data/baked/example-layers.json`](public/data/baked/example-layers.json)。

```jsonc
{
  "sceneId": "example-horse-rider",
  "sourceImage": "",
  "viewBox": "0 0 800 600",
  "layers": [
    {
      "index": 1,
      "name": "前景边框与垂落松蔓",
      "depth": 0.1,
      "description": "…",
      "pathD": "M 0 0 …",
      "fabCheck": {
        "islands": null,
        "bridgesAdded": null,
        "cutLengthMm": null,
        "closed": null,
        "selfIntersecting": null,
        "pass": null
      }
    }
  ]
}
```

## 目录结构

```
src/
  preview/    Three.js 灯箱预览器（挤出纸张、多光源、四机位、爆炸分解）
  pipeline/   分层 / 矢量化 / 拓扑制造检查（后续票填充）
  app/        页面 UI
  types.ts    LayerSet schema（TS 类型）
public/
  data/baked/ 烘焙的 LayerSet 示例 JSON
  scenes/     预置场景原图
```

## 本地开发

```bash
npm install
npm run dev
```

构建：

```bash
npm run build
npm run preview
```

站点部署在 GitHub Pages 项目站路径下（base = `/seed-papercut/`），推送 `main` 后由
`.github/workflows/deploy.yml` 自动构建部署。

## License

[MIT](./LICENSE)
