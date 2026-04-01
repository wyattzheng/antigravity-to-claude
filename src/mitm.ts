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

import { createServer as createTlsServer, rootCertificates } from "tls"
import { request as httpsRequest } from "https"
import { resolve4 } from "dns"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import selfsigned from "selfsigned"
import { MitmStore, type RequestContext, type MitmEvent } from "./store.js"
import { parseGeminiSSE } from "./translate.js"

const GOOGLE_API_HOST = "daily-cloudcode-pa.googleapis.com"
const MITM_PORT = 443  // LS connects to port 443 by default

// ─── Self-signed certificate generation (pure JS, no openssl) ────────────────

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
    const pems = (selfsigned as any).generate(
      [{ name: "commonName", value: GOOGLE_API_HOST }],
      {
        days: 365,
        keySize: 2048,
        extensions: [
          { name: "subjectAltName", altNames: [{ type: 2 /* DNS */, value: GOOGLE_API_HOST }] },
        ],
      },
    )
    writeFileSync(certPath, pems.cert, "utf8")
    writeFileSync(keyPath, pems.private, "utf8")
    console.log(`[MITM] Generated self-signed cert at ${certPath}`)
  }

  // Build combined CA file: Node's built-in root certs + our MITM cert
  if (!existsSync(combinedCaPath)) {
    const nodeRoots = rootCertificates.join("\n")
    const mitmCert = readFileSync(certPath, "utf8")
    writeFileSync(combinedCaPath, nodeRoots + "\n" + mitmCert)
    console.log(`[MITM] Combined CA written to ${combinedCaPath}`)
  }

  return { certPath, keyPath, combinedCaPath }
}

// ─── Resolve real Google IP ──────────────────────────────────────────────────

function resolveGoogleIP(): Promise<string> {
  return new Promise((resolve) => {
    resolve4(GOOGLE_API_HOST, (err, addresses) => {
      if (err || !addresses?.length) {
        console.warn(`[MITM] DNS resolve failed, using fallback IP`)
        resolve("142.250.80.95")
      } else {
        resolve(addresses[0])
      }
    })
  })
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

export async function startMitmProxy(store: MitmStore, dataDir: string): Promise<MitmProxy> {
  const certDir = join(dataDir, "certs")
  const certPaths = generateCert(certDir)
  const googleIP = await resolveGoogleIP()
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
          if (ctx && isGenerateContent) {
            // ── Intercepted request: capture real response, send fake to LS ──
            const responseChunks: Buffer[] = []

            proxyRes.on("data", (chunk: Buffer) => {
              responseChunks.push(chunk)
              // Do NOT forward real response to LS
            })

            proxyRes.on("end", () => {
              // 1. Process real Google response → emit events to client
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

              // 2. Send fake simple text response to LS → cascade goes IDLE
              const fakeSSE = `data: {"candidates":[{"content":{"parts":[{"text":"ok"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n`
              const fakeBody = Buffer.from(fakeSSE)
              const fakeHeaders =
                `HTTP/1.1 200 OK\r\n` +
                `Content-Type: text/event-stream\r\n` +
                `Content-Length: ${fakeBody.length}\r\n` +
                `\r\n`
              socket.write(fakeHeaders)
              socket.write(fakeBody)
              socket.end()
            })
          } else {
            // ── Normal pass-through (non-intercepted traffic) ──
            let responseHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
            for (const [key, val] of Object.entries(proxyRes.headers)) {
              if (val) responseHead += `${key}: ${Array.isArray(val) ? val.join(", ") : val}\r\n`
            }
            responseHead += "\r\n"
            socket.write(responseHead)

            proxyRes.on("data", (chunk: Buffer) => {
              socket.write(chunk)
            })

            proxyRes.on("end", () => {
              socket.end()
            })
          }
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
