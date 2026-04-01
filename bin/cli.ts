#!/usr/bin/env node
/**
 * agcc — Antigravity-to-Claude CLI
 *
 * Starts a standalone HTTP server exposing Anthropic Messages API,
 * backed by the Antigravity LS binary + MITM TLS proxy.
 *
 * Usage:
 *   agcc --refresh-token "1//0gXXX..."
 *   REFRESH_TOKEN="1//0gXXX..." agcc
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { Backend } from "../src/backend.js"
import { MitmStore } from "../src/store.js"
import { startMitmProxy } from "../src/mitm.js"
import { startLlmServer } from "../src/server.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs(): { refreshToken: string; port: number } {
  const args = process.argv.slice(2)
  let refreshToken = process.env.REFRESH_TOKEN ?? ""
  let port = parseInt(process.env.PORT ?? "8080", 10)

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--refresh-token":
      case "--token":
        refreshToken = args[++i] ?? ""
        break
      case "--port":
      case "-p":
        port = parseInt(args[++i] ?? "8080", 10)
        break
      case "--help":
      case "-h":
        console.log(`
agcc — Antigravity-to-Claude

Exposes Anthropic Messages API backed by Antigravity LS binary.

Usage:
  agcc [options]

Options:
  --refresh-token <token>  Google OAuth refresh token (or REFRESH_TOKEN env)
  --port, -p <port>        HTTP server port (default: 8080)
  --help, -h               Show this help
`)
        process.exit(0)
    }
  }

  if (!refreshToken) {
    console.error("Error: refresh token required. Use --refresh-token or set REFRESH_TOKEN env.")
    process.exit(1)
  }

  return { refreshToken, port }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { refreshToken, port } = parseArgs()
  const dataDir = join(__dirname, "..", ".data")
  const dylibPath = join(__dirname, "..", "native", "dns_redirect.dylib")

  console.log("─────────────────────────────────────────────")
  console.log("  agcc — Antigravity-to-Claude")
  console.log("─────────────────────────────────────────────")

  // 1. MITM store
  const store = new MitmStore()

  // 2. MITM TLS proxy (generates certs, resolves Google IP)
  const mitm = startMitmProxy(store, dataDir)

  // 3. Backend (LS binary lifecycle)
  const backend = new Backend({
    refreshToken,
    dylibPath,
    sslCertFile: mitm.certPaths.combinedCaPath,
  })

  await backend.init()

  // 4. Anthropic HTTP server
  const server = startLlmServer({ backend, store, port })

  console.log("")
  console.log(`  ✅ Ready — http://localhost:${server.port}/v1/messages`)
  console.log("")

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Shutdown] Stopping...")
    server.close()
    mitm.close()
    backend.destroy()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
