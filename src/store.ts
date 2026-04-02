/**
 * MitmStore — per-request context management for MITM proxy.
 *
 * Stores the external client's request data (system prompt, messages, tools)
 * so the MITM proxy can replace the LS-generated request body with the client's actual content.
 */

import { EventEmitter } from "events"

// ─── Gemini API types ────────────────────────────────────────────────────────

export interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
  thoughtSignature?: string
}

export interface GeminiContent {
  role: "user" | "model"
  parts: GeminiPart[]
}

export interface GeminiFunctionDecl {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

// ─── MITM events emitted during response capture ─────────────────────────────

export type MitmEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "function_call"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; thinkingTokens: number }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string }

// ─── Request context stored per cascade ──────────────────────────────────────

export interface RequestContext {
  cascadeId: string
  systemPrompt: string
  contents: GeminiContent[]
  tools?: Array<{ functionDeclarations: GeminiFunctionDecl[] }>
  toolConfig?: Record<string, unknown>
  generationConfig?: Record<string, unknown>
  emitter: EventEmitter
  createdAt: number
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class MitmStore {
  private requests = new Map<string, RequestContext>()
  /** Latest request context (for fallback matching by sequence) */
  private latest: RequestContext | null = null

  register(ctx: RequestContext): void {
    this.requests.set(ctx.cascadeId, ctx)
    this.latest = ctx
  }

  /** Find context by cascadeId embedded in user message, or fall back to latest */
  take(cascadeId?: string): RequestContext | null {
    if (cascadeId && this.requests.has(cascadeId)) {
      const ctx = this.requests.get(cascadeId)!
      this.requests.delete(cascadeId)
      if (this.latest === ctx) this.latest = null
      return ctx
    }
    // Fallback: take the latest registered request
    if (this.latest) {
      const ctx = this.latest
      this.requests.delete(ctx.cascadeId)
      this.latest = null
      return ctx
    }
    return null
  }

  /** Extract cascadeId from LS user message text like ".<cid:UUID>" */
  static extractCascadeId(text: string): string | null {
    const m = text.match(/<cid:([^>]+)>/)
    return m ? m[1] : null
  }

  get size(): number {
    return this.requests.size
  }
}
