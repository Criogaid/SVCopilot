# 可解释音高技法统一执行计划

## 0. 文档信息

- 计划日期：2026-08-02
- 实施基线：`0c91ebf`（SV Copilot `0.9.0`）
- 裁决依据：`DEEP_RESEARCH_CROSS_VALIDATION_REPORT.md`
- 计划性质：整合并取代两份候选计划的执行顺序，不修改任何候选文档
- 实施风格：纵向闭环、严格 schema、同批迁移、无无效兼容层

## 1. 最终目标

在现有 SVCopilot 上增加一套可解释、可拟合、可验证的音高技法系统，使 LLM 能够：

1. 用音乐参数表达非对称滑音、起音/收音瞬态、overshoot、preparation 和颤音；
2. 把这些参数确定性编译到 SV2 的 `pitchDelta` 或 `PitchControlCurve`；
3. 在宿主实际插值和 computed pitch 上验证结果；
4. 根据一次观测生成安全的开环修正计划；
5. 在证据充分时，从 computed pitch 反推出可解释参数；
6. 只有真机证明单 Undo 与故障恢复成立时，才启用内部多轮闭环；
7. 所有正式写入继续满足一个高层 commit 最多一个用户 Undo、可读回、可补偿、可审计。

首个可发布里程碑不是“完整自动调音”，而是：

```text
snapshot
  -> semantic pitch plan
  -> review/dry-run
  -> one verified commit
  -> wait/compare
  -> optional one-step correction plan
```

## 2. 已冻结的架构决策

### 2.1 唯一写入权威

现有 Node MCP 服务继续独占：

- MCP schema 与 facade routing；
- Context/occurrence/note identity；
- canonical TechniqueIR；
- PlanRef/Artifact/ledger；
- ExecutionCoordinator；
- 宿主句柄、setter、Undo 边界、journal、verify、rollback。

任何外部计算 worker 都不得：

- 启动第二个 MCP；
- 连接 PIPE/Lua bridge；
- 持有 host handle；
- 直接写项目；
- 生成最终可提交 plan hash。

### 2.2 实现语言开放

不把 JavaScript、Python、Rust、WASM 或其他语言写成预设答案。

| 子系统 | 初始策略 | 原因 |
|---|---|---|
| TechniqueIR、前向模型、编译器 | Node | 与现有 planner/transaction 紧耦合，闭式计算足够小 |
| 五对角开环求解器 | Node | O(n) 带状 Cholesky 可独立验证，无需进程边界 |
| 有界鲁棒非线性拟合 | benchmark 决定 | 算法、性能、部署和许可都需要证据 |
| 宿主写入与回滚 | 仅 Node | 单一事务权威 |

如果最终选中外部 worker，它只是可替换的纯数值子进程，协议与语言无关。

### 2.3 公开 surface

前向技法不新增近义工具。扩展现有 facade operation：

- `sv_plan / plan_pitch_gesture`：前向技法规划；
- `sv_read / compare_computed_pitch`：继续承担客观结果比较；
- 新增 `sv_plan / plan_pitch_correction`：单步开环校正；
- 条件新增 `sv_read / analyze_pitch_techniques`：逆向拟合/分解；
- 闭环若通过门禁，新增 `sv_edit / calibrate_pitch`，否则不暴露。

不新增每个数学模型一个工具，也不让 TechniqueIR 成为需要 LLM 手写的大对象。

### 2.4 不做兼容包袱

当前处于开发阶段。schema 需要改时执行成对迁移：

- schema；
- normalize/handler；
- planner output/apply envelope；
- operation description；
- workflow guide/resource；
- unit/contract/MCP smoke tests。

同一语义只保留一个 canonical 字段；不保留 deprecated alias、双响应形状或隐式 fallback。

## 3. 明确非目标

- 不接受任意录音文件并做通用 F0 tracking；
- 不自动判断“听起来更好”；
- 不伪造程序化渲染；
- 不提供成功提交后的通用 restore token；
- 不依赖不存在的 `project_revision`；
- 不自动混用 `pitchDelta` 和 `PitchControlCurve`；
- 不在宿主语义未确认时同时使用原生颤音和显式正弦；
- 不复制 AVA、VibratoScope、Saitou 材料中的表达性代码；
- 不为研究原型牺牲现有 Artifact、token、事务和错误诚实性契约。

## 4. 目标数据流

