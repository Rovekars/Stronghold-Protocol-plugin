// vendor 单实例 loader：把裸 preact / preact/hooks / htm 映射到 public/vendor 的单实例
// （与 preact-fake-dom-test 方法论一致；放在 test/ui/ 供音乐盒面板的 fake-DOM 测试长期复用）。
export function resolve(specifier, context, next) {
  if (specifier === 'preact') return { url: new URL('../../public/vendor/preact.module.js', import.meta.url).href, shortCircuit: true };
  if (specifier === 'preact/hooks') return { url: new URL('../../public/vendor/hooks.module.js', import.meta.url).href, shortCircuit: true };
  if (specifier === 'htm') return { url: new URL('../../public/vendor/htm.module.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
