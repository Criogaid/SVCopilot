# T16 — FitWorker Benchmark 与选型

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) F8、§11、§17 提交 16
- 依赖：T01 corpus；T05–T07 前向模型
- 解锁：T17

## 目标

以同 corpus、seed、硬件和预热口径比较候选拟合后端，并由证据决定语言与部署方式。

## 交付边界

- 按权威 FitWorker 协议建立可替换 runner，不让 worker 接触 MCP、PIPE、handle 或写入。
- 记录精度、失败率、median/p95、启动成本、依赖体积和许可证。
- 至少 20 次预热后测量；失败样本必须保留分类，不能只报平均值。
- 不因已有语言偏好预先锁定实现。

## 验收

- 所有候选消费相同 canonical input 并返回同一协议形状。
- benchmark 可重复运行，结果 Artifact 与环境信息完整。
- 选型逐项满足 §11.3；无候选达标时诚实阻塞 T17。

## 完成条件

形成可审计的选型结论，生产依赖与 NOTICE 更新范围明确。

## 完成记录

- 证据：[T16-fit-worker-benchmark.md](../evidence/T16-fit-worker-benchmark.md) 与
  [machine-readable report](../evidence/T16-fit-worker-benchmark.json)。
- 提交：本任务的独立提交见 Git history。
- 选型：`node-bounded-richards`；它在固定 corpus、seed、20 次预热和同一协议下通过全部 F8/§11
  门禁，且未增加生产运行时依赖或 NOTICE 条目。
- 生产边界：SciPy adapter 仅为 benchmark 对照，未加入 `server/package.json`；Rust/WASM 没有已固定的
  实现或可分发构件，未被 benchmark。T16 不新增 MCP surface 或 host/PIPE 写入路径。
- 宿主：未接触；零 host call、零 setter、零 Undo。T08/H1 已完成后，T17 可按其自身任务定义开始。