```text
Range Context
  notes + tempo map + pitch surfaces + computed pitch
          |
          v
  TechniqueScope resolver
          |
          +------------------------+
          |                        |
          v                        v
  Forward TechniqueIR       Read-only fit adapter
          |                        |
          +-----------+------------+
                      v
               Canonical composer
                      |
                      v
          Surface compiler + budgets
                      |
                      v
               sealed Plan Artifact
                      |
                      v
       existing verified transaction service
                      |
                      v
        host interpolation postcondition
                      |
                      v
       computed-pitch wait / comparison
```

## 5. 核心内部契约

### 5.1 TechniqueIR v1

TechniqueIR 是内部 canonical 结构。LLM 通常只提交紧凑 gesture 参数；planner 展开 IR 并将详情放入
Artifact。

```json
{
  "schemaVersion": 1,
  "modelVersion": "pitch-techniques-v1",
  "scope": {
    "contextId": "ctx_...",
    "occurrence": 0,
    "expectedTargetGroupUuid": "..."
  },
  "timeDomain": "seconds",
  "pitchUnit": "cents_relative_to_score",
  "techniques": [
    {
      "id": "tech_0",
      "kind": "portamento",
      "anchors": {"fromNote": 4, "toNote": 5},
      "model": {
        "family": "richards_segment_normalized",
        "inflectionRatio": 0.58,
        "sharpness": 8,
        "asymmetryLogB": 0.3
      },
      "span": {"fromSeconds": 2.0, "toSeconds": 2.24}
    }
  ],
  "composition": {
    "rule": "sum_then_clamp",
    "maxAbsCents": 200,
    "overlapPolicy": "explicit_priority_then_request_order"
  },
  "target": {
    "surface": "pitchDelta",
    "interpolationEvidence": "captured_host_method"
  }
}
```

不变量：

- occurrence 使用 Context ordinal；
- note anchor 使用 `indexInGroup` 数字；
- 不存长 `noteId`；
- 不保存整组 fingerprints，只保存实际 anchor/guard；
- canonical IR 的秒 span 唯一，不再并存冲突 BLICK span；
- 每个 model family 有独立版本；
- composition 顺序确定，不能靠对象遍历偶然决定；
- 技法数、span、采样点和曲线幅度均有硬预算。

### 5.2 有限区间 Richards

内部提供两个不同函数，不混用名字：

```text
rawRichards(t, inflection, steepness, B)
richardsSegment(t, from, to, inflection, steepness, B)
```

编译用：

```text
q  = rawRichards(t)
q0 = rawRichards(from)
q1 = rawRichards(to)
u  = (q - q0) / (q1 - q0)
y  = y0 + (y1 - y0) * u
```

约束：

- `B = exp(asymmetryLogB)`，保证正数；
- `steepness = sharpness / durationSeconds`；
- `q1-q0` 过小则结构化拒绝；
- 上行/下行都严格命中端点；
- `u` 在数值容差内保持 `[0,1]`；
- 用稳定 `logaddexp`，极端参数不得 NaN/Inf。

### 5.3 二阶响应与首峰 transient

内部通用模型：

```ts
secondOrderImpulse({
  timeSeconds,
  onsetSeconds,
  naturalHz,
  dampingRatio,
  gain,
  polarity
})
```

覆盖三个数值区间：

- `zeta < 1-eps`：欠阻尼正弦形式；
- `abs(zeta-1) <= eps`：精确临界解；
- `zeta > 1+eps`：两个衰减指数之差。

公开音乐参数化只覆盖欠阻尼首峰：

```ts
transientFromFirstPeak({
  peakSemitone,
  peakTimeSeconds,
  dampingRatio,  // 0 <= zeta < 1-eps
  onsetSeconds,
  spanSeconds,
  tailPolicy     // reject | continuous_taper
})
```

不允许以首峰 schema 请求临界/过阻尼。未来若业务需要非振荡响应，另建明确 family。

### 5.4 等秒分析网格

原始 computed pitch capsule 继续保存：

```json
{
  "startBlick": 0,
  "intervalBlick": 176400000,
  "values": [60.0, null, 60.1],
  "tempoMarks": []
}
```

分析前生成：

```json
{
  "timeGrid": "uniform_seconds",
  "sampleRateHz": 100,
  "timeSeconds": [0.0, 0.01, 0.02],
  "values": [60.0, null, 60.1],
  "mask": [true, false, true],
  "resampling": {
    "method": "linear_within_finite_run",
    "maxGapSeconds": 0.03,
    "crossedTempoChange": true
  }
}
```

规则：

- 每个原始 frame 先用 tempo map 映射为绝对 seconds；
- 只在连续 finite run 内插值；
- 不跨 null gap、无声段或 processing gap；
- Hz 域算法只接收 uniform-seconds 数据；
- cents 中心统计可以使用原始 frame，但 provenance 必须区分。

