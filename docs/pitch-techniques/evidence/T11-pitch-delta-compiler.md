# T11 `pitchDelta` 编译器

采集时间：`2026-08-03`

## 实现

`server/src/pitch-techniques/pitch-delta-compiler.js` 只接受已由 T09 规范化并冻结的 TechniqueIR、
带 content hash 的 T10 composition，以及冻结的 notes / tempo map / baseline / mandatory-anchor
evidence。它不读取宿主，也不创建 Artifact、session 或 MCP response。

portamento 通过集中 reference oracle 重建 F1b transition：严格检查相邻 BLICK、同一边界的秒域映射、
对称 span、score-step 范围和可表示的四个 BLICK 锚点。输出中 boundary-before 固定为 boundary 的前一个
本地 BLICK，boundary-at 固定为后音 onset；两者不会因秒域数组在同一时间戳只能保存一个值而被合并。
Richards transition 还要求并保留 inflection anchor。

每个 finite run 先用捕获的 baseline cents 与组合 contribution cents 预合成，再量化到 `1e-6` cent，
编码为既有 `dense-table-v1` replace points。null gap 变成同一 `action:"dry_run"` mutation 中的多个不重叠
curve requests，绝不跨 gap 插值。每条 curve 受现有 2,000-point transaction 限制，整份计划受 4,000-point
预算限制。输出始终标记 `pending_t12_host_interpolation`，要求 T12 使用实际 `Automation.get()` 做后置验证。

## 离线证据

| 断言 | 结果 |
|---|---|
| F1b 上下行、linear/Richards | 160 个固定 seed case 的双侧 contribution 跳变抵消 score step，绝对目标连续 |
| 必保锚点 | start、boundary-before、boundary-at、end；Richards 再包含 inflection；缺失、错时或错跳变均拒绝 |
| 边界拒绝 | rest/gap、overlap、等音高、短音符、大音程、过粗 BLICK 分辨率分别返回结构化错误 |
| baseline 预合成 | composition 若已有 final vector 则必须与 baseline + contribution 一致；final 越界在写入前拒绝 |
| null gap | 编译为两个不重叠 replace curves，不桥接 gap |
| 373-note fixture | 一个 1,492-point curve，使用 dense table 后 mutation 小于等于 16 KiB，零 host call |
| 确定性 | 相同 IR 与冻结 evidence（含 notes/anchors 置换）产生相同 plan hash 与逐字节 mutation |

## 验证

| 命令 | 结果 |
|---|---|
| `node --test --test-concurrency=1 ../test/pitch-techniques-pitch-delta-compiler.test.mjs` | 7 passed |
| compiler / IR / compose / parameter-curve suites | 76 passed |
| `node --test --test-concurrency=1 ../docs/pitch-techniques/reference/model.test.mjs ../docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 862 passed in 34.675 s |
| `git diff --check` | clean |

## 范围与门禁

本任务没有连接或调用 Synthesizer V；零 host call、零 setter、零 Undo。它没有改变 H2、H3、H5、H6、H7
或 H8，也没有开放 PitchControl、显式颤音、公开 planner 或 commit 写入。T12 现在可以消费此编译结果，
但必须在同一事务内用宿主实际插值证明 postcondition，失败仍须按既有 rollback / ledger 规则处理。
