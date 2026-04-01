#!/usr/bin/env node
/**
 * agcc — Antigravity-to-Claude CLI
 *
 * Usage:
 *   agcc                              # start server (auto-login if needed)
 *   agcc start                        # same as above
 *   agcc --refresh-token "1//0gXXX"   # start with explicit token
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { Backend } from "../src/backend.js"
import { MitmStore } from "../src/store.js"
import { startMitmProxy } from "../src/mitm.js"
import { startLlmServer } from "../src/server.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGCC_DIR = join(homedir(), ".agcc")
const TOKEN_PATH = join(AGCC_DIR, "token.json")

// ─── Token persistence ──────────────────────────────────────────────────────

function loadSavedToken(): string | null {
  try {
    const data = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"))
    if (data.refresh_token) return data.refresh_token
  } catch { /* not found or parse error */ }
  return null
}

function saveToken(refreshToken: string): void {
  mkdirSync(AGCC_DIR, { recursive: true })
  writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: refreshToken }, null, 2), "utf-8")
  console.log(`\n✅ Token saved to ${TOKEN_PATH}`)
}

// ─── get-token OAuth flow ────────────────────────────────────────────────────

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"
const SCOPES = "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/experimentsandconfigs"
const OAUTH_PORT = 19877
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/oauth-callback`

async function getToken(): Promise<string> {
  const http = await import("http")
  const https = await import("https")
  const { execSync } = await import("child_process")

  console.log("═".repeat(50))
  console.log("  🔐 agcc — Google OAuth Login")
  console.log("═".repeat(50))

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  })}`

  const code = await new Promise<string>((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url!, `http://localhost:${OAUTH_PORT}`)
      if (u.pathname === "/oauth-callback" && u.searchParams.get("code")) {
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end("<h1>✅ Done! Return to terminal.</h1><script>window.close()</script>")
        srv.close()
        resolve(u.searchParams.get("code")!)
      }
    })
    srv.listen(OAUTH_PORT, () => {
      console.log("\n🌐 Opening browser for Google OAuth...")
      console.log("   (If browser doesn't open, visit this URL manually)\n")
      try { execSync(`open "${authUrl}"`) } catch { console.log(authUrl) }
    })
  })

  console.log("\n📡 Exchanging code for tokens...")

  const tokens: any = await new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    })
    const req = https.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, (res) => {
      let d = ""
      res.on("data", (c: Buffer) => (d += c))
      res.on("end", () => { try { resolve(JSON.parse(d)) } catch { reject(new Error(d)) } })
    })
    req.on("error", reject)
    req.write(params.toString())
    req.end()
  })

  if (tokens.error) {
    throw new Error(`OAuth error: ${tokens.error_description || tokens.error}`)
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token received. " +
      "Try revoking access at https://myaccount.google.com/permissions and trying again."
    )
  }

  saveToken(tokens.refresh_token)
  return tokens.refresh_token
}

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs(): { refreshToken: string; port: number } {
  const args = process.argv.slice(2)
  let refreshToken = process.env.REFRESH_TOKEN ?? ""
  let port = parseInt(process.env.PORT ?? "8080", 10)

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "start":
        break // default command, no-op
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
Automatic OAuth login on first run, token saved to ~/.agcc/token.json.

Usage:
  agcc [start] [options]

Options:
  --refresh-token <token>  Override refresh token (or REFRESH_TOKEN env)
  --port, -p <port>        HTTP server port (default: 8080)
  --help, -h               Show this help
`)
        process.exit(0)
    }
  }

  return { refreshToken, port }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { refreshToken: explicitToken, port } = parseArgs()

  // Resolve refresh token: explicit > env > saved > interactive OAuth
  let refreshToken = explicitToken
  if (!refreshToken) {
    refreshToken = loadSavedToken() ?? ""
  }
  if (!refreshToken) {
    console.log("No token found. Starting OAuth login flow...\n")
    refreshToken = await getToken()
    console.log("")
  }

  const dataDir = join(__dirname, "..", ".data")
  const dylibPath = join(__dirname, "..", "native", "dns_redirect.dylib")

  console.log("─────────────────────────────────────────────")
  console.log("  agcc — Antigravity-to-Claude")
  console.log("─────────────────────────────────────────────")

  // 1. MITM store
  const store = new MitmStore()

  // 2. MITM TLS proxy
  const mitm = await startMitmProxy(store, dataDir)

  // 3. Backend
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