### 5.5 FitWorker v1

语言无关请求：

```json
{
  "protocolVersion": 1,
  "requestId": "fit_...",
  "operation": "fit_richards_segment",
  "samples": {
    "timeSeconds": [0.0, 0.01],
    "cents": [0.0, 1.2],
    "mask": [true, true]
  },
  "initial": {},
  "bounds": {},
  "loss": {"kind": "huber", "scaleCents": 8},
  "limits": {"maxIterations": 200, "maxStarts": 16, "timeoutMs": 1000},
  "seed": 1
}
```

响应：

```json
{
  "ok": true,
  "engine": {"name": "...", "version": "..."},
  "termination": "converged",
  "parameters": {},
  "metrics": {
    "rmseCents": 2.1,
    "maxAbsCents": 6.0,
    "iterations": 31,
    "multiStartSpread": {}
  },
  "warnings": []
}
```

Node 收到结果后必须重新：

- 校验 schema/bounds/finite；
- 用 canonical Node forward model 复算曲线；
- 复算 metrics；
- 判定 identifiability；
- 生成最终 Artifact/hash。

## 6. 公开 JSON 契约草案

### 6.1 扩展 `plan_pitch_gesture`

```json
{
  "operation": "plan_pitch_gesture",
  "arguments": {
    "contextId": "ctx_...",
    "occurrence": 0,
    "gestures": [
      {
        "type": "transition",
        "from": 4,
        "to": 5,
        "width": {"seconds": 0.24},
        "shape": {
          "family": "richards_segment",
          "inflectionRatio": 0.58,
          "sharpness": 8,
          "asymmetryLogB": 0.3
        }
      },
      {
        "type": "transient",
        "note": 5,
        "intent": "overshoot",
        "peakSemitone": 0.28,
        "peakTimeSeconds": 0.065,
        "dampingRatio": 0.55,
        "onsetSeconds": 0,
        "spanSeconds": 0.28,
        "tailPolicy": "continuous_taper"
      }
    ],
    "target": {
      "surface": "pitchDelta",
      "vibratoSource": "auto"
    },
    "constraints": {
      "maxAbsDepthSemitone": 1,
      "maxAbsPeakSemitone": 1.5,
      "maxTotalPoints": 1200,
      "maxFitErrorCent": 1
    }
  }
}
```

`shape` 和 `transient` 使用 discriminated union，`additionalProperties:false`。不允许同一字段既是 string
又是 object 的长期双形态；迁移时一次性更新 schema/handler/guide/tests。

普通响应：

```json
{
  "ok": true,
  "status": "planned",
  "data": {
    "gestureCount": 2,
    "curveCount": 1,
    "pointCount": 84,
    "targetSurface": "pitchDelta",
    "compileErrorBudgetCent": 1
  },
  "apply": {
    "tool": "sv_patch_parameter_curves",
    "arguments": {"planRef": "a_...", "action": "dry_run"}
  },
  "detailRef": {},
  "warnings": []
}
```

### 6.2 `plan_pitch_correction`

```json
{
  "operation": "plan_pitch_correction",
  "arguments": {
    "contextId": "ctx_after",
    "occurrence": 0,
    "target": {
      "kind": "artifact",
      "artifactRef": "a_target"
    },
    "surface": "pitchDelta",
    "weights": {
      "minimumCoverage": 0.8,
      "excludeTransitions": false
    },
    "regularization": {
      "smoothnessLambda": 0.4,
      "magnitudeMu": 0.1,
      "maxAbsCorrectionCent": 50
    }
  }
}
```

输出一个 normal PlanRef；planner 本身只读、零 Undo、零 setter。

### 6.3 `analyze_pitch_techniques`

```json
{
  "operation": "analyze_pitch_techniques",
  "arguments": {
    "contextId": "ctx_...",
    "occurrence": 0,
    "models": ["richards_segment", "transient_first_peak", "vibrato"],
    "segmentation": {
      "mode": "score_informed",
      "boundaryLeadSeconds": 0.15,
      "boundaryLagSeconds": 0.3
    },
    "minimumCoverage": 0.8
  }
}
```

响应只内联：technique count、explained coverage、residual RMSE、confidence/identifiability、warnings。
samples、candidate windows、multi-start 和 rejected fits 全部进入 Artifact。

## 7. 阶段总览

