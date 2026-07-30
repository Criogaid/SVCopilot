// 自动测试必须与开发机上真实运行的 Relay 共存：真实 Relay 已经占用固定的
// \\.\pipe\SVCopilot-{to,from}-sv，测试再 listen 同名管道会直接 EADDRINUSE。
// 这里按测试进程 pid 生成唯一前缀，并写回 process.env，让通过 `...process.env`
// 派生的服务器子进程和 Lua 桥自动继承同一个命名空间。
// 正式安装不设置该变量，管道名保持固定。
export function useIsolatedPipeNamespace() {
  if (!process.env.SV_COPILOT_PIPE_NAMESPACE) {
    process.env.SV_COPILOT_PIPE_NAMESPACE = `t${process.pid}`;
  }
  return process.env.SV_COPILOT_PIPE_NAMESPACE;
}

useIsolatedPipeNamespace();
