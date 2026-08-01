// 响应体积预算（计划 §4.4 规则 8/9）。
//
// 为什么这几个常量不能留在 SurfaceIoPolicy 注册表里：那个模块是**审计**用的，
// 有一条门禁明确禁止任何 handler 导入它——两份关于「路由/形状」的真相会立刻开始漂移。
// 但预算数字本身是业务逻辑需要的（超预算时把明细移进 Artifact），因此它属于一个
// 普通的共享常量模块，由 policy 注册表和业务模块各自导入。
//
// 门禁仍然覆盖它：SurfaceIoPolicy 从这里导入同一批常量，因此登记表里公布的预算
// 与业务实际执行的预算是同一个值，不存在「文档写 16 KiB、代码判 32 KiB」的可能。

/** compact success envelope 上限（§4.4 规则 8）。 */
export const COMPACT_MAX_BYTES = 16 * 1024;

/**
 * error envelope 上限（§4.4 规则 9）。
 * 刻意比 success 小：失败时最该给的是可执行的下一步，而不是一堆证据。
 */
export const ERROR_MAX_BYTES = 8 * 1024;

/** 请求预算：facade 信封 + 业务 arguments。grouped planner 请求是最大的一类。 */
export const REQUEST_MAX_BYTES = 16 * 1024;
