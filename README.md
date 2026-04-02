# AGCC

Use Google Antigravity's Claude Opus model in [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

AGCC bridges your Google Antigravity account to Claude Code, giving you full access to Claude Opus through the same infrastructure Google uses internally — including its Language Server binary for authentication and API communication.

## Install

```bash
npm install -g agcc
```

## Usage

```bash
agcc start
```

Then launch Claude Code as usual. AGCC handles the rest — OAuth login, request translation, and streaming responses.

## How It Works

AGCC runs a local Anthropic-compatible API server and a MITM proxy in front of Google's Language Server. Rather than reimplementing the Google API client, it uses the **same Language Server binary** that ships with the official IDE extension, ensuring full compatibility with Google's auth flow and API protocol.

```
Claude Code  →  AGCC (Anthropic API)  →  Language Server  →  Google API (Claude Opus)
```

Requests are translated between Anthropic and Gemini formats on the fly, including tool calls, thinking blocks (with signature passthrough), and streaming.

## Requirements

- Node.js ≥ 18
- macOS (ARM) or Linux (x64)
- A Google account with Antigravity access

## License

MIT
