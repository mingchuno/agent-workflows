// Replace only external hosting and agent adapters; keep the real CLI and Runner.
export async function resolve(specifier, context, nextResolve) {
  if (
    /\/cli\.(ts|js)$/.test(new URL(context.parentURL ?? "file:///").pathname) &&
    /\/adapters\/(agents|hosting)\.(ts|js)$/.test(specifier)
  ) {
    return {
      url: new URL("./web-providers.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
