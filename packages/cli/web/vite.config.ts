import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      onLog(level, log, next) {
        // This is entirely a client bundle; React server-component directives do not apply.
        if (
          log.code === "MODULE_LEVEL_DIRECTIVE" &&
          log.message.includes("use client")
        )
          return;
        next(level, log);
      },
    },
  },
});
