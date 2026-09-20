let sdk;
export function initialize(data) {
  sdk = data.sdk;
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "@openai/codex-sdk") return nextResolve(specifier, context);
  const source = `import { Codex as RealCodex } from ${JSON.stringify(sdk)};
    export class Codex extends RealCodex {
      constructor() { super({ codexPathOverride: process.env.AW_TEST_CODEX }); }
    }`;
  return {
    url: `data:text/javascript,${encodeURIComponent(source)}`,
    shortCircuit: true,
  };
}
