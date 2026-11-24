'use strict'
const crypto = require('crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { z } = require('zod')
const tools = require('./lib/tools')
const { retrievalSchema } = require('./lib/investigate')

// Minimal single-request transport: App Builder actions are stateless request/response.
class OneShotTransport {
  async start () {}
  async close () { if (this.onclose) this.onclose() }
  async send (message) { if (this._onSend) this._onSend(message) }
  handle (message) {
    return new Promise((resolve) => {
      this._onSend = (m) => { if (m.id === message.id && ('result' in m || 'error' in m)) resolve(m) }
      this.onmessage(message)
    })
  }
}

const MAX_OUT = 24000
const asText = (obj, noCap) => {
  let s = JSON.stringify(obj, null, noCap ? 0 : 1)
  if (!noCap && s.length > MAX_OUT) s = s.slice(0, MAX_OUT) + '\n…[truncated]'
  return { content: [{ type: 'text', text: s }] }
}
const asError = (e) => ({ isError: true, content: [{ type: 'text', text: tools.publicError(e) }] })

// Never log headers, bodies, trace content, or raw parser error messages.
const log = (...a) => console.log(JSON.stringify(a))

function buildServer (params, headers) {
  const cfg = tools.buildConfig(params, headers)
  const server = new McpServer({ name: 'wayfinder', version: '0.2.0' })

  server.registerTool('get_trace', {
    description: 'Fetch the complete LangSmith trace for one Brand Concierge request by request_id. By default it returns every run exactly as LangSmith provides it: full prompts, inputs, outputs, metadata and all other fields, nothing filtered. Very large traces are delivered in parts (the result says how many); call again with part=2.. to receive the rest. Use detail=summary only for a short condensed view.',
    inputSchema: {
      request_id: z.string().uuid().describe('metadata.request_id of the request'),
      detail: z.enum(['raw', 'summary', 'full']).optional().describe('raw (default): the complete, unfiltered runs. summary: short condensed view that omits prompts and cuts long text. full: longer condensed view'),
      part: z.number().int().min(1).optional().describe('raw only: which part to return (default 1). Only needed when the result reports more than one part'),
      lookback_days: z.number().int().min(1).max(30).optional().describe('search window in days, default 30')
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (a) => {
    try {
      log('get_trace', a.request_id)
      return asText(await tools.getTrace(cfg, a, tools.makeDeadline(tools.TOTAL_BUDGET_MS)), (a.detail || 'raw') === 'raw')
    } catch (e) { log('get_trace_error', e.message); return asError(e) }
  })
  server.registerTool('investigate', {
    description: 'Diagnose a failed Brand Concierge interaction from its complete LangSmith trace and optional client retrieval evidence. Returns evidence-backed JSON recommending a Composer guardrail/instruction/style review or a Support ticket. Uses a server-owned manifest schema and Bedrock analysis; never modifies configuration or submits tickets.',
    inputSchema: {
      request_id: z.string().uuid().describe('metadata.request_id of the failed interaction'),
      context_ai_response: retrievalSchema.optional().describe('Client-supplied retrieval results: an array of {text, score?, metadata?}. Omit if guardrails prevented search.')
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (a) => {
    try {
      log('investigate', a.request_id)
      return asText(await tools.investigate(cfg, a, tools.makeDeadline(tools.TOTAL_BUDGET_MS)), true)
    } catch (e) {
      log('investigate_error', a.request_id, tools.publicError(e))
      return asError(e)
    }
  })
  const manifestInputs = {
    manifest_id: z.string().uuid().describe('Manifest UUID'),
    sandbox_id: z.string().uuid().describe('Sandbox UUID'),
    org_id: z.string().max(128).regex(/^[A-Za-z0-9]+@AdobeOrg$/).describe('IMS organization ID ending in @AdobeOrg')
  }
  server.registerTool('get_manifest', {
    description: 'Fetch the concierge manifest provided manifest id.',
    inputSchema: manifestInputs,
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (a) => {
    try {
      log('get_manifest', a.manifest_id)
      return asText(await tools.getManifest(cfg, a, tools.makeDeadline(tools.TOTAL_BUDGET_MS)), true)
    } catch (e) {
      log('get_manifest_error', a.manifest_id, tools.publicError(e))
      return asError(e)
    }
  })
  server.registerTool('update_manifest', {
    description: 'Update the concierge manifest.',
    inputSchema: manifestInputs,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (a) => {
    try {
      log('update_manifest', a.manifest_id)
      return asText(await tools.updateManifest(cfg, a, tools.makeDeadline(tools.TOTAL_BUDGET_MS)), true)
    } catch (e) {
      log('update_manifest_error', a.manifest_id, tools.publicError(e))
      return asError(e)
    }
  })
  return server
}

function authorized (params) {
  const expected = params.MCP_API_KEY
  if (!expected) return false // fail closed if the key is not configured
  const header = (params.__ow_headers && params.__ow_headers.authorization) || ''
  const provided = Buffer.from(header.replace(/^Bearer\s+/i, ''))
  const wanted = Buffer.from(expected)
  return provided.length === wanted.length && crypto.timingSafeEqual(provided, wanted)
}

function bodyShape (value) {
  if (typeof value !== 'string') return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const text = value.trim()
  if (!text) return 'empty'
  if (text.startsWith('{')) return 'object_text'
  if (text.startsWith('[')) return 'array_text'
  if (text.startsWith('"')) return 'quoted_text'
  return 'other_text'
}

function parseBody (params, diagnostic) {
  const body = params.__ow_body
  if (typeof body !== 'string') return body
  const t = body.trim()
  diagnostic.encoding = t.startsWith('{') || t.startsWith('[') ? 'plain_json' : 'base64'
  const decoded = diagnostic.encoding === 'plain_json' ? t : Buffer.from(body, 'base64').toString('utf8')
  diagnostic.decoded_length = decoded.length
  diagnostic.decoded_shape = bodyShape(decoded)
  diagnostic.decoded_has_replacement_char = decoded.includes('\uFFFD')
  return JSON.parse(decoded) // raw-http base64-encodes JSON
}

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })

async function main (params) {
  if ((params.__ow_method || '').toLowerCase() !== 'post') return { statusCode: 405, headers: { Allow: 'POST' }, body: '' }
  if (!authorized(params)) return json(401, { error: 'unauthorized' })

  const diagnostic = {
    diagnostic_id: crypto.randomUUID(),
    body_type: typeof params.__ow_body,
    body_length: typeof params.__ow_body === 'string' ? params.__ow_body.length : null,
    body_shape: bodyShape(params.__ow_body),
    content_type: ['application/json', 'text/plain', 'application/x-www-form-urlencoded'].includes(
      String((params.__ow_headers || {})['content-type'] || '').split(';')[0].trim().toLowerCase()
    ) ? String(params.__ow_headers['content-type']).split(';')[0].trim().toLowerCase() : 'other_or_missing',
    top_level_jsonrpc_present: Object.prototype.hasOwnProperty.call(params, 'jsonrpc')
  }
  log('mcp_request_received', diagnostic)
  let message
  try { message = parseBody(params, diagnostic) } catch (e) {
    const position = typeof e.message === 'string' && /\bposition (\d+)\b/.exec(e.message)
    log('mcp_parse_error', {
      ...diagnostic,
      error_code: e instanceof SyntaxError ? 'invalid_json' : 'body_decode_failed',
      json_error_position: position ? Number(position[1]) : null
    })
    return json(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error', data: { diagnostic_id: diagnostic.diagnostic_id } }
    })
  }
  if (!message || typeof message !== 'object') {
    log('mcp_invalid_request', { ...diagnostic, parsed_shape: bodyShape(message) })
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty body' } })
  }
  log('mcp_request_parsed', {
    diagnostic_id: diagnostic.diagnostic_id,
    method: ['initialize', 'tools/list', 'tools/call', 'notifications/initialized', 'ping'].includes(message.method) ? message.method : 'other_or_missing',
    tool: message.method === 'tools/call' && message.params && ['get_trace', 'investigate'].includes(message.params.name) ? message.params.name : null
  })

  const server = buildServer(params, params.__ow_headers || {})
  const transport = new OneShotTransport()
  await server.connect(transport)

  if (message.id === undefined) { // notification: no response body
    transport.onmessage(message)
    return { statusCode: 202, body: '' }
  }
  return json(200, await transport.handle(message))
}

exports.main = main