| 阶段 | 交付物 | 可独立发布 | 阻塞来源 |
|---|---|---|---|
| P0 | 基线、corpus、host semantics profile v2 | 否 | 无 |
| P1 | 数学模型库 + 等秒时间网格 | 内部库 | P0 corpus |
| P2 | 现有 planner 扩展 + 双 surface 编译/保真 | 前向 MVP | P1、部分 host facts |
| P3 | 单步开环 correction | 是 | P1/P2、finite computed pitch |
| P4 | FitWorker benchmark 与选型 | 研究交付 | P1 corpus |
| P5 | 只读技法分析 | 预览版 | P4 选型 |
| P6 | 全链路真机 RC | RC | P2/P3/P5 |
| P7 | 单 Undo 有界闭环 | 条件发布 | 专门 host gate |
| P8 | 评估、文档、正式发布 | 正式版 | 所有目标阶段 |

## 8. P0：冻结基线、corpus 与宿主事实

### 8.1 基线

记录：

- commit、Node/Lua protocol、host version；
- routed operation 数与 facade surface；
- `npm test`、MCP smoke、Lua dispatcher 结果；
- 12-note/373-note 性能与 token 基线；
- current host profile hash。

不把测试数量硬编码到业务代码；将 P0 实测结果写入单独验收记录。

### 8.2 Synthetic corpus

至少覆盖：

- 上行/下行 endpoint-normalized Richards；
- `B=1` 与强非对称边界；
- 欠/临界/过阻尼通用响应；
- 欠阻尼 first-peak transient；
- 4/5.5/7/9 Hz 颤音；
- depth/rate/center drift；
- tempo change 前后等秒频率；
- null gap、全 null、低 coverage；
- overlap：portamento + transient + vibrato；
- 退化区间、采样过粗、极端参数；
- 固定 seed 的噪声和对抗 case。

每个 case 保存 input、dense truth、mask、invariants、tolerance、seed；不保存用户工程内容。

### 8.3 Host behavior profile v2

在现有 `tools/lib/host-behavior-profile.mjs` 增加版本化 semantics：

```text
automation.interpolationSetterAvailability
automation.boundaryInclusion
pitchControl.getValueAtInterpolationFamily
pitchSurfaces.pitchDeltaWithPitchControl
vibrato.hostEnvelopeWithExplicitPitchDelta
vibrato.hostEnvelopeWithExplicitPitchControl
vibrato.noteModulationInteraction
computedPitch.recomputeLatency
computedPitch.stabilityAfterWrite
computedPitch.staleNonEmptyAfterWrite
undo.multiCandidateSingleBoundary
```

证据来源必须区分：

- `official_doc`；
- `live_read_only`；
- `live_reversible_write`；
- 必要时 `human_observed_undo`。

任何 `confirmed` 必须绑定 evidence ID；不确定保持 `unknown/not_observable`。

具体 Automation 实例的 `getInterpolationMethod()` 结果属于 Context/plan evidence，不写成全局 host
profile 常量；profile 只记录 API 能力和经真机证明不会随实例变化的宿主语义。

### 8.4 可恢复宿主实验

所有写实验只在隔离临时轨/临时 group 上执行：

1. 基线快照和 hash；
2. 建立明确 Undo 边界；
3. 单变量写入；
4. 等待 computed pitch 稳定；
5. 读取曲线/computed pitch；
6. 恢复或删除临时对象；
7. 验证原工程 hash、handles、pending、Artifacts；
8. 手工需要时验证一次 Ctrl+Z 的范围。

### 8.5 P0 退出门禁

- 所有 profile 字段要么 confirmed，要么诚实 unknown；
- 原 fixture 内容恢复；
- 无泄漏 Artifact/handle/pending execution；
- host 不支持/全 null 时不得伪造结论；
- 双颤音和双 pitch surface 仍 unknown 时，后续 schema 必须拒绝相应组合。

## 9. P1：数学模型与秒域测量核心

### 9.1 模块

建议新增：

```text
server/src/pitch-techniques/ir.js
server/src/pitch-techniques/richards.js
server/src/pitch-techniques/second-order.js
server/src/pitch-techniques/vibrato.js
server/src/pitch-techniques/time-grid.js
server/src/pitch-techniques/compose.js
```

### 9.2 数值测试

Richards：

- 有限区间端点误差 <= `1e-12`；
- 上/下行单调；
- raw 拐点在归一化后不移动；
- `asymmetryLogB=0` 对称；
- 1000+ 属性随机 case 无 NaN/Inf；
- 极小 `q1-q0` 拒绝。

二阶模型：

- 三阻尼区间与高精度参考一致；
- `zeta -> 1` 左右连续；
- onset 前严格为 0；
- first-peak 仅接受欠阻尼；
- 首峰幅度/时间在采样误差内恢复；
- continuous taper 的值和一阶差分连续性达标。

时间网格：

