'use strict'
const { safeFetch } = require('./http')

// LangSmith v2 runs query. Request/response contract taken from LangSmith's "Migrate run queries to
// SmithDB" and the v2 query-runs API reference (marked Alpha there, so it may change):
//  - POST /api/v2/runs/query, header X-Api-Key (optional X-Tenant-Id for org-scoped keys)
//  - body: project_ids (UUIDs, required), filter, is_root, trace_id, min_start_time (defaults to the LAST 24H
//    if omitted), page_size, selects (UPPER_SNAKE; only ID is returned if omitted), cursor (in the JSON body)
//  - response: { items, next_cursor }; run_type is uppercase; parent_run_ids is root-first
// Only this one path and method are ever called, mirroring the allowlist policy you supplied.
// The select names other than the ones shown in the docs (ID, NAME, RUN_TYPE, STATUS, START_TIME, INPUTS, ERROR)
// are inferred from the documented response fields; a wrong name should come back as an HTTP 400 with detail.
const PATH = '/api/v2/runs/query'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRACE_SELECTS = ['ID', 'NAME', 'RUN_TYPE', 'STATUS', 'START_TIME', 'END_TIME', 'INPUTS', 'OUTPUTS', 'ERROR',
  'METADATA', 'PARENT_RUN_IDS', 'TRACE_ID', 'DOTTED_ORDER']

// Every run field documented for the v2 response, except the *_PREVIEW fields (truncated copies of INPUTS/OUTPUTS),
// SHARE_URL and ATTACHMENTS (public / pre-signed URLs, which act like bearer links). Names are taken from the docs'
// response-field table in upper case; if LangSmith rejects one (HTTP 400) the client falls back to TRACE_SELECTS and
// says so in the result, so a raw download is never silently partial.
const RAW_SELECTS = ['ID', 'NAME', 'RUN_TYPE', 'STATUS', 'START_TIME', 'END_TIME', 'ERROR', 'ERROR_PREVIEW', 'EVENTS', 'EXTRA',
  'FEEDBACK_STATS', 'FIRST_TOKEN_TIME', 'INPUTS', 'OUTPUTS', 'METADATA', 'PARENT_RUN_IDS', 'TRACE_ID', 'DOTTED_ORDER',
  'APP_PATH', 'TAGS', 'THREAD_ID', 'PROJECT_ID', 'IS_ROOT', 'LATENCY_SECONDS', 'TOTAL_TOKENS', 'PROMPT_TOKENS',
  'COMPLETION_TOKENS', 'TOTAL_COST', 'PROMPT_COST', 'COMPLETION_COST', 'PROMPT_TOKEN_DETAILS', 'COMPLETION_TOKEN_DETAILS',
  'PROMPT_COST_DETAILS', 'COMPLETION_COST_DETAILS', 'MANIFEST', 'REFERENCE_EXAMPLE_ID', 'REFERENCE_DATASET_ID',
  'PRICE_MODEL_ID', 'THREAD_EVALUATION_TIME']

function makeClient (cfg, deadline) {
  const origin = new URL(cfg.endpoint).origin // any path in the configured endpoint is ignored on purpose
  const host = new URL(origin).hostname
  const headers = { 'X-Api-Key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }
  if (cfg.workspaceId) headers['X-Tenant-Id'] = cfg.workspaceId

  const query = async (body) => {
    const res = await safeFetch(origin + PATH, {
      method: 'POST', headers, body: JSON.stringify(body),
      allowedHosts: [host], timeoutMs: Math.min(15000, deadline.remaining()), maxBytes: 16 * 1024 * 1024
    })
    if (!res.ok) {
      const err = new Error('langsmith_http_' + res.status)
      err.detail = String(res.text || '').slice(0, 300) // LangSmith error text; the API key is never echoed back
      throw err
    }
    return JSON.parse(res.text)
  }

  async function runsByRequestId (requestId, lookbackDays, opts = {}) {
    if (!UUID.test(requestId)) throw new Error('invalid_request_id') // value is interpolated into the filter DSL
    if (!UUID.test(cfg.projectId || '')) throw new Error('invalid_project_id')
    const min_start_time = new Date(Date.now() - lookbackDays * 86400000).toISOString()

    const rootPage = await query({
      project_ids: [cfg.projectId],
      filter: `and(eq(metadata_key, "request_id"), eq(metadata_value, "${requestId}"))`,
      is_root: true, page_size: 1, min_start_time, selects: ['ID', 'TRACE_ID']
    })
    const root = rootPage.items && rootPage.items[0]
    if (!root) return { found: false, runs: [] }
    const traceId = root.trace_id || root.id

    const fetchAll = async (selects) => {
      const runs = []
      let cursor
      for (let page = 0; page < 10; page++) {
        const body = { project_ids: [cfg.projectId], trace_id: traceId, page_size: 1000, min_start_time, selects }
        if (cursor) body.cursor = cursor
        const r = await query(body)
        runs.push(...(r.items || []))
        cursor = r.next_cursor
        if (!cursor) return { runs, complete: true }
      }
      return { runs, complete: false } // more than 10 pages of 1000 runs
    }

    let selects = opts.raw ? RAW_SELECTS : TRACE_SELECTS
    let fallback = null
    let got
    try {
      got = await fetchAll(selects)
    } catch (e) {
      if (!opts.raw || e.message !== 'langsmith_http_400') throw e
      fallback = e.detail // LangSmith rejected a select name; retry with the known-good list and report it
      selects = TRACE_SELECTS
      got = await fetchAll(selects)
    }
    return { found: true, trace_id: traceId, runs: got.runs, complete: got.complete, selects_used: selects, raw_fallback_detail: fallback }
  }
  return { runsByRequestId }
}

module.exports = { makeClient, UUID, RAW_SELECTS, TRACE_SELECTS }
