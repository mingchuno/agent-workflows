// Override external providers at the CLI's public SDK import; keep the real Runner/Store.
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@mingchuno/agent-workflows-core" &&
    /\/cli\.(ts|js)$/.test(new URL(context.parentURL ?? "file:///").pathname)
  ) {
    const actual = await nextResolve(specifier, context);
    const providers = new URL("./web-providers.mjs", import.meta.url).href;
    const source = `export * from ${JSON.stringify(actual.url)};
      export { createAgents, createHosting } from ${JSON.stringify(providers)};`;
    return {
      url: `data:text/javascript,${encodeURIComponent(source)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