- constant tempo 与原结果一致；
- tempo change 跨越时秒间隔恒定；
- 不跨 null gap；
- BLICK->seconds->BLICK roundtrip 在整数舍入预算内；
- 相同输入输出 canonical hash 相同。

### 9.3 P1 退出门禁

- 模型库零宿主依赖；
- corpus 全绿；
- property tests 固定 seed 且失败可复现；
- 模型输出单位显式；
- 无新运行时依赖。

## 10. P2：扩展现有 planner 与编译事务

### 10.1 成对迁移

同一批修改：

- `pitch-gesture-plan.js` normalize/instantiate/compile；
- `index.js` direct schema；
- compact facade 自动路由；
- `sv_describe` operation schema；
- workflow guide/resource；
- PlanRef capsule；
- planner、apply-schema、MCP smoke tests。

### 10.2 编译步骤

```text
strict request
  -> resolve occurrence/note anchors
  -> build canonical TechniqueIR
  -> compose dense seconds-domain curve
  -> enforce amplitude/span/point budgets
  -> map mandatory seconds anchors to integer BLICK
  -> simplify while preserving mandatory anchors
  -> predict error using captured interpolation
  -> seal one PlanRef apply envelope
```

mandatory anchors 至少包括：

- technique start/end；
- note boundary；
- Richards inflection；
- transient first peak；
- taper boundary；
- vibrato fade boundary 与局部 extrema；
- overlap policy 产生的切换点。

### 10.3 宿主后置验证

Automation commit：

1. 按现有 transaction 写点；
2. 在 mandatory anchors + adaptive midpoints 调 `Automation.get()`；
3. 与 dense target 比较；
4. 误差超 `maxFitErrorCent` -> `POSTCONDITION_FAILED`；
5. 进入现有 rollback 并验证恢复。

PitchControl commit：

1. 写入 curve/points；
2. 用 `PitchControlCurve.getValueAt()` 在同一网格采样；
3. 超 epsilon -> rollback。

不得用 `getLinear()` 代替实际宿主插值验证；它只能作为诊断对照。

### 10.4 颤音 source gate

根据 P0 profile 选择：

- `host_envelope`：只写已确认的 `vibratoEnv` 策略；
- `explicit_pitch_delta`：同一 Automation batch 内处理显式正弦和必要的 host envelope 抑制；
- `explicit_pitch_control`：只有跨 PitchControl+Automation 统一事务已实现并验收时开放；
- `auto`：只选择 profile 已确认安全的 source，否则结构化拒绝。

不允许“可能双重颤音但先写了再说”。

### 10.5 P2 退出门禁

- dry-run 零 setter/零 Undo；
- commit 最多一个用户 Undo；
- 端点、peak、inflection 和误差后置条件通过；
- 失败补偿后原曲线逐点/采样一致；
- unknown host combination 在 preflight 阶段零写入拒绝；
- 12-note/373-note 主响应符合 compact budget；
- dense detail 仅 Artifact、可分页/释放。

## 11. P3：单步开环 pitch correction

### 11.1 数学

令 `e = target - observed`，求：

```text
argmin_delta
  ||W^(1/2)(delta - e)||^2
  + lambda ||D2(u + delta)||^2
  + mu ||delta||^2
```

法方程是带宽 2 的对称正定系统。实现专用五对角 Cholesky，O(n) 时间/O(n) 内存。

### 11.2 业务规则

- null frame 权重为 0；
- coverage 低于门限则拒绝计划；
- mandatory technique anchors 不被平滑掉；
- correction 有绝对幅度、斜率和总点数上限；
- 只修一个声明 surface；
- planner 只读，不进入 ExecutionCoordinator；
- 输出 normal PlanRef，commit 仍由现有 mutation 完成；
- 每次 plan 明确 `iterationBasis:"single_open_loop_step"`。

### 11.3 测试

- n=1..2000 与稠密高精度参考解一致；
- lambda/mu 极值不奇异；
- null mask 不被当零误差；
- 恒等宿主 + 已知偏移时一步 RMSE 改善达到预注册门限；
- 无改善时返回 no-plan/insufficient evidence；
- plan apply 仍经过 live fingerprint 和 surface guard。

### 11.4 P3 退出门禁

- 一次正常 plan + dry-run + commit；
- 一个 Undo；
- correction 前后指标均可独立重算；
- 不需要闭环状态机即可发布。

## 12. P4：拟合后端 benchmark

### 12.1 候选

至少评估可实际分发的候选：

- Node 自研/成熟库；
- Rust 原生 helper 或 WASM；
- Python 3.10+ + SciPy；
- 其他满足协议和部署门禁的实现。

