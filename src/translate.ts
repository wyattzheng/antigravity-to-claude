/**
 * translate.ts — Anthropic ↔ Gemini format conversion.
 *
 * Translates between Anthropic Messages API format and Google Gemini API format
 * for system prompts, messages, tools, and responses.
 */

import type { GeminiContent, GeminiFunctionDecl, GeminiPart } from "./store.js"

// ─── Anthropic input types ───────────────────────────────────────────────────

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }

export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// ─── Anthropic output types ──────────────────────────────────────────────────

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: AnthropicResponseBlock[]
  model: string
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
}

export type AnthropicResponseBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

// ─── Messages: Anthropic → Gemini ────────────────────────────────────────────

export function anthropicMessagesToGemini(messages: AnthropicMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user"
    const parts: GeminiPart[] = []

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        switch (block.type) {
          case "text":
            parts.push({ text: block.text })
            break
          case "tool_use":
            parts.push({
              functionCall: { name: block.name, args: block.input },
            })
            break
          case "tool_result": {
            const resultText = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("\n")
                : ""
            // Find the tool name from previous assistant message
            const toolName = findToolNameById(messages, block.tool_use_id) ?? "unknown"
            parts.push({
              functionResponse: {
                name: toolName,
                response: { result: resultText },
              },
            })
            break
          }
          case "image":
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            })
            break
        }
      }
    }

    if (parts.length > 0) {
      // Gemini requires alternating user/model roles.
      // tool_result from user side should be a "user" message with functionResponse parts.
      // Merge consecutive same-role messages.
      const last = contents[contents.length - 1]
      if (last && last.role === role) {
        last.parts.push(...parts)
      } else {
        contents.push({ role, parts })
      }
    }
  }

  return contents
}

/** Find tool name by tool_use_id in previous assistant messages */
function findToolNameById(messages: AnthropicMessage[], toolUseId: string): string | null {
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return block.name
        }
      }
    }
  }
  return null
}

// ─── System Prompt: Anthropic → Gemini ───────────────────────────────────────

export function anthropicSystemToGemini(
  system: string | Array<{ type: string; text: string }> | undefined
): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system.filter(b => b.type === "text").map(b => b.text).join("\n")
}

// ─── Tools: Anthropic → Gemini ───────────────────────────────────────────────

export function anthropicToolsToGemini(
  tools: AnthropicTool[] | undefined
): Array<{ functionDeclarations: GeminiFunctionDecl[] }> | undefined {
  if (!tools || tools.length === 0) return undefined
  const decls: GeminiFunctionDecl[] = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }))
  return [{ functionDeclarations: decls }]
}

// ─── Tool Config ─────────────────────────────────────────────────────────────

export function anthropicToolChoiceToGemini(
  toolChoice: unknown
): Record<string, unknown> | undefined {
  if (!toolChoice) return undefined
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto": return { functionCallingConfig: { mode: "AUTO" } }
      case "any": return { functionCallingConfig: { mode: "ANY" } }
      case "none": return { functionCallingConfig: { mode: "NONE" } }
      default: return { functionCallingConfig: { mode: "AUTO" } }
    }
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const tc = toolChoice as Record<string, unknown>
    if (tc.type === "tool" && typeof tc.name === "string") {
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [tc.name],
        },
      }
    }
  }
  return { functionCallingConfig: { mode: "AUTO" } }
}

// ─── Response: Gemini → Anthropic SSE events ─────────────────────────────────

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
}

/** Parse SSE `data:` lines from Gemini streaming response */
export function parseGeminiSSE(line: string): GeminiStreamChunk | null {
  if (!line.startsWith("data: ")) return null
  const json = line.slice(6).trim()
  if (!json || json === "[DONE]") return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Map Gemini finishReason to Anthropic stop_reason */
export function geminiStopReasonToAnthropic(
  reason: string | undefined,
  hasToolCalls: boolean
): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
  if (hasToolCalls) return "tool_use"
  switch (reason) {
    case "MAX_TOKENS": return "max_tokens"
    case "STOP": return "end_turn"
    default: return "end_turn"
  }
}
