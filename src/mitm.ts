/**
 * mitm.ts — TLS reverse proxy with request/response body modification.
 *
 * Sits between the LS binary and Google's API. Intercepts streamGenerateContent
 * requests, replaces the body with external client's content, and captures the
 * streaming response to forward to the client.
 *
 * No integrity checks exist on the request body — Google validates OAuth,
 * project, model, and JSON structure only.
 */

import { createServer as createTlsServer } from "tls"
import { request as httpsRequest } from "https"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join, dirname } from "path"
import { execSync } from "child_process"
import { randomBytes } from "crypto"
import { MitmStore, type RequestContext, type MitmEvent } from "./store.js"
import { parseGeminiSSE } from "./translate.js"

const GOOGLE_API_HOST = "daily-cloudcode-pa.googleapis.com"
const MITM_PORT = 443  // LS connects to port 443 by default

// ─── Self-signed certificate generation ──────────────────────────────────────

interface CertPaths {
  certPath: string
  keyPath: string
  combinedCaPath: string
}

function generateCert(dir: string): CertPaths {
  mkdirSync(dir, { recursive: true })
  const certPath = join(dir, "mitm-cert.pem")
  const keyPath = join(dir, "mitm-key.pem")
  const combinedCaPath = join(dir, "mitm-combined-ca.pem")

  if (!existsSync(certPath)) {
    // Generate self-signed cert for the Google domain
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout "${keyPath}" -out "${certPath}" -days 365 -nodes ` +
      `-subj "/CN=${GOOGLE_API_HOST}" ` +
      `-addext "subjectAltName=DNS:${GOOGLE_API_HOST}"`,
      { stdio: "pipe" }
    )
    console.log(`[MITM] Generated self-signed cert at ${certPath}`)
  }

  // Build combined CA file: system roots + our cert
  if (!existsSync(combinedCaPath)) {
    try {
      // macOS: export system root CAs
      const systemRoots = execSync(
        `security export -t certs -f pemseq -k /System/Library/Keychains/SystemRootCertificates.keychain`,
        { stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 }
      )
      const mitmCert = readFileSync(certPath, "utf8")
      writeFileSync(combinedCaPath, systemRoots.toString() + "\n" + mitmCert)
      console.log(`[MITM] Combined CA written to ${combinedCaPath}`)
    } catch (e) {
      // Linux fallback: try /etc/ssl/certs/ca-certificates.crt
      try {
        const systemRoots = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8")
        const mitmCert = readFileSync(certPath, "utf8")
        writeFileSync(combinedCaPath, systemRoots + "\n" + mitmCert)
      } catch {
        // Just use our cert alone — some requests may fail
        const mitmCert = readFileSync(certPath, "utf8")
        writeFileSync(combinedCaPath, mitmCert)
      }
    }
  }

  return { certPath, keyPath, combinedCaPath }
}

// ─── Resolve real Google IP ──────────────────────────────────────────────────

function resolveGoogleIP(): string {
  try {
    const result = execSync(`dig +short ${GOOGLE_API_HOST} | head -1`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).toString().trim()
    if (/^\d+\.\d+\.\d+\.\d+$/.test(result)) return result
  } catch { /* fall through */ }
  // Fallback: well-known Google IP
  return "142.250.80.95"
}

// ─── Request body modification ───────────────────────────────────────────────

function modifyRequest(body: Buffer, store: MitmStore): { modified: Buffer; ctx: RequestContext | null } {
  let json: any
  try {
    json = JSON.parse(body.toString())
  } catch {
    return { modified: body, ctx: null }
  }

  // Extract cascadeId from user message
  const contents = json.request?.contents
  let cascadeId: string | null = null
  if (Array.isArray(contents)) {
    for (const msg of contents) {
      const text = msg.parts?.[0]?.text
      if (typeof text === "string") {
        const cid = (MitmStore as any).extractCascadeId(text)
        if (cid) { cascadeId = cid; break }
      }
    }
  }

  const ctx = store.take(cascadeId ?? undefined)
  if (!ctx) {
    // No pending request — pass through unmodified (normal LS traffic)
    return { modified: body, ctx: null }
  }

  const originalSize = body.length
  const changes: string[] = []

  // 1. Replace systemInstruction
  if (ctx.systemPrompt) {
    json.request.systemInstruction = {
      parts: [{ text: ctx.systemPrompt }],
    }
    changes.push("system prompt replaced")
  } else {
    // Empty system prompt
    json.request.systemInstruction = { parts: [{ text: "" }] }
    changes.push("system prompt cleared")
  }

  // 2. Replace contents (messages)
  json.request.contents = ctx.contents
  changes.push(`contents replaced (${ctx.contents.length} messages)`)

  // 3. Replace tools
  if (ctx.tools && ctx.tools.length > 0) {
    json.request.tools = ctx.tools
    json.request.toolConfig = ctx.toolConfig ?? { functionCallingConfig: { mode: "AUTO" } }
    changes.push(`tools replaced (${ctx.tools.reduce((n: number, t: any) => n + (t.functionDeclarations?.length ?? 0), 0)} funcs)`)
  } else {
    delete json.request.tools
    delete json.request.toolConfig
    changes.push("tools removed")
  }

  // 4. Apply generation config overrides
  if (ctx.generationConfig) {
    json.request.generationConfig = {
      ...json.request.generationConfig,
      ...ctx.generationConfig,
    }
    changes.push("generation config patched")
  }

  const modified = Buffer.from(JSON.stringify(json))
  const saved = originalSize - modified.length
  console.log(`[MITM] Request modified: ${changes.join(", ")} (${originalSize}→${modified.length} bytes, ${saved > 0 ? "-" : "+"}${Math.abs(saved)}B)`)

  return { modified, ctx }
}

// ─── Response SSE parsing and event emission ─────────────────────────────────

function processResponseSSE(data: Buffer, ctx: RequestContext): void {
  const text = data.toString()
  const lines = text.split("\n")

  let accText = ""
  let accThinking = ""
  const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  let finishReason = ""
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let thinkingTokens = 0

  for (const line of lines) {
    const chunk = parseGeminiSSE(line)
    if (!chunk) continue

    // Usage metadata
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount ?? 0
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0
      cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount ?? 0
      thinkingTokens = chunk.usageMetadata.thoughtsTokenCount ?? 0
    }

    const candidate = chunk.candidates?.[0]
    if (!candidate) continue

    if (candidate.finishReason) {
      finishReason = candidate.finishReason
    }

    const parts = candidate.content?.parts
    if (!parts) continue

    for (const part of parts) {
      if (part.text !== undefined) {
        if (part.thoughtSignature !== undefined) {
          // This is a thinking part (has thoughtSignature sibling in response)
          accThinking += part.text
          ctx.emitter.emit("event", { type: "thinking_delta", text: accThinking } satisfies MitmEvent)
        } else {
          accText += part.text
          ctx.emitter.emit("event", { type: "text_delta", text: accText } satisfies MitmEvent)
        }
      }
      if (part.functionCall) {
        functionCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args,
        })
      }
    }
  }

  // Emit final events
  if (functionCalls.length > 0) {
    ctx.emitter.emit("event", { type: "function_call", calls: functionCalls } satisfies MitmEvent)
  }

  ctx.emitter.emit("event", {
    type: "usage",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingTokens,
  } satisfies MitmEvent)

  ctx.emitter.emit("event", {
    type: "done",
    finishReason: finishReason || "STOP",
  } satisfies MitmEvent)
}

// ─── MITM TLS Proxy ─────────────────────────────────────────────────────────

export interface MitmProxy {
  port: number
  certPaths: CertPaths
  close(): void
}

export function startMitmProxy(store: MitmStore, dataDir: string): MitmProxy {
  const certDir = join(dataDir, "certs")
  const certPaths = generateCert(certDir)
  const googleIP = resolveGoogleIP()
  console.log(`[MITM] Google API resolved to ${googleIP}`)

  let reqCounter = 0

  const server = createTlsServer(
    {
      cert: readFileSync(certPaths.certPath),
      key: readFileSync(certPaths.keyPath),
    },
    (socket) => {
      let buffer = Buffer.alloc(0)
      let headersParsed = false
      let headers: Record<string, string> = {}
      let method = ""
      let path = ""
      let contentLength = -1
      let isChunked = false
      let bodyBuffer = Buffer.alloc(0)
      let headerEndIndex = -1

      socket.on("data", (raw) => {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        buffer = Buffer.concat([buffer, chunk])

        if (!headersParsed) {
          const headerEnd = buffer.indexOf("\r\n\r\n")
          if (headerEnd === -1) return
          headersParsed = true
          headerEndIndex = headerEnd + 4

          const headerStr = buffer.subarray(0, headerEnd).toString()
          const lines = headerStr.split("\r\n")
          const [m, p] = lines[0].split(" ")
          method = m
          path = p

          for (let i = 1; i < lines.length; i++) {
            const colon = lines[i].indexOf(": ")
            if (colon > 0) {
              const key = lines[i].substring(0, colon).toLowerCase()
              const val = lines[i].substring(colon + 2)
              headers[key] = val
            }
          }

          if (headers["content-length"]) {
            contentLength = parseInt(headers["content-length"], 10)
          }
          if (headers["transfer-encoding"]?.includes("chunked")) {
            isChunked = true
          }

          bodyBuffer = buffer.subarray(headerEndIndex)
        } else {
          bodyBuffer = Buffer.concat([bodyBuffer, Buffer.isBuffer(raw) ? raw : Buffer.from(raw)])
        }

        // Check if we have the full body
        if (!isChunked && contentLength >= 0 && bodyBuffer.length >= contentLength) {
          handleRequest(bodyBuffer.subarray(0, contentLength))
        } else if (isChunked) {
          // For chunked: look for 0\r\n\r\n terminator
          if (bodyBuffer.includes(Buffer.from("0\r\n\r\n"))) {
            const decoded = decodeChunked(bodyBuffer)
            handleRequest(decoded)
          }
        }
      })

      function handleRequest(body: Buffer) {
        const reqId = ++reqCounter
        const isGenerateContent = path.includes("streamGenerateContent")

        let finalBody = body
        let ctx: RequestContext | null = null

        if (isGenerateContent) {
          const result = modifyRequest(body, store)
          finalBody = result.modified
          ctx = result.ctx
        }

        // Forward to Google
        const options = {
          hostname: googleIP,
          port: 443,
          path: path,
          method: method,
          headers: {
            ...headers,
            host: GOOGLE_API_HOST,
            "content-length": String(finalBody.length),
          },
          // Remove transfer-encoding since we send full body
          rejectUnauthorized: true,
        }
        delete (options.headers as any)["transfer-encoding"]

        const proxyReq = httpsRequest(options, (proxyRes) => {
          // Build response headers
          let responseHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
          for (const [key, val] of Object.entries(proxyRes.headers)) {
            if (val) responseHead += `${key}: ${Array.isArray(val) ? val.join(", ") : val}\r\n`
          }
          responseHead += "\r\n"
          socket.write(responseHead)

          // Buffer response for MITM capture
          const responseChunks: Buffer[] = []

          proxyRes.on("data", (chunk: Buffer) => {
            responseChunks.push(chunk)
            socket.write(chunk)
          })

          proxyRes.on("end", () => {
            socket.end()
            // Process captured response
            if (ctx && isGenerateContent) {
              const fullResponse = Buffer.concat(responseChunks)
              try {
                processResponseSSE(fullResponse, ctx)
              } catch (e) {
                console.error(`[MITM] Error processing response:`, e)
                ctx.emitter.emit("event", {
                  type: "error",
                  message: String(e),
                } satisfies MitmEvent)
              }
            }
          })
        })

        proxyReq.on("error", (e) => {
          console.error(`[MITM] Proxy error:`, e.message)
          socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${e.message}`)
          if (ctx) {
            ctx.emitter.emit("event", {
              type: "error",
              message: `Proxy error: ${e.message}`,
            } satisfies MitmEvent)
          }
        })

        proxyReq.write(finalBody)
        proxyReq.end()
      }

      socket.on("error", () => { /* connection reset, ignore */ })
    }
  )

  server.listen(MITM_PORT, "127.0.0.1", () => {
    console.log(`[MITM] TLS proxy listening on 127.0.0.1:${MITM_PORT}`)
  })

  return {
    port: MITM_PORT,
    certPaths,
    close: () => server.close(),
  }
}

// ─── Chunked transfer decoding ───────────────────────────────────────────────

function decodeChunked(buf: Buffer): Buffer {
  const parts: Buffer[] = []
  let pos = 0
  const str = buf.toString()

  while (pos < str.length) {
    const lineEnd = str.indexOf("\r\n", pos)
    if (lineEnd === -1) break
    const sizeStr = str.substring(pos, lineEnd).trim()
    const size = parseInt(sizeStr, 16)
    if (isNaN(size) || size === 0) break
    const dataStart = lineEnd + 2
    parts.push(buf.subarray(dataStart, dataStart + size))
    pos = dataStart + size + 2
  }

  return Buffer.concat(parts)
}
