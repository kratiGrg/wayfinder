'use strict'
const crypto = require('crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { z } = require('zod')
const tools = require('./lib/tools')

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

// Secrets (keys) are never logged. Log request ids and error codes only.
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
  server.registerTool('get_manifest', {
    description: 'Fetch the complete default-version Brand Concierge manifest by manifest_id, sandbox_id and Adobe org_id.',
    inputSchema: {
      manifest_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).describe('Manifest identifier'),
      sandbox_id: z.string().uuid().describe('Sandbox ID for the x-sandbox-id header'),
      org_id: z.string().max(200).regex(/^[A-Za-z0-9_-]+@AdobeOrg$/).describe('Adobe organization ID for the x-gw-ims-org-id header')
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async (args) => {
    try {
      log('get_manifest', args.manifest_id)
      return asText(await tools.getManifest(cfg, args, tools.makeDeadline(tools.TOTAL_BUDGET_MS)), true)
    } catch (e) { log('get_manifest_error', e.message); return asError(e) }
  })
  server.registerTool('update_manifest', {
    description: 'Request compilation/update of a Brand Concierge manifest through the compile-request endpoint. May change server state; does not accept replacement manifest JSON.',
    inputSchema: {
      manifest_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).describe('Manifest identifier'),
      sandbox_id: z.string().uuid().describe('Sandbox ID for the x-sandbox-id header'),
      org_id: z.string().max(200).regex(/^[A-Za-z0-9_-]+@AdobeOrg$/).describe('Adobe organization ID for the x-gw-ims-org-id header')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (args) => {
    try {
      log('update_manifest', args.manifest_id)
      return asText(await tools.updateManifest(cfg, args, tools.makeDeadline(tools.TOTAL_BUDGET_MS)), true)
    } catch (e) { log('update_manifest_error', e.message); return asError(e) }
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

function parseBody (params) {
  const body = params.__ow_body
  if (typeof body !== 'string') return body
  const t = body.trim()
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t)
  return JSON.parse(Buffer.from(body, 'base64').toString('utf8')) // raw-http base64-encodes JSON
}

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })

async function main (params) {
  if ((params.__ow_method || '').toLowerCase() !== 'post') return { statusCode: 405, headers: { Allow: 'POST' }, body: '' }
  if (!authorized(params)) return json(401, { error: 'unauthorized' })

  let message
  try { message = parseBody(params) } catch (e) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (!message || typeof message !== 'object') {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty body' } })
  }

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
