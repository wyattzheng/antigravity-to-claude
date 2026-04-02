/**
 * server.ts — Anthropic Messages API compatible HTTP server.
 *
 * Accepts POST /v1/messages in Anthropic format, translates to Gemini,
 * routes through LS + MITM proxy, and returns results in Anthropic format.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { EventEmitter } from "events"
import { randomUUID } from "crypto"
import type { Backend } from "./backend.js"
import { MitmStore, type MitmEvent, type RequestContext } from "./store.js"
import {
  anthropicMessagesToGemini,
  anthropicToolsToGemini,
  anthropicSystemToGemini,
  anthropicToolChoiceToGemini,
  geminiStopReasonToAnthropic,
  type AnthropicMessage,
  type AnthropicTool,
  type AnthropicResponseBlock,
} from "./translate.js"

// ─── Request body type ───────────────────────────────────────────────────────

interface MessagesRequest {
  model: string
  max_tokens: number
  system?: string | Array<{ type: string; text: string }>
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
  tool_choice?: unknown
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
}

// ─── Model mapping ──────────────────────────────────────────────────────────

const MODEL_MAP: Record<string, number> = {
  "gemini-2.5-pro": 1026,
  "gemini-2.5-flash": 1027, // placeholder
}

function resolveModel(name: string): { planModel: number; displayName: string } | null {
  // Allow direct numeric model IDs
  if (/^\d+$/.test(name)) {
    return { planModel: parseInt(name, 10), displayName: `model-${name}` }
  }
  const planModel = MODEL_MAP[name]
  if (planModel) return { planModel, displayName: name }
  // Default to first available
  return { planModel: 1026, displayName: name }
}

// ─── Anthropic SSE helpers ───────────────────────────────────────────────────

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

export interface LlmServerOptions {
  backend: Backend
  store: MitmStore
  port?: number
}

export function startLlmServer(opts: LlmServerOptions): { port: number; close(): void } {
  const { backend, store, port = 8080 } = opts

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        return handleModels(res)
      }
      if (req.method === "POST" && req.url === "/v1/messages") {
        return await handleMessages(req, res, backend, store)
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok" }))
        return
      }
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { type: "not_found_error", message: "Not found" } }))
    } catch (e) {
      console.error("[Server] Error:", e)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { type: "api_error", message: String(e) } }))
    }
  })

  server.listen(port, () => {
    console.log(`[Server] Anthropic-compatible API listening on http://localhost:${port}`)
    console.log(`[Server]   POST /v1/messages`)
    console.log(`[Server]   GET  /v1/models`)
  })

  return { port, close: () => server.close() }
}

// ─── GET /v1/models ──────────────────────────────────────────────────────────

function handleModels(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({
    data: Object.keys(MODEL_MAP).map(name => ({
      id: name,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "google",
    })),
  }))
}

// ─── POST /v1/messages ───────────────────────────────────────────────────────

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  backend: Backend,
  store: MitmStore,
): Promise<void> {
  // Parse request body
  const body = await readBody(req)
  let parsed: MessagesRequest
  try {
    parsed = JSON.parse(body)
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid JSON" } }))
    return
  }

  const model = resolveModel(parsed.model)
  if (!model) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: `Unknown model: ${parsed.model}` } }))
    return
  }

  console.log(`[Server] POST /v1/messages model=${parsed.model} stream=${parsed.stream ?? false} messages=${parsed.messages.length} tools=${parsed.tools?.length ?? 0}`)

  // Translate Anthropic → Gemini
  const systemPrompt = anthropicSystemToGemini(parsed.system)
  const contents = anthropicMessagesToGemini(parsed.messages)
  const tools = anthropicToolsToGemini(parsed.tools)
  const toolConfig = parsed.tools?.length
    ? (anthropicToolChoiceToGemini(parsed.tool_choice) ?? { functionCallingConfig: { mode: "AUTO" } })
    : undefined

  // Build generation config
  const generationConfig: Record<string, unknown> = {}
  if (parsed.max_tokens) generationConfig.maxOutputTokens = parsed.max_tokens
  if (parsed.temperature !== undefined) generationConfig.temperature = parsed.temperature
  if (parsed.top_p !== undefined) generationConfig.topP = parsed.top_p
  if (parsed.top_k !== undefined) generationConfig.topK = parsed.top_k
  if (parsed.stop_sequences) generationConfig.stopSequences = parsed.stop_sequences

  // Create event emitter for MITM response capture
  const emitter = new EventEmitter()

  // Register in MITM store — the proxy will pick this up
  console.log(`[Server] Creating cascade...`)
  const cascadeId = await backend.createCascade()
  console.log(`[Server] Cascade created: ${cascadeId}`)

  const ctx: RequestContext = {
    cascadeId,
    systemPrompt,
    contents,
    tools,
    toolConfig,
    generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
    emitter,
    createdAt: Date.now(),
  }

  store.register(ctx)
  console.log(`[Server] Context registered, sending message...`)

  // Send placeholder message to LS — triggers streamGenerateContent.
  // This is a long-lived streaming RPC (returns when cascade completes).
  // We get our response from MITM events, so just fire and catch errors.
  backend.sendMessage(cascadeId, `.<cid:${cascadeId}>`).catch((e) => {
    console.log(`[Server] SendMessage RPC ended: ${e.message ?? "ok"}`)
  })
  console.log(`[Server] SendMessage fired, waiting for MITM response...`)

  if (parsed.stream) {
    await handleStreamingResponse(res, emitter, parsed.model, cascadeId)
  } else {
    await handleSyncResponse(res, emitter, parsed.model, cascadeId)
  }
}

// ─── Streaming response (Anthropic SSE format) ──────────────────────────────

async function handleStreamingResponse(
  res: ServerResponse,
  emitter: EventEmitter,
  model: string,
  msgId: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  })

  const id = `msg_${msgId.replace(/-/g, "").substring(0, 24)}`

  // message_start
  sseWrite(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  let contentIndex = 0
  let hasToolCalls = false
  let lastThinkingLen = 0
  let lastTextLen = 0
  let thinkingStarted = false
  let textStarted = false
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      sseWrite(res, "error", { type: "error", error: { type: "timeout", message: "Response timeout" } })
      res.end()
      resolve()
    }, 120_000)

    emitter.on("event", (event: MitmEvent) => {
      switch (event.type) {
        case "thinking_delta": {
          if (!thinkingStarted) {
            // Close text block if it was open
            if (textStarted) {
              sseWrite(res, "content_block_stop", { type: "content_block_stop", index: contentIndex })
              contentIndex++
              textStarted = false
            }
            thinkingStarted = true
            sseWrite(res, "content_block_start", {
              type: "content_block_start",
              index: contentIndex,
              content_block: { type: "thinking", thinking: "" },
            })
          }
          const delta = event.text.substring(lastThinkingLen)
          if (delta) {
            sseWrite(res, "content_block_delta", {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "thinking_delta", thinking: delta },
            })
            lastThinkingLen = event.text.length
          }
          break
        }

        case "text_delta": {
          if (!textStarted) {
            // Close thinking block if it was open
            if (thinkingStarted) {
              sseWrite(res, "content_block_stop", { type: "content_block_stop", index: contentIndex })
              contentIndex++
            }
            textStarted = true
            sseWrite(res, "content_block_start", {
              type: "content_block_start",
              index: contentIndex,
              content_block: { type: "text", text: "" },
            })
          }
          const delta = event.text.substring(lastTextLen)
          if (delta) {
            sseWrite(res, "content_block_delta", {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "text_delta", text: delta },
            })
            lastTextLen = event.text.length
          }
          break
        }

        case "function_call": {
          hasToolCalls = true
          // Close any open text block
          if (textStarted || thinkingStarted) {
            sseWrite(res, "content_block_stop", { type: "content_block_stop", index: contentIndex })
            contentIndex++
          }
          // Emit each tool call as a content block
          for (const call of event.calls) {
            const toolId = `toolu_${randomUUID().replace(/-/g, "").substring(0, 24)}`
            sseWrite(res, "content_block_start", {
              type: "content_block_start",
              index: contentIndex,
              content_block: { type: "tool_use", id: toolId, name: call.name, input: {} },
            })
            sseWrite(res, "content_block_delta", {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) },
            })
            sseWrite(res, "content_block_stop", { type: "content_block_stop", index: contentIndex })
            contentIndex++
          }
          break
        }

        case "usage":
          usage = {
            input_tokens: event.inputTokens,
            output_tokens: event.outputTokens,
            cache_read_input_tokens: event.cacheReadTokens,
          }
          break

        case "done": {
          // Close any open block
          if ((textStarted || thinkingStarted) && !hasToolCalls) {
            sseWrite(res, "content_block_stop", { type: "content_block_stop", index: contentIndex })
          }

          const stopReason = geminiStopReasonToAnthropic(event.finishReason, hasToolCalls)
          sseWrite(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
          })
          sseWrite(res, "message_stop", { type: "message_stop" })
          clearTimeout(timeout)
          res.end()
          resolve()
          break
        }

        case "error":
          sseWrite(res, "error", {
            type: "error",
            error: { type: "api_error", message: event.message },
          })
          clearTimeout(timeout)
          res.end()
          resolve()
          break
      }
    })
  })
}

// ─── Synchronous response ────────────────────────────────────────────────────

async function handleSyncResponse(
  res: ServerResponse,
  emitter: EventEmitter,
  model: string,
  msgId: string,
): Promise<void> {
  const id = `msg_${msgId.replace(/-/g, "").substring(0, 24)}`

  return new Promise<void>((resolve) => {
    let fullText = ""
    let fullThinking = ""
    let hasToolCalls = false
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
    let finishReason = "STOP"

    const timeout = setTimeout(() => {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { type: "api_error", message: "Response timeout" } }))
      resolve()
    }, 120_000)

    emitter.on("event", (event: MitmEvent) => {
      switch (event.type) {
        case "thinking_delta":
          fullThinking = event.text
          break
        case "text_delta":
          fullText = event.text
          break
        case "function_call":
          hasToolCalls = true
          toolCalls.push(...event.calls)
          break
        case "usage":
          usage = {
            input_tokens: event.inputTokens,
            output_tokens: event.outputTokens,
            cache_read_input_tokens: event.cacheReadTokens,
          }
          break
        case "done": {
          finishReason = event.finishReason
          clearTimeout(timeout)
          if (res.headersSent) { resolve(); break }

          const content: AnthropicResponseBlock[] = []
          if (fullThinking) content.push({ type: "thinking", thinking: fullThinking })
          if (fullText) content.push({ type: "text", text: fullText })
          for (const call of toolCalls) {
            content.push({
              type: "tool_use",
              id: `toolu_${randomUUID().replace(/-/g, "").substring(0, 24)}`,
              name: call.name,
              input: call.args,
            })
          }

          const stopReason = geminiStopReasonToAnthropic(finishReason, hasToolCalls)

          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            content,
            model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage,
          }))
          resolve()
          break
        }
        case "error":
          clearTimeout(timeout)
          if (res.headersSent) { resolve(); break }
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { type: "api_error", message: event.message } }))
          resolve()
          break
      }
    })
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}
