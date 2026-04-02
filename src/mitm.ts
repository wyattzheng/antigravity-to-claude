/**
 * mitm.ts — HTTP reverse proxy with request/response body modification.
 *
 * Sits between the LS binary and Google's API. The LS connects via plain HTTP
 * (http://127.0.0.1:port), so no TLS certificates are needed.
 * Intercepts streamGenerateContent requests, replaces the body with the
 * external client's content, and captures the streaming response.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http"
import * as http2 from "http2"
import { resolve4 } from "dns"
import { mkdirSync, appendFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { MitmStore, type RequestContext, type MitmEvent } from "./store.js"
import { parseGeminiSSE } from "./translate.js"

const LOG_DIR = join(homedir(), ".agcc", "logs")
mkdirSync(LOG_DIR, { recursive: true })

const LOG_FILE = join(LOG_DIR, "mitm.log")
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB

function writeLog(reqId: number, request: any, response: any): void {
  try {
    // Truncate if too large
    try {
      const stat = statSync(LOG_FILE)
      if (stat.size > MAX_LOG_SIZE) {
        appendFileSync(LOG_FILE, "", { flag: "w" })
      }
    } catch { /* file doesn't exist yet */ }

    const entry = JSON.stringify({ ts: new Date().toISOString(), reqId, request, response })
    appendFileSync(LOG_FILE, entry + "\n", "utf-8")
  } catch (e: any) {
    console.error(`[MITM] Failed to write log: ${e.message}`)
  }
}

const GOOGLE_API_HOST = "daily-cloudcode-pa.googleapis.com"
const MITM_PORT = 18443

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
    // No system prompt — remove to avoid Google rejecting empty text
    delete json.request.systemInstruction
    changes.push("system prompt removed")
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

  // 4. generationConfig — keep original LS config untouched
  // (includes thinkingConfig, maxOutputTokens, etc.)

  const modified = Buffer.from(JSON.stringify(json))
  const saved = originalSize - modified.length
  console.log(`[MITM] Request modified: ${changes.join(", ")} (${originalSize}→${modified.length} bytes, ${saved > 0 ? "-" : "+"}${Math.abs(saved)}B)`)

  return { modified, ctx }
}


// ─── MITM HTTP Proxy ─────────────────────────────────────────────────────────


export interface MitmProxy {
  port: number
  close(): void
}

