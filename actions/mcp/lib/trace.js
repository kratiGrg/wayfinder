'use strict'

// Accepts runs in these shapes and normalizes them:
//  1) CLI/UI export: { inputs, outputs, error, metadata, langsmith: { run_id, parent_run_ids[], name, run_type, dotted_order } }
//  2) LangSmith v2 query items: { id, name, run_type ("LLM"/"CHAIN"/"TOOL"...), parent_run_ids[] (root first), metadata, inputs, outputs, ... }
//  3) v1 run objects: { id, parent_run_id, extra: { metadata } }
// Some API responses carry inputs/outputs/metadata as JSON strings; accept both.
function asObj (v) {
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') { try { const x = JSON.parse(v); return x && typeof x === 'object' ? x : {} } catch (e) { return {} } }
  return {}
}

function normalizeRun (r) {
  const ls = r.langsmith || {}
  const parents = ls.parent_run_ids || r.parent_run_ids || (r.parent_run_id ? [r.parent_run_id] : [])
  return {
    id: ls.run_id || r.id,
    parentId: parents.length ? parents[parents.length - 1] : null, // root first, immediate parent last
    name: ls.name || r.name,
    runType: String(ls.run_type || r.run_type || '').toLowerCase(),
    inputs: asObj(r.inputs),
    outputs: asObj(r.outputs),
    error: r.error || null,
    metadata: asObj(r.metadata || (r.extra && r.extra.metadata)),
    start: ls.start_time || r.start_time || null,
    end: ls.end_time || r.end_time || null,
    dotted: ls.dotted_order || r.dotted_order || '',
    depth: parents.length
  }
}

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s)

function tryJson (v) {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch (e) { return null }
}

function parseSearchResult (outputs) {
  const raw = outputs && (outputs.result !== undefined ? outputs.result : outputs)
  const arr = tryJson(raw)
  if (!Array.isArray(arr)) return { results: [], parsed: false }
  return {
    parsed: true,
    results: arr.map((x) => ({
      score: typeof x.score === 'number' ? x.score : null,
      source: (x.data && (x.data.source || x.data.url)) || x.source || null,
      title: (x.data && x.data.metadata && x.data.metadata.title) || null,
      has_metadata: !!(x.data && x.data.metadata && Object.keys(x.data.metadata).length),
      text: cut((x.data && x.data.text) || '', 400)
    }))
  }
}

const ID_KEYS = ['request_id', 'conversation_id', 'interaction_id', 'concierge_id', 'manifest_id',
  'manifest_version', 'sandbox_id', 'sandbox_name', 'ims_org_id', 'session_id']

function condenseTrace (rawRuns, opts = {}) {
  const detail = opts.detail === 'full' ? 'full' : 'summary'
  const runs = rawRuns.map(normalizeRun)
  runs.sort((a, b) => (a.dotted || a.start || '').localeCompare(b.dotted || b.start || ''))
  const root = runs.find((r) => !r.parentId) || runs[0]
  if (!root) return null

  const request = {}
  for (const k of ID_KEYS) if (root.metadata[k] !== undefined) request[k] = root.metadata[k]
  request.environment = root.metadata['otel.resource.deployment.environment.name'] || null

  const outputs = root.outputs || {}
  const ui = outputs.ui || {}
  const seen = new Set()
  const sources = (ui.sources || []).filter((s) => {
    const key = s.url + '|' + s.title
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((s) => ({ title: s.title, url: s.url }))

  const out = {
    trace_id: root.id,
    request,
    user_message: root.inputs.user_message || null,
    assistant_message: detail === 'full' ? outputs.assistant_message : cut(outputs.assistant_message, 1500),
    outcome: outputs.outcome || null,
    sources,
    guardrail: null,
    skills_loaded: [],
    tool_calls: [],
    search: [],
    llm_calls: [],
    errors: [],
    run_counts: {}
  }

  for (const r of runs) {
    out.run_counts[r.name] = (out.run_counts[r.name] || 0) + 1
    if (r.error) out.errors.push({ run: r.name, error: cut(String(r.error), 500) })

    if (r.runType === 'llm') {
      const msg = (r.outputs.messages || [])[0] || {}
      const calls = (msg.tool_calls || []).map((c) => ({ name: c.function && c.function.name, arguments: tryJson(c.function && c.function.arguments) }))
      const verdict = calls.find((c) => c.name === 'GuardrailVerdict')
      if (verdict && verdict.arguments) out.guardrail = { decision: verdict.arguments.decision, model: r.name }
      const usage = msg.usage_metadata || r.outputs.usage_metadata || {}
      out.llm_calls.push({
        model: r.name,
        finish_reason: msg.finish_reason || null,
        tool_calls: calls.map((c) => c.name),
        input_tokens: usage.input_tokens || null,
        output_tokens: usage.output_tokens || null
      })
    }

    if (r.runType === 'tool') {
      if (r.name === 'load_capability') {
        out.skills_loaded.push(r.inputs.id)
        continue
      }
      const entry = { tool: r.name, args: r.inputs }
      if (/search/i.test(r.name)) {
        const parsed = parseSearchResult(r.outputs)
        const results = parsed.results
        out.search.push({
          tool: r.name,
          query: r.inputs.query || null,
          result_count: results.length,
          top_score: results.reduce((m, x) => (x.score !== null && x.score > m ? x.score : m), -Infinity),
          results: detail === 'full' ? results : results.map((x) => ({ score: x.score, source: x.source, title: x.title, has_metadata: x.has_metadata, text: cut(x.text, 160) })),
          parse_ok: parsed.parsed
        })
        if (out.search[out.search.length - 1].top_score === -Infinity) out.search[out.search.length - 1].top_score = null
        entry.result_count = results.length
      } else {
        entry.result = cut(JSON.stringify(r.outputs), 600)
      }
      out.tool_calls.push(entry)
    }
  }
  return out
}

module.exports = { normalizeRun, condenseTrace, parseSearchResult }
