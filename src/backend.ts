/**
 * backend.ts — LS binary lifecycle management.
 *
 * Handles:
 *   1. OAuth token refresh (refresh_token → access_token)
 *   2. Mock Extension Server with USS OAuth injection
 *   3. Go binary spawn with DYLD_INSERT_LIBRARIES DNS redirect
 *   4. ConnectRPC calls (StartCascade, SendUserCascadeMessage)
 *
 * No agent/chat abstraction — just raw LS management.
 */

import { createServer as createHttpServer, type Server as HttpServer } from "http"
import { request as httpsRequest } from "https"
import { createServer as createNetServer } from "net"
import { spawn, execSync, type ChildProcess } from "child_process"
import { tmpdir, platform, homedir } from "os"
import { join, dirname } from "path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { fileURLToPath } from "url"
import { randomBytes, randomUUID } from "crypto"
import {
  buildOAuthUSSUpdate,
  encodeEnvelope,
  protoEncodeBytes,
  decodeEnvelopes,
  protoDecodeFields,
  getSchemas,
} from "./proto.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"
const AGCC_DIR = join(homedir(), ".agcc")
const TOKEN_CACHE_PATH = join(AGCC_DIR, "oauth_token.json")

// ─── Binary resolution ───────────────────────────────────────────────────────

function resolveBinaryPath(): string {
  const os = platform()
  const binaryMap: Record<string, string> = {
    darwin: "language_server_macos_arm",
    linux: "language_server_linux_x64",
  }
  const binaryName = binaryMap[os]
  if (!binaryName) throw new Error(`Unsupported platform: ${os}`)

  const bundled = join(__dirname, "..", "bin", binaryName)
  if (existsSync(bundled)) return bundled

  throw new Error(`Go binary not found at ${bundled}`)
}

// ─── Backend ─────────────────────────────────────────────────────────────────

export interface BackendOptions {
  refreshToken: string
  /** Path to dns_redirect.dylib for DYLD_INSERT_LIBRARIES */
  dylibPath?: string
  /** Path to combined CA file for SSL_CERT_FILE */
  sslCertFile?: string
  /** MITM proxy port (LS will connect to this port) */
  mitmPort?: number
}

export class Backend {
  private refreshToken: string
  private accessToken = ""
  private lsCsrf = randomUUID()
  private extCsrf = randomUUID()
  private lsPort = 0
  private extServer: HttpServer | null = null
  private binaryChild: ChildProcess | null = null
  private pipeServer: any = null
  private dylibPath?: string
  private sslCertFile?: string
  private oauthResolve: (() => void) | null = null
  private oauthPromise: Promise<void> | null = null
  private mitmPort: number

  constructor(opts: BackendOptions) {
    this.refreshToken = opts.refreshToken
    this.dylibPath = opts.dylibPath
    this.sslCertFile = opts.sslCertFile
    this.mitmPort = opts.mitmPort ?? 18443
  }

