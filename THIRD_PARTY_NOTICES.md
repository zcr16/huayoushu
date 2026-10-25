# 第三方归属与素材来源

本文件说明花有数使用的第三方部分。根目录 MIT 许可的适用范围见 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)。原许可证与声明保留于 `licenses/`，不得因本项目采用 MIT 而删除或替换。

## 软件依赖

| 项目 | 用途 | 随仓库保留的声明 |
| --- | --- | --- |
| [Apache ECharts](https://github.com/apache/echarts) | 图表 | [Apache-2.0 许可证](licenses/ECharts-LICENSE.txt)、[NOTICE](licenses/ECharts-NOTICE.txt) |
| [zrender](https://github.com/ecomfe/zrender) | ECharts 绘图依赖 | [BSD 3-Clause 许可证](licenses/zrender-LICENSE.txt) |
| [tslib](https://github.com/microsoft/tslib) | 编译辅助依赖 | [上游许可证](licenses/tslib-LICENSE.txt) |

实际安装版本由 `package-lock.json` 锁定。开发工具、HarmonyOS SDK、模型服务及其运行环境分别适用各自的条款，不由本项目再授权。

## 鲸鱼娘动画

来源：[zhu1090093659/dsh-pet](https://github.com/zhu1090093659/dsh-pet)，采用资源版本 `e2c86922ec07aa72c94184642aae73687c443bed` 下的 `assets/whale-refined/spritesheet.webp`。

花有数从该图集中抽取动画帧，并生成界面缩略图；没有引入完整桌宠运行程序。对应文件包括：

- `harmonyos/entry/src/main/resources/rawfile/assistants/whale.png`
- `harmonyos/entry/src/main/resources/rawfile/assistants/motion/whale-*.png`
- 网页人物资源中嵌入的鲸鱼娘图像

保留的 [素材清单](licenses/dsh-pet/whale-refined-pet.json) 声明 `license: MIT`，并将素材描述为基于鲸鱼娘形象的 AI 辅助二次创作及精修变体。上游仓库 [LICENSE](licenses/dsh-pet/LICENSE) 为 Apache-2.0，另保留其 [THIRD_PARTY_NOTICES](licenses/dsh-pet/THIRD_PARTY_NOTICES.md)。后者是上游原始声明，涵盖的其他角色不代表花有数也打包了这些角色。

本仓库记录上游声明，不据此声称已经核清原始角色设计的全部权利，也不声称获得 DeepSeek 官方授权。鲸鱼娘在本应用中是非官方参考形象。

## GPT、Claude 参考形象

对应资源包括 `assistants/robot.png`（GPT 选项）、`assistants/star.png`（Claude 选项）及网页中的嵌入图像。图像依据参考角色图经 AI 生成，应用中的摇摆、跳动和道具效果由本地界面代码实现。

现有来源记录不足以确定参考角色设计的作者授权或完整版权链。本项目不将这些图像及底层角色设计纳入自有代码的 MIT 许可，不声称获得 OpenAI 或 Anthropic 的授权，也不将其描述为官方人物形象。使用或发布这些素材前，应单独核实所需权利；可将其替换为权利明确的自有素材。

## 署名与更正

如发现来源、署名或许可范围有误，请通过仓库 Issue 提供对应文件、来源链接与说明，便于核查和修正。提交材料请勿包含访问令牌、私人账单或设备身份信息。
