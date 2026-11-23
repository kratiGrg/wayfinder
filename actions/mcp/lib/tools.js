'use strict'
const { makeClient } = require('./langsmith')
const { makeClient: makeManifestClient } = require('./manifests')
const { condenseTrace } = require('./trace')
const { makeDeadline } = require('./http')

// LangSmith tracing project (bcos-prod). An identifier, not a secret, so a code default is fine.
// LANGSMITH_PROJECT_ID, if set, overrides it.
const DEFAULT_PROJECT_ID = 'b0734d7e-5e49-4b32-82b4-7f9b644a9fb1'

// LangSmith v2 silently searches only the last 24h unless min_start_time is sent, and a request_id carries
// no timestamp, so the search window is set here.
const LOOKBACK_DAYS = 30

// The complete trace is the default. It is split into parts of whole runs (a run is never cut) only when it exceeds
// this size, so the parts together are always the complete trace. Override with RAW_PART_CHARS if your MCP client
// truncates large tool results.
const DEFAULT_RAW_PART_CHARS = 120000

const TOTAL_BUDGET_MS = 50000 // stay under the ~60s web action limit (verify current Runtime limits)

function buildConfig (p, inbound = {}) {
  return {
    // A per-user key sent on the MCP connection takes precedence over the server-held one.
    langsmith: {
      apiKey: inbound['x-langsmith-api-key'] || p.LANGSMITH_API_KEY,
      projectId: p.LANGSMITH_PROJECT_ID || DEFAULT_PROJECT_ID,
      workspaceId: p.LANGSMITH_WORKSPACE_ID,
      endpoint: p.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com'
    },
    manifest: { bearerToken: p.MANIFEST_BEARER_TOKEN },
    rawPartChars: Math.min(400000, Math.max(20000, parseInt(p.RAW_PART_CHARS, 10) || DEFAULT_RAW_PART_CHARS))
  }
}

// Only these messages reach the client. Anything else becomes a generic message (details stay server-side).
const PUBLIC_ERRORS = {
  invalid_request_id: 'request_id must be a UUID.',
  invalid_project_id: 'LANGSMITH_PROJECT_ID is not a valid UUID.',
  langsmith_not_configured: 'LangSmith is not configured on the server (LANGSMITH_API_KEY missing).',
  manifest_not_configured: 'Manifest service is not configured on the server (MANIFEST_BEARER_TOKEN missing).',
  invalid_manifest_response: 'Manifest service returned invalid JSON.',
  response_too_large: 'The upstream response exceeded the size limit.',
  timeout: 'An upstream call timed out.'
}
function publicError (e) {
  const code = e && e.message
  if (PUBLIC_ERRORS[code]) return PUBLIC_ERRORS[code]
  if (/^manifest_http_\d+$/.test(code)) return 'Manifest service returned an error (' + code.replace('manifest_http_', 'HTTP ') + ').'
  if (/^langsmith_http_(401|403)$/.test(code)) return 'LangSmith rejected the API key or workspace (' + code.replace('langsmith_http_', 'HTTP ') + ').'
  if (code === 'langsmith_http_429') return 'LangSmith rate limit reached. Retry shortly.'
  if (/^langsmith_http_/.test(code)) return 'LangSmith returned an error (' + code.replace('langsmith_http_', 'HTTP ') + ')' + (e.detail ? ': ' + e.detail : '.')
  return 'Internal error. See server logs for the request.'
}

async function getTrace (cfg, args, deadline) {
  if (!cfg.langsmith.apiKey || !cfg.langsmith.projectId) throw new Error('langsmith_not_configured')
  const client = makeClient(cfg.langsmith, deadline)
  const detail = args.detail || 'raw' // complete trace unless the caller asks for a condensed view
  const raw = detail === 'raw'
  const r = await client.runsByRequestId(args.request_id, args.lookback_days || LOOKBACK_DAYS, { raw })
  if (!r.found) return { found: false, note: 'No root run with metadata.request_id matched in the last 30 days. If the trace is older than the retention period of the project it no longer exists (the workspace showed 14 days).' }

  if (!raw) return { found: true, run_count: r.runs.length, trace: condenseTrace(r.runs, { detail }) }

  // Complete, unfiltered runs exactly as returned by LangSmith, ordered by dotted_order, split into parts.
  const runs = r.runs.slice().sort((a, b) => String(a.dotted_order || '').localeCompare(String(b.dotted_order || '')))
  const parts = []
  let cur = []
  let size = 0
  for (const run of runs) {
    const n = JSON.stringify(run).length
    if (cur.length && size + n > cfg.rawPartChars) { parts.push(cur); cur = []; size = 0 }
    cur.push(run)
    size += n
  }
  if (cur.length) parts.push(cur)
  const part = args.part || 1
  if (part > parts.length) return { found: true, error: 'part out of range', parts: parts.length }
  const out = {
    found: true,
    trace_id: r.trace_id,
    run_count: runs.length,
    part,
    parts: parts.length,
    note: parts.length > 1 ? 'Call get_trace again with part=2..' + parts.length + ' to receive the remaining runs. Together the parts are the complete trace.' : 'Complete trace in this single part.',
    runs: parts[part - 1]
  }
  if (!r.complete) out.warning = 'More than 10,000 runs matched; the trace is larger than this tool retrieves.'
  if (r.raw_fallback_detail) {
    out.warning = (out.warning ? out.warning + ' ' : '') + 'LangSmith rejected the full field list, so only the standard fields are included (not every field). Reason: ' + r.raw_fallback_detail
    out.selects_used = r.selects_used
  }
  return out
}

async function getManifest (cfg, args, deadline) {
  if (!cfg.manifest.bearerToken) throw new Error('manifest_not_configured')
  const client = makeManifestClient(cfg.manifest, deadline)
  return client.getManifest(args)
}

async function updateManifest (cfg, args, deadline) {
  if (!cfg.manifest.bearerToken) throw new Error('manifest_not_configured')
  const client = makeManifestClient(cfg.manifest, deadline)
  return client.updateManifest(args)
}

module.exports = { buildConfig, getTrace, getManifest, updateManifest, publicError, makeDeadline, TOTAL_BUDGET_MS }
