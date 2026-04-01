/**
 * E2E tests for antigravity-llm-server Anthropic Messages API.
 *
 * Requires REFRESH_TOKEN env var to be set with a valid Google OAuth refresh token.
 * These tests make real API calls to Google via the MITM proxy.
 *
 * Run: REFRESH_TOKEN="1//0gXXX..." pnpm --filter antigravity-llm-server test:e2e
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest"

const PORT = 18080
const BASE = `http://localhost:${PORT}`

// ─── Test helpers ────────────────────────────────────────────────────────────

async function postMessages(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function readSSE(response: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await response.text()
  const events: Array<{ event: string; data: any }> = []
  const lines = text.split("\n")
  let currentEvent = ""

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7)
    } else if (line.startsWith("data: ")) {
      const raw = line.slice(6)
      try {
        events.push({ event: currentEvent, data: JSON.parse(raw) })
      } catch {
        events.push({ event: currentEvent, data: raw })
      }
    }
  }
  return events
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Anthropic Messages API", () => {
  // Server must be started externally before running tests
  // e.g. REFRESH_TOKEN="..." PORT=18080 node dist/cli.js

  test("GET /health returns ok", async () => {
    const res = await fetch(`${BASE}/health`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe("ok")
  })

  test("GET /v1/models returns model list", async () => {
    const res = await fetch(`${BASE}/v1/models`)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.data).toBeInstanceOf(Array)
    expect(json.data.length).toBeGreaterThan(0)
    expect(json.data[0]).toHaveProperty("id")
  })

  test("POST /v1/messages — basic text (non-streaming)", async () => {
    const res = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 100,
      messages: [{ role: "user", content: "Say exactly: hello world" }],
    })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
    expect(json.content).toBeInstanceOf(Array)
    expect(json.content[0].type).toBe("text")
    expect(json.content[0].text).toBeTruthy()
    expect(json.stop_reason).toBe("end_turn")
    expect(json.usage).toHaveProperty("input_tokens")
    expect(json.usage).toHaveProperty("output_tokens")
  }, 30_000)

  test("POST /v1/messages — streaming text", async () => {
    const res = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "Say exactly: hi" }],
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const events = await readSSE(res)

    // Must have message_start
    const start = events.find(e => e.event === "message_start")
    expect(start).toBeTruthy()
    expect(start!.data.message.role).toBe("assistant")

    // Must have content_block_start (text)
    const blockStart = events.find(e => e.event === "content_block_start")
    expect(blockStart).toBeTruthy()

    // Must have at least one content_block_delta
    const deltas = events.filter(e => e.event === "content_block_delta")
    expect(deltas.length).toBeGreaterThan(0)

    // Must have message_stop
    const stop = events.find(e => e.event === "message_stop")
    expect(stop).toBeTruthy()
  }, 30_000)

  test("POST /v1/messages — custom system prompt", async () => {
    const res = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 100,
      system: "You are a pirate. Always respond in pirate speak.",
      messages: [{ role: "user", content: "How do you greet someone?" }],
    })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    const text = json.content[0].text.toLowerCase()
    // Pirate speak should contain pirate-y words
    expect(text).toMatch(/ahoy|matey|arr|yo ho|shiver|avast|seadog/i)
  }, 30_000)

  test("POST /v1/messages — tool calling", async () => {
    const res = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 200,
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [{
        name: "get_weather",
        description: "Get the current weather for a location",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
          },
          required: ["location"],
        },
      }],
    })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.stop_reason).toBe("tool_use")

    const toolUse = json.content.find((b: any) => b.type === "tool_use")
    expect(toolUse).toBeTruthy()
    expect(toolUse.name).toBe("get_weather")
    expect(toolUse.input).toHaveProperty("location")
  }, 30_000)

  test("POST /v1/messages — tool result round trip", async () => {
    // First request: model should call the tool
    const res1 = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 200,
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: [{
        name: "get_weather",
        description: "Get the current weather for a location",
        input_schema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      }],
    })
    const json1 = await res1.json() as any
    const toolUse = json1.content.find((b: any) => b.type === "tool_use")
    expect(toolUse).toBeTruthy()

    // Second request: send tool result back
    const res2 = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 200,
      messages: [
        { role: "user", content: "What's the weather in Paris?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: toolUse.id, name: "get_weather", input: toolUse.input },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUse.id, content: "Sunny, 22°C" },
          ],
        },
      ],
      tools: [{
        name: "get_weather",
        description: "Get the current weather for a location",
        input_schema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      }],
    })

    expect(res2.status).toBe(200)
    const json2 = await res2.json() as any
    expect(json2.stop_reason).toBe("end_turn")
    const text = json2.content.find((b: any) => b.type === "text")
    expect(text).toBeTruthy()
    // Response should mention the weather data
    expect(text.text.toLowerCase()).toMatch(/sunny|22|paris/)
  }, 60_000)

  test("POST /v1/messages — multi-turn conversation", async () => {
    const res = await postMessages({
      model: "gemini-2.5-pro",
      max_tokens: 100,
      messages: [
        { role: "user", content: "My name is Alice." },
        { role: "assistant", content: "Nice to meet you, Alice!" },
        { role: "user", content: "What's my name?" },
      ],
    })

    expect(res.status).toBe(200)
    const json = await res.json() as any
    const text = json.content[0].text.toLowerCase()
    expect(text).toContain("alice")
  }, 30_000)
})
