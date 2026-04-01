import { defineConfig } from "tsup"

export default defineConfig({
  entry: { cli: "bin/cli.ts" },
  format: ["esm"],
  target: "es2022",
  clean: true,
  dts: true,
  splitting: false,
  sourcemap: true,
})
