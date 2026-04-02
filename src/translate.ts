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
  | { type: "thinking"; thinking: string }
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
            if (block.text) parts.push({ text: block.text })
            break
          case "thinking": {
            const tb = block as any
            const part: any = { thought: true, text: tb.thinking ?? "" }
            if (tb.signature) part.thoughtSignature = tb.signature
            parts.push(part)
            break
          }
          case "tool_use":
            parts.push({
              functionCall: { name: block.name, args: block.input, id: block.id },
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
                id: block.tool_use_id,
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
    parameters: sanitizeSchemaForGemini(t.input_schema),
  }))
  return [{ functionDeclarations: decls }]
}

/**
 * Recursively translate JSON Schema to Gemini-compatible format.
 * Gemini supports: type, description, enum, items, properties, required, nullable, format.
 * We translate what we can, and only drop truly unsupported metadata.
 */
function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  // Gemini-supported keys (pass through directly)
  const SUPPORTED_KEYS = new Set([
    "type", "description", "enum", "items", "properties",
    "required", "nullable", "format",
    "minimum", "maximum", "minItems", "maxItems",
    "minLength", "maxLength", "pattern",
  ])

  // Pure metadata — safe to drop
  const DROP_KEYS = new Set([
    "$schema", "$id", "$comment", "$ref", "$defs",
    "contentMediaType", "contentEncoding",
    "unevaluatedProperties", "unevaluatedItems",
    "dependencies", "dependentRequired", "dependentSchemas",
    "patternProperties", "propertyNames",
    "if", "then", "else", "not",
    "minContains", "maxContains", "prefixItems",
    "readOnly", "writeOnly", "deprecated",
  ])

  const result: Record<string, unknown> = {}
  const descParts: string[] = []

  // Collect existing description
  if (typeof schema.description === "string") {
    descParts.push(schema.description)
  }

  // Translate `title` → prepend to description
  if (typeof schema.title === "string" && schema.title !== schema.description) {
    descParts.unshift(schema.title)
  }

  // Translate `default` → append to description
  if (schema.default !== undefined) {
    descParts.push(`Default: ${JSON.stringify(schema.default)}`)
  }

  // Translate `examples` → append to description
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    descParts.push(`Examples: ${schema.examples.map(e => JSON.stringify(e)).join(", ")}`)
  }

  // Translate `const` → enum with single value
  if (schema.const !== undefined) {
    result.enum = [schema.const]
  }

  // Translate `anyOf` / `oneOf` → flatten (use first object-typed schema, or merge)
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      const variants = schema[key] as Record<string, unknown>[]
      // Filter out null-type variants (common pattern: {anyOf: [{type: "string"}, {type: "null"}]})
      const nonNull = variants.filter(v => v.type !== "null")
      const hasNull = variants.some(v => v.type === "null")
      if (hasNull) result.nullable = true
      if (nonNull.length === 1) {
        // Simple nullable pattern — merge the non-null variant
        const merged = sanitizeSchemaForGemini(nonNull[0])
        Object.assign(result, merged)
      } else if (nonNull.length > 1) {
        // Multiple types — describe them, use the first
        const merged = sanitizeSchemaForGemini(nonNull[0])
        Object.assign(result, merged)
        const typeNames = nonNull.map(v => String(v.type ?? "unknown")).join(" | ")
        descParts.push(`(accepts: ${typeNames})`)
      }
    }
  }

  // Translate `allOf` → merge all schemas
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Record<string, unknown>[]) {
      const merged = sanitizeSchemaForGemini(sub)
      Object.assign(result, merged)
    }
  }

  // Translate `additionalProperties` → describe in description
  if (schema.additionalProperties === false) {
    // Just drop it — Gemini doesn't support it
  } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
    descParts.push(`Additional properties schema: ${JSON.stringify(schema.additionalProperties)}`)
  }

  // Process supported keys
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYS.has(key)) continue
    if (key === "description" || key === "title" || key === "default" || key === "examples" ||
        key === "const" || key === "anyOf" || key === "oneOf" || key === "allOf" ||
        key === "additionalProperties") continue // already handled
    if (result[key] !== undefined) continue // already set by translation

    if (key === "properties" && typeof value === "object" && value !== null) {
      const sanitizedProps: Record<string, unknown> = {}
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        if (typeof propSchema === "object" && propSchema !== null) {
          sanitizedProps[propName] = sanitizeSchemaForGemini(propSchema as Record<string, unknown>)
        } else {
          sanitizedProps[propName] = propSchema
        }
      }
      result[key] = sanitizedProps
    } else if (key === "items" && typeof value === "object" && value !== null) {
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else if (SUPPORTED_KEYS.has(key)) {
      result[key] = value
    }
    // Unknown keys not in SUPPORTED or DROP → silently skip
  }

  // Set merged description
  if (descParts.length > 0) {
    result.description = descParts.join(". ")
  }

  return result
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
