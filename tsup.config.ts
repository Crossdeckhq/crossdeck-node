import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/auto-events/index.ts"],
  format: ["cjs", "esm"],
  outExtension({ format }) {
    if (format === "cjs") return { js: ".cjs" };
    if (format === "esm") return { js: ".mjs" };
    return { js: ".js" };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
});
