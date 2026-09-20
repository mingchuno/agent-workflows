// Keep the real SDK/worker path, replacing only the paid Codex executable.
import { register } from "node:module";

register("./env-agent-resolver.mjs", import.meta.url, {
  data: { sdk: import.meta.resolve("@openai/codex-sdk") },
});
