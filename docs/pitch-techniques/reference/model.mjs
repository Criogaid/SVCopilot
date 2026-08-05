// 参考入口：闭式模型的实现已移入 server/src/pitch-techniques/model.js，因为它是运行时
// 代码，必须随 npm 包一起分发（docs/ 不进包）。这里只再导出同一份实现，让参考测试、
// 文档与合成语料的 truthSource 仍能通过历史路径引用它，且不产生第二份定义。
export * from "../../../server/src/pitch-techniques/model.js";
