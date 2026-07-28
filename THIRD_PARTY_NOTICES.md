# THIRD_PARTY_NOTICES

本文件记录 SV Copilot 参考过的外部代码来源、许可证与采用方式。当前发布**不包含任何第三方
运行时依赖、包、子模块或被复制的源代码**。

## Hrauroras/SV2-Script（MIT）

- 来源：https://github.com/Hrauroras/SV2-Script
- 研究提交：`f0ba9509d490007ef5956864366e5f73ad308bc9`
- 许可证：MIT License, Copyright (c) 2026 ResonantPsyche
- 采用方式：**clean-room 重写，未复制任何代码或常量**。依据 P1-C GOAL
  （`docs/P1C_PITCH_CONTROL_EXECUTION_GOAL.md` §6）的实施政策，仅把以下作为**行为与数学需求
  的参考样本**，接口与实现均由本项目独立设计：
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
- 未采用（GOAL 明确禁止继承）：SidePanel UI、WidgetValue 状态管理、模式切换批量删除、
  任意改写重叠对象、未限幅三次插值、朴素自动调性检测、同组复制和声、主观"避免不和谐"规则。
- 由于未复制具有表达性的代码或大量常量，依据 GOAL §6.2 无需在本项目分发其许可证文本；
  此处记录来源以备审计。若未来复制其表达性代码或常量，必须在此附完整 MIT 许可证与版权通知。