候选可在早期因许可证、无人维护或无法自动分发被淘汰，但必须留下证据。

### 12.2 同环境指标

同一 corpus、同一 seed、同一硬件，预热后至少 20 次：

| 指标 | 门禁 |
|---|---|
| canonical forward parity | 与 Node model 最大偏差 <= `1e-9` cents，或有批准的浮点解释 |
| clean recovery | >=95% case 在预注册参数容差内 |
| noisy/null recovery | curve RMSE、参数误差和拒绝率同时达标 |
| degenerate input | 100% 结构化拒绝，不 hang、不 NaN |
| deterministic replay | 同 seed canonical result hash 相同 |
| p95 single fit | 初始目标 <=100 ms |
| p95 phrase fit | 初始目标 <=1500 ms |
| timeout recovery | 超时后下一请求可正常服务 |
| crash isolation | worker crash 不影响 Node/host transaction |
| packaging | Windows/macOS 自动安装测试 |
| license | NOTICE 与再分发条件完整 |

性能阈值可在 P0 基线后修订一次；不得为偏好的语言倒推放宽。

### 12.3 选型

- Node 达标：选 Node；
- Node 不达标而 Rust/WASM 达标：选部署成本更低者；
- SciPy 明显胜出：使用可选或捆绑 worker，并在 doctor/capabilities 报告状态；
- 全部不达标：不公开逆向拟合，前向和开环照常发布。

## 13. P5：只读技法分析

### 13.1 流程

```text
captured computed pitch
  -> seconds timestamps
  -> uniform-seconds resampling
  -> score-relative cents + null mask
  -> baseline
  -> vibrato candidate + flatten
  -> score-informed transition windows
  -> Richards fit
  -> transient candidate/fit
  -> bounded joint refinement
  -> explained/residual metrics
```

### 13.2 分段策略

首版：

- note boundary 先验；
- lead/lag window；
- 一阶导数方向；
- minimum duration/cents movement；
- vibrato-flattened contour；
- confidence 与 rejected reason。

只有 host corpus 显示漏检或边界偏差超过门限，才评估 AVA 三态 HMM 或混合模型。

### 13.3 拒绝判据

- endpoint mismatch；
- inflection outside admissible span；
- effective transition shorter than sample resolution；
- degenerate interval/amplitude；
- robust fit 不优于线性/简单平滑 baseline；
- multi-start 成本接近但参数分散；
- low coverage/null fragmentation；
- overlapping techniques 无法识别；
- host sampling provenance 不完整。

命中时返回 `insufficient_evidence`，不输出看似精确的技法参数。

### 13.4 P5 退出门禁

- synthetic detection 与 recovery 达到预注册指标；
- 真实 host corpus 单独报告，不与 synthetic 混算；
- 全 null、pending、合法无声区不混淆；
- 分析零 setter/零 Undo；
- compact 响应不内联 dense samples/multi-start；
- solver/model/version/seed 可复现。

## 14. P6：真实宿主 RC 验收

### 14.1 场景

每个场景执行：

```text
snapshot -> plan -> dry-run -> isolated commit -> wait -> compare -> cleanup
```

覆盖：

1. constant-tempo Richards 上/下行；
2. tempo-change 跨越 transition/vibrato；
3. overshoot/preparation；
4. host-envelope vibrato；
5. explicit vibrato；
6. overlap composition；
7. `pitchDelta`；
8. `PitchControlCurve`；
9. 两种 surface 共存/拒绝；
10. shared target 两 occurrence；
11. 12-note 与 373-note；
12. full/partial/all-null；
13. stale Context/host reconnect；
14. worker timeout/crash；
15. interpolation postcondition failure + rollback。

### 14.2 记录

- requested dense vs compiled；
- compiled vs host interpolated；
- host interpolated vs computed pitch；
- seconds/BLICK roundtrip；
- points before/after simplify；
- coverage/stable polls/recompute latency；
- host calls、PIPE bytes、service/wall time；
- MCP serialized bytes、Artifact bytes/pages；
- Undo boundary calls 与用户 Undo steps；
- rollback evidence；
- human audition 记录，且明确 `human_only`。

### 14.3 P6 退出门禁

- 宿主插值误差 <= caller epsilon；
- tempo change 下 vibrato rate 偏差达到预注册门限；
- 所有正常 commit 一个 Undo；
- shared target 未确认时零写入；
- postcondition failure 恢复原值；
- timeout/disconnect 诚实区分 rolled_back/unknown；
- fixture、track、handles、pending、Artifact 全部清理。

## 15. P7：单 Undo 有界闭环（条件阶段）

