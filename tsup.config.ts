import { defineConfig } from "tsup"
import { copyFileSync } from "fs"

export default defineConfig({
  entry: { cli: "bin/cli.ts" },
  format: ["esm"],
  target: "es2022",
  clean: true,
  dts: true,
  splitting: false,
  sourcemap: true,
  onSuccess: async () => {
    copyFileSync("src/schemas.json", "dist/schemas.json")
    console.log("Copied schemas.json to dist/")
  },
})
