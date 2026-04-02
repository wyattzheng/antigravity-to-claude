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
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs"
import { homedir } from "os"
import { randomBytes } from "crypto"
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

const OAUTH_CACHE_PATH = join(AGCC_DIR, "oauth_token.json")

function clearTokens(): void {
  for (const f of [TOKEN_PATH, OAUTH_CACHE_PATH]) {
    try { unlinkSync(f) } catch { /* doesn't exist */ }
  }
  console.log("🗑  Cleared saved tokens")
}

// ─── set-cc: patch Claude Code settings ─────────────────────────────────────────

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json")
const DEFAULT_PORT = 19888

function setCCConfig(port: number): void {
  let settings: any = {}
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"))
  } catch { /* file doesn't exist or parse error, start fresh */ }

  if (!settings.env) settings.env = {}
  settings.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`
  // Generate a random dummy API key if none exists (Claude Code requires one)
  if (!settings.env.ANTHROPIC_AUTH_TOKEN) {
    settings.env.ANTHROPIC_AUTH_TOKEN = `sk-${randomBytes(32).toString("hex")}`
  }

  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true })
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8")
  console.log(`✅ Claude Code configured:`)
  console.log(`   ANTHROPIC_BASE_URL = http://localhost:${port}`)
  console.log(`   Settings file: ${CLAUDE_SETTINGS_PATH}`)
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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AGCC</title>
<style>
*{margin:0;box-sizing:border-box}
body{height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#222}
.c{text-align:center}
.msg{font-size:1.5rem;font-weight:500;color:#333}
.sub{margin-top:.75rem;font-size:.95rem;color:#999}
</style></head>
<body><div class="c">
<div class="msg">Logged in successfully.</div>
<div class="sub">You may close this tab.</div>
</div>
<script>setTimeout(()=>window.close(),1500)</script>
</body></html>`)
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

function showHelp(): void {
  console.log(`
agcc — Antigravity-to-Claude

Exposes Anthropic Messages API backed by Antigravity LS binary.
Automatic OAuth login on first run, token saved to ~/.agcc/token.json.

Usage:
  agcc start [options]          Start the server
  agcc re-login [options]       Clear saved tokens and re-login
  agcc set-cc [port]            Set Claude Code to use agcc (default: ${DEFAULT_PORT})

Options:
  --refresh-token <token>  Override refresh token (or REFRESH_TOKEN env)
  --port, -p <port>        HTTP server port (default: ${DEFAULT_PORT})
  --help, -h               Show this help
`)
}

function parseArgs(): { command: "start" | "re-login" | "help"; refreshToken: string; port: number } {
  const args = process.argv.slice(2)
  let refreshToken = process.env.REFRESH_TOKEN ?? ""
  let port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10)
  let command: "start" | "re-login" | "help" = "help"

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "start":
        command = "start"
        break
      case "re-login":
        command = "re-login"
        break
      case "set-cc":
        setCCConfig(parseInt(args[++i] ?? String(DEFAULT_PORT), 10))
        process.exit(0)
      case "--refresh-token":
      case "--token":
        refreshToken = args[++i] ?? ""
        break
      case "--port":
      case "-p":
        port = parseInt(args[++i] ?? String(DEFAULT_PORT), 10)
        break
      case "--help":
      case "-h":
        showHelp()
        process.exit(0)
    }
  }

  return { command, refreshToken, port }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { command, refreshToken: explicitToken, port } = parseArgs()

  if (command === "help") {
    showHelp()
    process.exit(0)
  }

  // relogin: clear everything and force OAuth
  if (command === "re-login") {
    clearTokens()
  }

  // Resolve refresh token: explicit > env > saved > interactive OAuth
  let refreshToken = explicitToken
  if (!refreshToken && command !== "re-login") {
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

  // 2. MITM HTTP proxy (plain HTTP — no TLS certs needed)
  const mitm = await startMitmProxy(store, dataDir)

  // 3. Backend
  const backend = new Backend({
    refreshToken,
    mitmPort: mitm.port,
  })

  await backend.init()

  // 4. Anthropic HTTP server
  const server = startLlmServer({ backend, store, port })

  console.log("")
  console.log(`  ✅ Ready — http://localhost:${server.port}/v1/messages`)
  console.log("")

  // Hint: if Claude Code is installed but not configured for agcc
  if (existsSync(join(homedir(), ".claude"))) {
    let needsHint = false
    try {
      const s = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"))
      if (s?.env?.ANTHROPIC_BASE_URL !== `http://localhost:${server.port}`) needsHint = true
    } catch {
      needsHint = true
    }
    if (needsHint) {
      console.log(`  💡 Claude Code detected. Run "agcc set-cc" to configure it automatically.`)
      console.log("")
    }
  }

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
