// 空桩：被裁剪的可选依赖（LeanCloud / MathJax 等）在 GitHub CSV 存储模式下不会被调用。
// 保留为可调用对象，避免极端路径下解构报错。
module.exports = new Proxy(
  function emptyStub() {},
  {
    get: () => emptyStub,
    apply: () => emptyStub,
    construct: () => ({}),
  },
);

function emptyStub() {
  return emptyStub;
}
