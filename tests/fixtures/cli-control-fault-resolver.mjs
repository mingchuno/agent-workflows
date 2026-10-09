// Interrupt the real CLI at the filesystem boundary while publishing its locator.
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier !== "node:fs/promises" ||
    context.parentURL?.startsWith("data:")
  )
    return nextResolve(specifier, context);
  const source = `
    export * from 'node:fs/promises';
    import { writeFile as realWriteFile } from 'node:fs/promises';
    export async function writeFile(path, ...args) {
      if (/agent-workflows-[0-9]+-[a-f0-9]{64}\\.json/.test(String(path))) {
        await realWriteFile(path, '{', { flag: 'wx', mode: 0o600 });
        process.exit(77);
      }
      return realWriteFile(path, ...args);
    }
  `;
  return {
    url: `data:text/javascript,${encodeURIComponent(source)}`,
    shortCircuit: true,
  };
}