export async function startMitmProxy(store: MitmStore, dataDir: string): Promise<MitmProxy> {
  const googleIP = await resolveGoogleIP()
  console.log(`[MITM] Google API resolved to ${googleIP}`)

  let reqCounter = 0

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // Collect full body
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      const reqId = ++reqCounter
      const reqPath = req.url || "/"
      const reqMethod = req.method || "GET"

      // Extract raw headers with original casing (req.rawHeaders is [key, val, key, val, ...])
      const rawHeaders: Array<[string, string]> = []
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawHeaders.push([req.rawHeaders[i], req.rawHeaders[i + 1]])
      }

      const isGenerateContent = reqPath.includes("streamGenerateContent")

      if (isGenerateContent) {
        console.log(`[MITM] #${reqId} streamGenerateContent (${body.length} bytes)`)
        const result = modifyRequest(body, store)
        if (!result.ctx) {
          console.log(`[MITM] #${reqId} No context, returning STOP`)
          // Fake STOP response
          const fakeChunk = JSON.stringify({
            response: {
              candidates: [{
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
              }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
            },
          })
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          res.end(`data: ${fakeChunk}\r\n\r\n`)
          return
        }

        forwardToGoogle(reqId, reqMethod, reqPath, rawHeaders, result.modified, result.ctx, res)
        return
      }

      // Non-generateContent → pass through
      console.log(`[MITM] #${reqId} pass-through: ${reqMethod} ${reqPath} (${body.length} bytes)`)
      forwardToGoogle(reqId, reqMethod, reqPath, rawHeaders, body, null, res)
    })
  })

  function forwardToGoogle(
    reqId: number, reqMethod: string, reqPath: string,
    rawHeaders: Array<[string, string]>,
    finalBody: Buffer, ctx: RequestContext | null,
    res: ServerResponse,
  ) {
    // LS uses --cloud_code_endpoint pointing at us, so all requests here
    // are cloudcode API requests. Always forward to GOOGLE_API_HOST.
    const h2Headers: Record<string, string> = {
      ":method": reqMethod,
      ":path": reqPath,
      ":authority": GOOGLE_API_HOST,
      ":scheme": "https",
    }

    for (const [key, val] of rawHeaders) {
      const lower = key.toLowerCase()
      if (lower === "host") continue  // replace with :authority
      if (lower === "transfer-encoding") continue
      if (lower === "content-length") {
        h2Headers["content-length"] = String(finalBody.length)
        continue
      }
      h2Headers[key] = val
    }
    if (!h2Headers["content-length"] && !h2Headers["Content-Length"]) {
      h2Headers["content-length"] = String(finalBody.length)
    }

    const session = http2.connect(`https://${googleIP}`, {
      servername: GOOGLE_API_HOST,
      rejectUnauthorized: true,
    })

    session.on("error", (e: Error) => {
      console.error(`[MITM] H2 session error:`, e.message)
      if (!res.writableEnded) {
        if (!res.headersSent) res.writeHead(502)
        res.end(e.message)
      }
      if (ctx) {
        ctx.emitter.emit("event", { type: "error", message: `H2 error: ${e.message}` } satisfies MitmEvent)
      }
    })

    const h2req = session.request(h2Headers)
    h2req.write(finalBody)
    h2req.end()

    let statusCode = 200

    h2req.on("response", (responseHeaders) => {
      statusCode = responseHeaders[":status"] as number ?? 200

      if (ctx) {
        // ── Intercepted: stream SSE to our client ──
        console.log(`[MITM] #${reqId} Google response: ${statusCode}`)
        if (statusCode !== 200) {
          const errChunks: Buffer[] = []
          h2req.on("data", (c: Buffer) => errChunks.push(c))
          h2req.on("end", () => {
            const errBody = Buffer.concat(errChunks).toString()
            console.log(`[MITM] #${reqId} Error: ${errBody.substring(0, 500)}`)
            ctx.emitter.emit("event", { type: "error", message: errBody.substring(0, 200) } satisfies MitmEvent)
            res.writeHead(200, { "Content-Type": "text/event-stream" })
            const fakeChunk = JSON.stringify({
              response: {
                candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
              },
            })
            res.end(`data: ${fakeChunk}\r\n\r\n`)
            session.close()
          })
          return
        }

        // Stream and parse SSE
        let sseBuffer = ""
        let accText = ""
        let accThinking = ""
        let totalBytes = 0
        let rawSSE = ""  // accumulate full SSE for logging
        const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = []
        let finishReason = ""
        let thinkingSignature = ""
        let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, thinkingTokens = 0

        h2req.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length
          const chunkStr = chunk.toString()
          rawSSE += chunkStr
          sseBuffer += chunkStr

          const parts = sseBuffer.split("\n")
          sseBuffer = parts.pop()!

          for (const line of parts) {
            const parsed = parseGeminiSSE(line)
            if (!parsed) continue

            const inner = (parsed as any).response ?? parsed

            if (inner.usageMetadata) {
              inputTokens = inner.usageMetadata.promptTokenCount ?? 0
              outputTokens = inner.usageMetadata.candidatesTokenCount ?? 0
              cacheReadTokens = inner.usageMetadata.cachedContentTokenCount ?? 0
              thinkingTokens = inner.usageMetadata.thoughtsTokenCount ?? 0
            }

            const candidate = inner.candidates?.[0]
            if (!candidate) continue
            if (candidate.finishReason) finishReason = candidate.finishReason

            for (const part of candidate.content?.parts ?? []) {
              if (part.text !== undefined) {
                if ((part as any).thought === true) {
                  accThinking += part.text
                  const sig = (part as any).thoughtSignature
                  if (sig) thinkingSignature = sig
                  ctx.emitter.emit("event", {
                    type: "thinking_delta", text: accThinking,
                    ...(thinkingSignature ? { signature: thinkingSignature } : {}),
                  } satisfies MitmEvent)
                } else {
                  accText += part.text
                  ctx.emitter.emit("event", { type: "text_delta", text: accText } satisfies MitmEvent)
                }
              }
              if (part.functionCall) {
                functionCalls.push({ name: part.functionCall.name, args: part.functionCall.args })
              }
            }
          }
        })

        h2req.on("end", () => {
          console.log(`[MITM] #${reqId} Done: ${totalBytes}B, text=${accText.length}b, thinking=${accThinking.length}b`)
          // Log request/response (log the modified body actually sent to Google)
          try {
            const reqJson = JSON.parse(finalBody.toString())
            writeLog(reqId, { method: reqMethod, path: reqPath, body: reqJson }, { status: statusCode, sse: rawSSE })
          } catch {
            writeLog(reqId, { method: reqMethod, path: reqPath, bodySize: finalBody.length }, { status: statusCode, sse: rawSSE })
          }
          if (functionCalls.length > 0) {
            ctx.emitter.emit("event", { type: "function_call", calls: functionCalls } satisfies MitmEvent)
          }
          ctx.emitter.emit("event", { type: "usage", inputTokens, outputTokens, cacheReadTokens, thinkingTokens } satisfies MitmEvent)
          ctx.emitter.emit("event", { type: "done", finishReason: finishReason || "STOP" } satisfies MitmEvent)
          // Send fake STOP to LS
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          const fakeChunk = JSON.stringify({
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
            },
          })
          res.end(`data: ${fakeChunk}\r\n\r\n`)
          session.close()
        })
      } else {
        // ── Pass-through ──
        const responseChunks: Buffer[] = []
        h2req.on("data", (chunk: Buffer) => { responseChunks.push(chunk) })
        h2req.on("end", () => {
          const fullBody = Buffer.concat(responseChunks)
          console.log(`[MITM] #${reqId} pass-through response: ${statusCode} (${fullBody.length} bytes)`)
          const skipH2 = new Set([":status", "transfer-encoding", "connection"])
          const outHeaders: Record<string, string> = {}
          for (const [key, val] of Object.entries(responseHeaders)) {
            if (val && !skipH2.has(key)) {
              outHeaders[key] = Array.isArray(val) ? val.join(", ") : String(val)
            }
          }
          outHeaders["content-length"] = String(fullBody.length)
          res.writeHead(statusCode, outHeaders)
          res.end(fullBody)
          session.close()
        })
      }
    })

    h2req.on("error", (e: Error) => {
      console.error(`[MITM] Proxy error:`, e.message)
      if (!res.headersSent) res.writeHead(502)
      res.end(e.message)
      if (ctx) {
        ctx.emitter.emit("event", { type: "error", message: `Proxy error: ${e.message}` } satisfies MitmEvent)
      }
      session.close()
    })
  }

  server.listen(MITM_PORT, "127.0.0.1", () => {
    console.log(`[MITM] HTTP proxy listening on 127.0.0.1:${MITM_PORT}`)
  })

  return {
    port: MITM_PORT,
    close: () => server.close(),
  }
}
