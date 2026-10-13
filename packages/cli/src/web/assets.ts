import { fileURLToPath } from "node:url";

export const webAssetDirectory = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../../dist/web/" : "../../web/",
    import.meta.url,
  ),
);