### 15.1 发布前提

以下全部满足才实施公开 operation：

- P3 开环在真实 corpus 上方向正确；
- P0/P6 得到可用 recompute latency 与 stability；
- 真机确认多次内部写仍能被一个 Ctrl+Z 撤销；
- worker/bridge 超时路径能恢复或诚实 unknown；
- 用户交互延迟在预算内。

任何一项失败，P7 保持 `not-shipped`，不降级成 K 个用户 Undo 的产品行为。

### 15.2 状态机

```text
captured
  -> journaled
  -> undo_boundary_open
  -> candidate_applied
  -> observing
  -> candidate_verified
       -> accepted -> undo_boundary_closed
       -> rejected -> restoring_previous -> restored -> next_candidate
       -> uncertain -> outcome_unknown
```

### 15.3 事务伪代码

```ts
await coordinator.exclusive(async (scope) => {
  const journal = await captureOriginal(scope);
  await scope.newUndoRecord();

  let accepted = journal;
  for (let iteration = 0; iteration < limits.maxIterations; iteration += 1) {
    const candidate = solveNext(accepted, observation);
    await writeCandidate(scope, candidate);
    await verifyHostCurve(scope, candidate);

    const observation = await waitStableComputedPitch(scope, deadlines);
    if (accept(objective(accepted), objective(observation))) {
      accepted = await captureCurrent(scope);
      if (stopCondition(observation)) break;
      continue;
    }

    await restore(scope, accepted);
    await verifyRestored(scope, accepted);
    reduceStep();
  }

  await scope.newUndoRecord();
  return verifiedSuccess(accepted, {expectedUserUndoSteps: 1});
});
```

硬规则：

- iteration 内禁止调用 `newUndoRecord()`；
- 最多 3 个 candidate；
- 第一个 setter 前 journal 完整；
- 每次拒绝必须恢复并读回；
- 最终只有 accepted state 留在宿主；
- setter 后 timeout/disconnect 无法证明状态时返回 `outcome_unknown`；
- 不返回以后可调用的 restore token；
- Context 在写入后立即失效。

### 15.4 故障注入

- 第一候选写失败；
- 第一候选 postcondition 失败；
- 第一次 processing timeout；
- 第二候选写失败；
- restore 中途失败；
- close boundary 失败；
- bridge disconnect after setter；
- worker crash before/after candidate；
- final read-back mismatch。

### 15.5 P7 退出门禁

- 每种可恢复失败最终 hash 与原始一致；
- 不可证明失败均为 `outcome_unknown`；
- 一次 Ctrl+Z 恢复 operation 前状态；
- `expectedUserUndoSteps:1` 与人工观察一致；
- median objective 改善达到预注册门限；
- p95 wall time、host calls 和 PIPE bytes 在预算内。

## 16. P8：评估、文档与发布

### 16.1 可复现 Artifact

保存：

- model/solver/compiler/host profile versions；
- canonical request/IR/plan hashes；
- raw and uniform-seconds sampling metadata；
- fitted parameters、bounds、initials、seed；
- dense target/compiled/host/readback/residual curves；
- rejected candidates 和 reason；
- performance/transport/Undo/rollback evidence。

普通响应不返回这些大对象。

### 16.2 人类试听

继续复用现有 audition/compare：

- 自动定位、solo、播放、auto-stop、恢复；
- 结果只声明 `perception:"human_only"`；
- preference 可以写入外部研究日志/Artifact；
- 不把“播放成功”解释为“技法更自然”。

### 16.3 发布文档

面向使用者只解释：

- 可以表达哪些音乐技法；
- 哪些操作只规划、哪些会写入；
- 如何 dry-run/commit；
- 一个 Undo 的范围；
- computed pitch 与 human audition 的区别；
- host capability/unknown 的含义。

开发证据留在专项文档，不塞进 consumer README。

## 17. 横向质量门禁

### 17.1 Schema

- 顶层与嵌套对象 `additionalProperties:false`；
- discriminated union 按 discriminator 只验证对应分支；
- 单位写入字段名；
- unknown parameter 不 fallback；
- range/context/note identity 使用 ordinal/index；
- schema、handler、description、guide、tests 同批提交。

### 17.2 响应与 token

- compact 主响应目标 <= 8 KiB；
- 不重复 contextId/occurrence 前缀；
- per-technique/per-curve evidence 默认聚合；
- dense samples 和 solver trace 使用 Artifact；
- Artifact 大于安全阈值只允许分页入口；
- detailRef 记录 issued/read/pageReads/bytes/releasedWithoutRead。

### 17.3 事务