  /** Initialize: refresh token → start ext server → spawn binary → inject OAuth */
  async init(): Promise<void> {
    const binaryPath = resolveBinaryPath()
    console.log(`[Backend] Binary: ${binaryPath}`)
    getSchemas() // Validate proto schemas

    // 1. Refresh access token
    console.log("[Backend] Refreshing access token...")
    await this.refreshAccessToken()
    console.log("[Backend] ✅ Access token obtained")

    // 2. Start mock extension server
    this.oauthPromise = new Promise((resolve) => { this.oauthResolve = resolve })
    const extPort = await this.startExtensionServer()
    console.log(`[Backend] ✅ Extension server on port ${extPort}`)

    // 3. Spawn Go binary
    await this.spawnBinary(extPort, binaryPath)
    console.log(`[Backend] ✅ Language server on port ${this.lsPort}`)

    // 4. Wait for OAuth injection
    console.log("[Backend] Waiting for OAuth injection...")
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("OAuth injection timed out (30s)")), 30000)
    )
    await Promise.race([this.oauthPromise, timeout])
    console.log("[Backend] ✅ OAuth token injected via USS")
  }

  /** Create a new cascade via RPC, return cascadeId */
  async createCascade(): Promise<string> {
    const res = await this.rpc("StartCascade")
    return res.cascadeId
  }

  /** Send a message on a cascade to trigger streamGenerateContent */
  async sendMessage(cascadeId: string, text: string): Promise<void> {
    const plannerConfig = {
      conversational: {
        plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
        agenticMode: true,
      },
      cascadeCanAutoRunCommands: true,
      toolConfig: {
        runCommand: { forceDisable: true },
        searchWeb: { forceDisable: true },
        generateImage: { forceDisable: true },
        browserSubagent: { forceDisable: true },
      },
      requestedModel: { model: "MODEL_PLACEHOLDER_M26" },
      ephemeralMessagesConfig: { enabled: false },
      knowledgeConfig: { enabled: false },
      promptSectionCustomizationConfig: {
        removePromptSections: [
          "identity", "web_application_development", "planning_mode",
          "planning_mode_artifacts", "artifacts", "skills", "plugins",
          "persistent_context", "ephemeral_message", "communication_style", "tool_calling",
        ],
      },
    }

    // Same pattern as any-code: await the RPC
    await this.rpc("SendUserCascadeMessage", {
      cascadeId,
      items: [{ text }],
      cascadeConfig: {
        plannerConfig,
        conversationHistoryConfig: { enabled: false },
      },
      clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
    })
  }

  /** Clean up all resources */
  destroy(): void {
    this.binaryChild?.kill()
    this.extServer?.close()
    this.pipeServer?.close()
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async refreshAccessToken(): Promise<void> {
    // Try cache first — but only if same account (refresh_token matches)
    try {
      const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf-8"))
      if (cached.access_token && cached.expires_at && Date.now() < cached.expires_at - 60_000
          && cached.refresh_token === this.refreshToken) {
        this.accessToken = cached.access_token
        console.log("[Backend] ✅ Using cached access token")
        return
      }
    } catch { /* cache miss */ }

    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      })
      const req = httpsRequest("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }, (res) => {
        let d = ""
        res.on("data", (c: Buffer) => (d += c))
        res.on("end", () => {
          try {
            const json = JSON.parse(d)
            if (json.error) {
              reject(new Error(`OAuth error: ${json.error_description || json.error}`))
              return
            }
            this.accessToken = json.access_token
            try {
              mkdirSync(AGCC_DIR, { recursive: true })
              writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({
                access_token: json.access_token,
                refresh_token: this.refreshToken,
                expires_at: Date.now() + (json.expires_in || 3600) * 1000,
              }), "utf-8")
            } catch { /* ignore cache write errors */ }
            resolve()
          } catch {
            reject(new Error(`Failed to parse token response: ${d}`))
          }
        })
      })
      req.on("error", reject)
      req.write(params.toString())
      req.end()
    })
  }

  private startExtensionServer(): Promise<number> {
    return new Promise((resolve) => {
      const server = createHttpServer((req, res) => {
        const rpcPath = req.url || ""
        let body: Buffer[] = []
        req.on("data", (chunk: Buffer) => body.push(chunk))
        req.on("end", () => {
          const rawBody = Buffer.concat(body)

          if (rpcPath.includes("SubscribeToUnifiedStateSyncTopic")) {
            let topic = ""
            try {
              const frames = decodeEnvelopes(rawBody)
              if (frames.length > 0) topic = protoDecodeFields(frames[0].body).field1 || ""
            } catch { }

            res.writeHead(200, {
              "Content-Type": "application/connect+proto",
              "Transfer-Encoding": "chunked",
            })
            res.flushHeaders()
            if (res.socket) res.socket.setNoDelay(true)

            if (topic === "uss-oauth" && this.accessToken) {
              res.write(encodeEnvelope(buildOAuthUSSUpdate(this.accessToken, this.refreshToken)))
              this.oauthResolve?.()
            } else {
              res.write(encodeEnvelope(protoEncodeBytes(1, Buffer.alloc(0))))
            }
            return // keep stream open
          }

          res.writeHead(200, { "Content-Type": "application/proto" })
          res.end(Buffer.alloc(0))
        })
      })

      server.listen(0, "127.0.0.1", () => {
        this.extServer = server
        resolve((server.address() as any).port)
      })
    })
  }

  /**
   * Strip hardened runtime from Go binary on macOS so DYLD_INSERT_LIBRARIES works.
   * No-op if already stripped or not on macOS.
   */
  private stripHardenedRuntime(binaryPath: string): void {
    if (platform() !== "darwin") return
    try {
      const info = execSync(`codesign -dvv "${binaryPath}" 2>&1`, { encoding: "utf8" })
      if (!info.includes("runtime")) return // already no hardened runtime
      console.log("[Backend] Stripping hardened runtime from binary...")
      execSync(`codesign --remove-signature "${binaryPath}"`, { stdio: "ignore" })
      execSync(`codesign -s - "${binaryPath}"`, { stdio: "ignore" })
      console.log("[Backend] ✅ Re-signed without hardened runtime")
    } catch (e: any) {
      console.log(`[Backend] ⚠ codesign strip failed: ${e.message}`)
    }
  }

  private spawnBinary(extPort: number, binaryPath: string): Promise<void> {
    // Strip hardened runtime before spawn (macOS only, one-time)
    this.stripHardenedRuntime(binaryPath)

    return new Promise((resolve, reject) => {
      const pipePath = join(tmpdir(), `agcc_${randomBytes(4).toString("hex")}`)
      const pipeServer = createNetServer(() => { })

      pipeServer.listen(pipePath, () => {
        this.pipeServer = pipeServer

        const childEnv: Record<string, string> = { ...(process.env as any) }

        // Plain HTTP endpoint → no TLS, no certs, no DNS redirect needed
        const endpoint = `http://127.0.0.1:${this.mitmPort}`

        const child = spawn(binaryPath, [
          "--csrf_token", this.lsCsrf,
          "--https_server_port", "0",
          "--workspace_id", "agcc-session",
          "--cloud_code_endpoint", endpoint,
          "--app_data_dir", "antigravity",
          "--extension_server_port", String(extPort),
          "--extension_server_csrf_token", this.extCsrf,
          "--parent_pipe_path", pipePath,
        ], { stdio: ["pipe", "pipe", "pipe"], env: childEnv })

        this.binaryChild = child

        child.stdin.write(Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]))
        child.stdin.end()

        let resolved = false
        const timeout = setTimeout(() => {
          if (!resolved) { resolved = true; reject(new Error("Binary startup timed out (30s)")) }
        }, 30000)

        child.stderr.on("data", (d: Buffer) => {
          const text = d.toString()
          for (const line of text.split("\n")) {
            if (line.trim()) console.log(`[Binary] ${line}`)
          }
          const m = text.match(/listening on random port at (\d+) for HTTPS/)
          if (m && !resolved) {
            resolved = true
            clearTimeout(timeout)
            this.lsPort = parseInt(m[1])
            resolve()
          }
        })

        child.on("error", (err) => {
          if (!resolved) { resolved = true; clearTimeout(timeout); reject(err) }
        })
        child.on("exit", (code) => {
          if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error(`Binary exited with code ${code}`)) }
        })
      })
    })
  }

  private rpc(method: string, body: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const timeout = setTimeout(() => { req.destroy(); reject(new Error(`RPC ${method} timed out`)) }, 120000)
      const req = httpsRequest({
        hostname: "127.0.0.1",
        port: this.lsPort,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": this.lsCsrf,
          "Content-Length": Buffer.byteLength(data),
          Connection: "close",
        },
        rejectUnauthorized: false,
      }, (res) => {
        let d = ""
        res.on("data", (c: Buffer) => (d += c))
        res.on("end", () => {
          clearTimeout(timeout)
          try { resolve(JSON.parse(d)) } catch { resolve(d) }
        })
      })
      req.on("error", (err) => { clearTimeout(timeout); reject(err) })
      req.write(data)
      req.end()
    })
  }
}
