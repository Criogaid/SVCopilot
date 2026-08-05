# THIRD_PARTY_NOTICES

本文件记录 SV Copilot 的第三方运行时依赖、外部代码参考、许可证与采用方式。

## Node.js 运行时依赖

直接依赖由 `server/package.json` 声明，当前安装和验证的版本如下：

| 包 | 版本 | 许可证 | 用途 |
|---|---:|---|---|
| `@modelcontextprotocol/sdk` | `1.29.0` | MIT | MCP server、stdio transport 与协议类型 |
| `ajv` | `8.20.0` | MIT | 公开 operation 输入 schema 校验 |

`server/package-lock.json` 记录完整传递依赖闭包、精确版本、来源和完整性散列；各 npm 包随附的
许可证元数据和许可证文件是分发时的权威文本。本项目没有为音高拟合新增第三方运行时依赖：
`node-bounded-richards/1` 使用现有 Node.js 运行时和本仓库实现。

## Hrauroras/SV2-Script（MIT）

- 来源：https://github.com/Hrauroras/SV2-Script
- 研究提交：`f0ba9509d490007ef5956864366e5f73ad308bc9`
- 许可证：MIT License, Copyright (c) 2026 ResonantPsyche
- 采用方式：**clean-room 重写，未复制任何代码或常量**。依据本项目的 clean-room 实施政策，
  仅把以下作为**行为与数学需求的参考样本**，接口与实现均由本项目独立设计：
  - `ManualMode.js`：transition/attack/release/vibrato 的参数模型、用 TimeAxis 把秒/Hz 转为
    BLICK、相邻音符边界思路 → 启发 `server/src/pitch-gesture-plan.js`（有界不超调插值，独立实现）。
  - `PitchFixBrush.js`：computed pitch → PitchControlCurve 的数据流与创建/插入/清理的 API
    顺序、所有权标签意识 → 启发 `server/src/bake-computed-pitch.js` 与
    `server/src/pitch-control-patch.js`（含 read-back、journal、补偿回滚、覆盖阈值，独立实现；
    外部脚本无这些）。
  - `Harmony.js`：14 类音阶目录的存在性与广义 2–7 度、方向、八度位移的表达 → 启发
    `server/src/harmony-plan.js` 的音阶目录与广义 interval。音程集合由标准乐理独立给出；
    外部脚本的朴素音阶成员计数/自动调性检测**未被采用**（本项目沿用 Krumhansl-Schmuckler，
    且显式 scale 只接受调用者批准）。
- 未采用（本项目明确禁止继承）：SidePanel UI、WidgetValue 状态管理、模式切换批量删除、
  任意改写重叠对象、未限幅三次插值、朴素自动调性检测、同组复制和声、主观"避免不和谐"规则。
- 由于未复制具有表达性的代码或大量常量，依据上述政策无需在本项目分发其许可证文本；
  此处记录来源以备审计。若未来复制其表达性代码或常量，必须在此附完整 MIT 许可证与版权通知。

## 检查多音字发音.js（未声明许可证）

- 来源：本地参考合集 `插件合集/歌词处理/检查多音字发音.js`
- 作者：陌辞寒（ly50247@126.com）
- 参考版本：`1.2`
- 许可证：原脚本未声明许可证，合集说明也未授予统一的再分发许可。
- 采用方式：经仓库所有者明确决定，提取并整理其 122 个常见多音字和 410 个唯一
  X-SAMPA 到无调拼音映射，形成 `server/src/mandarin-reading-data.js`。未复制脚本的 UI、
  剪贴板或宿主遍历实现。原表重复的 `j iAU` 同时映射到 `yao` 与 `yo`；本项目固定为
  `yao`，避免把该汉语拼音音节错误报告为 `yo`。
- 分发边界：本记录只陈述来源，不构成许可证授予。公开再分发这些常量前仍需由发布者确认
  权利状态或用可再分发的独立数据替换。