- dry-run 零 setter、零 Undo；
- no-change 零 setter、零 Undo；
- commit 一个用户 Undo；
- journal 在首个 setter 前完成；
- verification 使用独立宿主读取；
- rollback 逆序且读回；
- timeout 后不把未知状态报告为 unchanged。

### 17.4 性能

每个阶段至少记录：

- validation/context/target/preflight/compile/write/verify/processing/rollback；
- dispatcher/coordinator queue 可观测性；
- host method count/totalMs；
- PIPE bytes；
- MCP serialized chars/bytes；
- Artifact bytes/pages；
- 12-note/373-note median/p95。

### 17.5 测试层

```text
unit math
  -> property/invariant
  -> synthetic recovery
  -> schema/contract
  -> planner/apply envelope
  -> transaction/fault injection
  -> MCP smoke
  -> Lua dispatcher
  -> live reversible host acceptance
  -> human audition record
```

## 18. 提交策略

建议按可回滚纵向切片提交：

1. host profile v2 schema + probes + fixtures；
2. Richards raw/segment + tests；
3. second-order/internal first-peak + tests；
4. uniform-seconds grid + compare migration；
5. TechniqueIR + planner schema/handler/guide paired migration；
6. surface compiler + host interpolation postcondition；
7. open-loop correction solver + operation；
8. fit adapter + benchmark harness；
9. selected backend + read-only analyzer；
10. live RC fixes；
11. conditional closed-loop；
12. release evidence/docs。

每个 commit 必须：

- 单一可解释目的；
- 测试全绿；
- 不产生 `api-docs`/fixture 时间戳噪声；
- 不夹带 `.serena`、`.codegraph`、`.codex`、本地 docs 或 `.gitignore` 变更；
- 若 schema 变更，公开链路同批闭环。

## 19. 需求追踪矩阵

| 需求 | 阶段 | 验收证据 |
|---|---|---|
| Saitou overshoot/preparation | P1/P2 | analytic/property + host readback |
| 非对称 Richards transition | P1/P2 | endpoint/inflection + host interpolation |
| 秒域颤音跨 tempo | P1/P2/P6 | uniform-seconds + rate error |
| 防双重颤音 | P0/P2 | host profile + rejected unsafe combination |
| 双 pitch surface 诚实性 | P0/P2 | interaction profile + transaction guard |
| 曲线压缩误差 | P2 | host `get`/`getValueAt` postcondition |
| 单步反馈 | P3 | synthetic + one apply/Undo |
| 逆向参数恢复 | P4/P5 | benchmark + synthetic/host corpus |
| 单 Undo 闭环 | P7 | fault injection + one Ctrl+Z |
| 可复现研究 | P0/P8 | canonical hashes + Artifact |
| LLM token 效率 | 全阶段 | serialized bytes + Artifact metrics |

## 20. 最终完成定义

“前向技法 MVP 完成”需要：

- Richards/transient/vibrato 模型通过数值门禁；
- 现有 planner 能生成一个 sealed PlanRef；
- dry-run 零副作用；
- commit 一个 Undo；
- 宿主实际插值误差达标；
- unsafe vibrato/surface 组合在 preflight 拒绝；
- compact 响应和 Artifact 分页达标。

“分析与开环完成”需要：

- computed pitch 等秒分析正确；
- FitWorker benchmark 有记录且选型可解释；
- analysis 对低证据诚实拒绝；
- one-step correction 可独立验证改善；
- 所有只读 operation 零 setter/Undo。

“闭环完成”需要：

- 不是 K 个外部 commit 的编排；
- 是单 operation、单 coordinator、单 journal、单 Undo；
- 所有失败点经过故障注入；
- 一次 Ctrl+Z 恢复原始状态；
- 断连时不谎报恢复；
- 真实 host corpus 的收益和成本达到预注册门限。

若闭环门禁失败，项目仍可凭前向规划、宿主保真、只读分析和单步开环作为完整可发布能力；不得为了勾选
路线图而降低 Undo 或恢复契约。

## 21. 立即下一步

从 P0 开始，按以下顺序执行：

1. 建立 synthetic corpus 与模型 tolerance；
2. 扩展 host profile v2，但先保留所有未知事实为 unknown；
3. 用隔离临时轨完成 `vibratoEnv`、双 pitch surface、插值和 computed-pitch 重算实验；
4. 并行实现 endpoint-normalized Richards 与拆分后的二阶模型；
5. 证据和模型都通过后，再迁移 `plan_pitch_gesture` 的公开 schema。

这条顺序避免先写出一个数学上漂亮、宿主中却会双重颤音或违反插值误差的 planner。
