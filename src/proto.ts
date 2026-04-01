/**
 * Proto schema loading and USS encoding for Antigravity binary communication.
 *
 * Schemas are pre-extracted from the Antigravity extension.js bundle and
 * stored in schemas.json. No runtime dependency on Antigravity.app.
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { create, toBinary } from "@bufbuild/protobuf"
import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv1"
import * as pbwkt from "@bufbuild/protobuf/wkt"

const __dirname = dirname(fileURLToPath(import.meta.url))

let _schemas: ReturnType<typeof loadSchemas> | null = null

function loadSchemas() {
  // Load pre-extracted schemas from bundled JSON
  const schemasPath = join(__dirname, "schemas.json")
  const allDescs: Record<string, { b64: string; deps: string[]; loaded: any }> =
    JSON.parse(readFileSync(schemasPath, "utf8"))

  // Mark all as not-yet-loaded
  for (const v of Object.values(allDescs)) {
    v.loaded = null
  }

  const wktMap: Record<string, any> = {}
  for (const [n, v] of Object.entries(pbwkt)) {
    if (n.startsWith("file_")) wktMap[n] = v
  }

  function loadDesc(name: string): any {
    if (wktMap[name]) return wktMap[name]
    if (!allDescs[name]) return null
    if (allDescs[name].loaded) return allDescs[name].loaded
    const df: any[] = []
    for (const d of allDescs[name].deps) {
      const x = loadDesc(d)
      if (x) df.push(x)
    }
    try {
      allDescs[name].loaded = fileDesc(allDescs[name].b64, df)
      return allDescs[name].loaded
    } catch {
      return null
    }
  }

  const ussFile = loadDesc("file_exa_unified_state_sync_pb_unified_state_sync")
  const extFile = loadDesc("file_exa_extension_server_pb_extension_server")
  const lsFile = loadDesc("file_exa_language_server_pb_language_server")

  if (!ussFile || !extFile || !lsFile) {
    throw new Error("Failed to load required proto schemas")
  }

  return {
    TopicSchema: messageDesc(ussFile, 0),
    RowSchema: messageDesc(ussFile, 1),
    USSUpdateSchema: messageDesc(extFile, 101),
    OAuthTokenInfoSchema: messageDesc(lsFile, 279),
  }
}

/** Get or lazily load proto schemas */
export function getSchemas() {
  if (!_schemas) {
    _schemas = loadSchemas()
  }
  return _schemas
}

/** Build a USS initial_state envelope with OAuth token */
export function buildOAuthUSSUpdate(
  accessToken: string,
  refreshToken: string,
  tokenType = "Bearer",
): Buffer {
  const { TopicSchema, RowSchema, USSUpdateSchema, OAuthTokenInfoSchema } =
    getSchemas()

  const tokenObj = (create as any)(OAuthTokenInfoSchema, {
    accessToken,
    tokenType,
    refreshToken,
    expiry: {
      seconds: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nanos: 0,
    },
    isGcpTos: false,
  })

  const tokenBin = toBinary(OAuthTokenInfoSchema, tokenObj)
  const tokenBase64 = Buffer.from(tokenBin).toString("base64")

  const topicObj = (create as any)(TopicSchema, {
    data: {
      oauthTokenInfoSentinelKey: (create as any)(RowSchema, { value: tokenBase64 }),
    },
  })

  const updateObj = (create as any)(USSUpdateSchema, {
    updateType: { case: "initialState", value: topicObj },
  })

  return Buffer.from(toBinary(USSUpdateSchema, updateObj))
}

/** Encode a protobuf message into a ConnectRPC envelope frame */
export function encodeEnvelope(protoBuf: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(flags, 0)
  header.writeUInt32BE(protoBuf.length, 1)
  return Buffer.concat([header, protoBuf])
}

/** Manual proto: encode bytes field */
export function protoEncodeBytes(fieldNum: number, buf: Buffer): Buffer {
  const tag = Buffer.from([(fieldNum << 3) | 2])
  let len = buf.length
  const lb: number[] = []
  while (len > 0x7f) {
    lb.push((len & 0x7f) | 0x80)
    len >>= 7
  }
  lb.push(len & 0x7f)
  return Buffer.concat([tag, Buffer.from(lb), buf])
}

/** Decode ConnectRPC envelope frames */
export function decodeEnvelopes(buf: Buffer) {
  const frames: Array<{ flags: number; body: Buffer }> = []
  let pos = 0
  while (pos + 5 <= buf.length) {
    const flags = buf[pos]
    const len = buf.readUInt32BE(pos + 1)
    if (pos + 5 + len > buf.length) break
    frames.push({ flags, body: buf.subarray(pos + 5, pos + 5 + len) })
    pos += 5 + len
  }
  return frames
}

/** Simple proto string field decoder */
export function protoDecodeFields(buf: Buffer): Record<string, any> {
  const result: Record<string, any> = {}
  let pos = 0
  while (pos < buf.length) {
    const byte = buf[pos++]
    const fn = byte >> 3
    const wt = byte & 7
    if (wt === 2) {
      let len = 0, shift = 0
      while (pos < buf.length) {
        const b = buf[pos++]
        len |= (b & 0x7f) << shift
        if (!(b & 0x80)) break
        shift += 7
      }
      result[`field${fn}`] = buf.subarray(pos, pos + len).toString("utf8")
      pos += len
    } else if (wt === 0) {
      let v = 0n, shift = 0n
      while (pos < buf.length) {
        const b = buf[pos++]
        v |= BigInt(b & 0x7f) << shift
        if (!(b & 0x80)) break
        shift += 7n
      }
      result[`field${fn}`] = Number(v)
    }
  }
  return result
}
