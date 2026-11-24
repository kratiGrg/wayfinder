'use strict'
const { z } = require('zod')
const { normalizeRun } = require('./trace')
const { makeClient } = require('./langsmith')
const { inferDiagnosis } = require('./bedrock')
const manifestSchema = require('../../../manifest_schema.json')

const SEARCH = 'search_site_content_ai'
const CLIENT_RUN = 'client:context_ai_response'
const MAX_EVIDENCE_CHARS = 250000
const PRIVATE_KEY = /(?:^|[_-])(?:password|secret|token|credential|api[_-]?key|private[_-]?key)(?:$|[_-])|^(headers|authorization|cookie|ims_identity|ims_org_id|sandbox_id|conversation_id|session_id|tenant)$/i
const PRIVATE_VALUE = /Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----|\b(?:gh[pousr]_|AKIA|ASIA)[A-Za-z0-9]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\d[ -]*?){13,19}\b|https?:\/\/[^/\s]+:[^@\s]+@|[?&](?:x-amz-signature|x-amz-credential|access_token|api_key|token)=/i

const retrievalSchema = z.array(z.object({
  text: z.string().max(MAX_EVIDENCE_CHARS),
  score: z.number().finite().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict()).max(1000)
const inputSchema = z.object({
  request_id: z.string().uuid(),
  context_ai_response: retrievalSchema.optional()
}).strict()
const evidenceSchema = z.object({
  run_id: z.string(),
  field_path: z.string(),
  observed_value: z.string()
}).strict()
const diagnosisSchema = z.object({
  request_id: z.string().uuid(),
  user_question: z.string(),
  actual_response: z.string(),
  diagnosis: z.object({
    issue_type: z.string(),
    root_cause: z.string(),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    evidence: z.array(evidenceSchema)
  }).strict(),
  remediation: z.object({
    route: z.enum(['COMPOSER_FIX', 'SUPPORT_TICKET', 'NEEDS_INVESTIGATION']),
    review_attributes: z.string().nullable(),
    suggested_fix: z.string(),
    composer_change: z.string().nullable(),
    support_ticket: z.string().nullable()
  }).strict()
}).strict()

function parseJson (value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
}

const observed = value => typeof value === 'string' ? value : JSON.stringify(value)
const sameEvidence = (a, b) => a.run_id === b.run_id && a.field_path === b.field_path && a.observed_value === b.observed_value
const endsAbruptly = text => /(?:\u2026|\.{3}|[,;:]|\b(?:and|or|including|because|with|the|of|for|to))\s*$/i.test(text)

function extractEvidence (rawRuns, requestId, contextAiResponse) {
  const pairs = rawRuns.map(raw => ({ raw, run: normalizeRun(raw) }))
  const root = pairs.find(({ run }) => !run.parentId && run.metadata.request_id === requestId)
  const userQuestion = root && typeof root.run.inputs.user_message === 'string' ? root.run.inputs.user_message : ''
  const selected = new Set(root ? [root.run.id] : [])
  for (let changed = true; changed;) {
    changed = false
    for (const { run } of pairs) {
      if (selected.has(run.parentId) && !selected.has(run.id)) {
        selected.add(run.id)
        changed = true
      }
    }
  }
  const evidence = []
  const questionEvidence = []
  const signals = {
    blocked: false,
    searchInvoked: false,
    searchSucceeded: false,
    retrievedTexts: [],
    runtimeMaxTextChars: null,
    guardrailPrompts: [],
    toolErrors: [],
    incompleteFields: false
  }
  const budgets = new Set()
  let size = 0
  const add = (runId, path, value) => {
    if (value === undefined) return
    const entry = { run_id: String(runId), field_path: path, observed_value: observed(value) }
    size += entry.observed_value.length + path.length
    if (size > MAX_EVIDENCE_CHARS) throw new Error('diagnostic_evidence_too_large')
    evidence.push(entry)
  }
  const walk = (value, runId, path, depth = 0) => {
    if (depth > 30) throw new Error('invalid_diagnostic_data')
    if (value === null || typeof value !== 'object') {
      add(runId, path, value)
      if (typeof value === 'string') {
        const decoded = parseJson(value)
        if (decoded && typeof decoded === 'object') walk(decoded, runId, path + '#json', depth + 1)
      }
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) continue
      walk(child, runId, Array.isArray(value) ? path + '[' + key + ']' : path + '.' + key, depth + 1)
    }
  }
  const collectBudgets = (value, searchRun, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 30) return
    if (value.id === SEARCH || searchRun) {
      const config = value.config || value
      if (Number.isSafeInteger(config.max_text_chars) && config.max_text_chars > 0) budgets.add(config.max_text_chars)
    }
    for (const [key, child] of Object.entries(value)) {
      if (!PRIVATE_KEY.test(key)) collectBudgets(child, false, depth + 1)
    }
  }

  for (const { raw, run } of pairs) {
    if (!selected.has(run.id)) continue
    for (const key of ['inputs', 'outputs', 'metadata', 'error', 'manifest']) {
      if (raw[key] !== undefined) walk(raw[key], run.id, key)
    }
    if (raw.extra && raw.extra.metadata) walk(raw.extra.metadata, run.id, 'extra.metadata')
    const inputsPath = typeof raw.inputs === 'string' ? 'inputs#json' : 'inputs'
    const citeQuestion = (path, value) => {
      if (!userQuestion || value !== userQuestion) return
      const citation = evidence.find(entry => entry.run_id === String(run.id) &&
        entry.field_path === path && entry.observed_value === userQuestion)
      if (citation) questionEvidence.push(citation)
    }
    if (run === root.run) citeQuestion(inputsPath + '.user_message', run.inputs.user_message)
    for (const [index, message] of (Array.isArray(run.inputs.messages) ? run.inputs.messages : []).entries()) {
      if (!message || message.role !== 'user') continue
      const contentPath = inputsPath + '.messages[' + index + '].content'
      if (typeof message.content === 'string') citeQuestion(contentPath, message.content)
      else if (Array.isArray(message.content)) {
        for (const [blockIndex, block] of message.content.entries()) {
          if (block && block.type === 'text') citeQuestion(contentPath + '[' + blockIndex + '].text', block.text)
        }
      }
    }
    const outputs = run.outputs
    const verdicts = []
    for (const message of Array.isArray(outputs.messages) ? outputs.messages : []) {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = call.function ? call.function.name : call.name
        if (name !== 'GuardrailVerdict') continue
        const args = parseJson(call.function ? call.function.arguments : call.args)
        if (!args || typeof args !== 'object') signals.incompleteFields = true
        else verdicts.push(args.decision)
      }
    }
    const directVerdict = parseJson(outputs.verdict)
    if (outputs.guardrail_blocked === true || run.metadata.guardrail_blocked === true ||
        String(outputs.outcome).toLowerCase() === 'blocked' ||
        verdicts.includes('BLOCKED') || outputs.verdict === 'BLOCKED' ||
        (directVerdict && directVerdict.decision === 'BLOCKED') ||
        (/guardrail/i.test(run.name || '') && outputs.decision === 'BLOCKED')) {
      signals.blocked = true
    }
    if (verdicts.length || /guardrail/i.test(run.name || '')) {
      for (const message of Array.isArray(run.inputs.messages) ? run.inputs.messages : []) {
        if (message && ['system', 'developer'].includes(message.role) && typeof message.content === 'string') {
          signals.guardrailPrompts.push(message.content)
        }
      }
      if (typeof run.inputs.prompt === 'string') signals.guardrailPrompts.push(run.inputs.prompt)
    }
    if (run.error && run.runType === 'tool') signals.toolErrors.push({ run_id: run.id, tool: run.name, error: String(run.error) })
    const isSearch = run.runType === 'tool' && run.name === SEARCH
    collectBudgets(run.inputs, isSearch)
    collectBudgets(run.metadata, false)
    collectBudgets(raw.manifest, false)
    if (!isSearch) continue
    signals.searchInvoked = true
    const result = parseJson(outputs.result !== undefined ? outputs.result : outputs)
    if (run.error || !Array.isArray(result)) {
      if (!run.error) signals.incompleteFields = true
      continue
    }
    signals.searchSucceeded = true
    for (const item of result) {
      const text = item && ((item.data && item.data.text) || item.text)
      if (typeof text === 'string') signals.retrievedTexts.push(text)
    }
  }
  if (budgets.size === 1) signals.runtimeMaxTextChars = [...budgets][0]
  if (budgets.size > 1) signals.incompleteFields = true
  for (const entry of evidence) {
    if (/guardrails\.prompt$/.test(entry.field_path)) signals.guardrailPrompts.push(entry.observed_value)
  }
  if (contextAiResponse) walk(contextAiResponse, CLIENT_RUN, 'context_ai_response')
  return {
    requestId,
    userQuestion,
    actualResponse: root && typeof root.run.outputs.assistant_message === 'string' ? root.run.outputs.assistant_message : '',
    foundInteraction: !!root,
    evidence,
    questionEvidence,
    signals
  }
}

function validManifestPath (path, schema) {
  if (typeof path !== 'string' || !path.length) return false
  const segments = path.split('.')
  let nodes = [schema]
  for (const segment of segments) {
    const match = /^([a-z_]+)(?:\[(?:id=([a-z_]+))?\])?$/.exec(segment)
    if (!match) return false
    const array = segment.includes('[')
    nodes = nodes.flatMap(node => {
      if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, match[1])) return []
      const value = node[match[1]]
      return array ? (Array.isArray(value) ? value : []) : [value]
    })
    if (!nodes.length) return false
  }
  return true
}

function routeForPath (path) {
  if (['controls.guardrails.prompt', 'instructions[]', 'controls.response.suggestions.prompt', 'brand.style_rules[]'].includes(path)) return 'COMPOSER_FIX'
  if (/^tools\[(?:id=search_site_content_ai)?\]\.config\.(max_text_chars|max_chunks|result_limit|indexes_details)(?:\.|$)/.test(path || '')) return 'SUPPORT_TICKET'
  return null
}

function basicDiagnosis (extracted, issue, cause, confidence, route, path, fix, evidence) {
  return {
    request_id: extracted.requestId,
    user_question: extracted.userQuestion,
    actual_response: extracted.actualResponse,
    diagnosis: { issue_type: issue, root_cause: cause, confidence, evidence },
    remediation: {
      route,
      review_attributes: path,
      suggested_fix: fix,
      composer_change: route === 'COMPOSER_FIX' ? fix : null,
      support_ticket: route === 'SUPPORT_TICKET' ? fix : null
    }
  }
}

function investigation (extracted, cause, evidence = []) {
  return basicDiagnosis(extracted, 'INSUFFICIENT_EVIDENCE', cause, 'LOW', 'NEEDS_INVESTIGATION', null,
    'Review the available trace evidence and collect the missing interaction or failure-stage details.', evidence)
}

function guardrailReview (extracted, explicit, schema) {
  if (!validManifestPath('controls.guardrails.prompt', schema)) throw new Error('invalid_diagnosis_path')
  const evidence = extracted.evidence.filter(e => e.run_id !== CLIENT_RUN &&
    (/outcome|guardrail_blocked|verdict|decision|tool_calls|prompt|messages/.test(e.field_path))).slice(0, 12)
  return basicDiagnosis(extracted, 'GUARDRAIL_REVIEW_REQUIRED',
    explicit
      ? 'The trace records a guardrail block and Content AI was not invoked. Review the effective guardrail rule; the block alone does not prove the rule is incorrect.'
      : 'Hypothesis: guardrails may have prevented Content AI invocation. The complete trace contains no search execution; tool selection or orchestration could also explain this.',
    explicit ? 'MEDIUM' : 'LOW', 'COMPOSER_FIX', 'controls.guardrails.prompt',
    'Review controls.guardrails.prompt against the user question and intended brand scope. Narrow a conflicting rule if found, while preserving legitimate safety restrictions.', evidence)
}

function finalizeDiagnosis (candidate, extracted, schema = manifestSchema, complete = true) {
  if (!extracted.foundInteraction) return investigation(extracted, 'No matching interaction was available in the retrieved trace.')
  let parsed
  if (candidate !== null && candidate !== undefined) {
    const result = diagnosisSchema.safeParse(candidate)
    if (!result.success) throw new Error('invalid_diagnosis_response')
    parsed = result.data
    if (!parsed.diagnosis.evidence.every(entry => extracted.evidence.some(source => sameEvidence(entry, source)))) {
      throw new Error('invalid_diagnosis_evidence')
    }
    parsed.request_id = extracted.requestId
    parsed.user_question = extracted.userQuestion
    parsed.actual_response = extracted.actualResponse
  }
  const { signals } = extracted
  if (!complete && !signals.searchInvoked) {
    return investigation(extracted, 'Trace retrieval is incomplete, so absence of Content AI execution cannot be established.')
  }
  const type = parsed && parsed.diagnosis.issue_type
  const citations = parsed ? parsed.diagnosis.evidence : []
  const traceCitations = citations.filter(e => e.run_id !== CLIENT_RUN)
  if (signals.blocked && !signals.searchInvoked) {
    if (type === 'LEGITIMATE_GUARDRAIL_BLOCK' && signals.guardrailPrompts.length && traceCitations.length) {
      return basicDiagnosis(extracted, type, parsed.diagnosis.root_cause, 'MEDIUM', 'NEEDS_INVESTIGATION', null,
        'Retain the legitimate safety restriction. Review the user request or brand scope rather than weakening the guardrail.', citations)
    }
    if (type !== 'INCORRECT_GUARDRAIL_BLOCK' || !signals.guardrailPrompts.length ||
        !traceCitations.some(e => /inputs.*(?:prompt|messages)|guardrails.*prompt/.test(e.field_path)) ||
        !traceCitations.some(e => /instructions|style_rules|brand.*scope|brand_scope/.test(e.field_path))) {
      return guardrailReview(extracted, true, schema)
    }
    parsed.remediation.review_attributes = 'controls.guardrails.prompt'
    parsed.remediation.suggested_fix = 'Review the cited conflicting guardrail restriction against the independently evidenced brand scope. Remove or narrow only that conflict, preserving legitimate safety restrictions.'
  } else if (type === 'INCORRECT_GUARDRAIL_BLOCK' || type === 'GUARDRAIL_REVIEW_REQUIRED') {
    return !signals.searchInvoked && !signals.toolErrors.length && complete
      ? guardrailReview(extracted, false, schema)
      : investigation(extracted, 'The observed tool executions do not support a pre-search guardrail-block diagnosis.', citations)
  }
  if (!signals.searchInvoked && !signals.toolErrors.length && complete && !signals.blocked) {
    return guardrailReview(extracted, false, schema)
  }
  if (!parsed) {
    if (!signals.searchInvoked && !signals.toolErrors.length && complete) return guardrailReview(extracted, false, schema)
    return investigation(extracted, 'No supported diagnosis could be identified from the available evidence.')
  }
  if (type === 'CONTENT_AI_RESPONSE_TRUNCATION') {
    const abrupt = signals.retrievedTexts.filter(endsAbruptly)
    const citedRetrieval = traceCitations.some(e => /outputs/.test(e.field_path) && abrupt.some(text => e.observed_value.includes(text)))
    const citedQuestion = traceCitations.some(entry =>
      extracted.questionEvidence.some(question => sameEvidence(entry, question)))
    if (!signals.searchSucceeded || !abrupt.length || !citedRetrieval || !citedQuestion) {
      return investigation(extracted, 'The evidence does not support successful Content AI retrieval followed by truncation.', citations)
    }
    const budget = signals.runtimeMaxTextChars
    const nearBudget = budget !== null && abrupt.some(text => [...text].length >= budget * 0.95)
    parsed.diagnosis.confidence = nearBudget && complete && !signals.incompleteFields ? 'HIGH' : 'MEDIUM'
    parsed.remediation.route = 'SUPPORT_TICKET'
    parsed.remediation.review_attributes = 'tools[id=search_site_content_ai].config.max_text_chars'
    parsed.remediation.suggested_fix = 'Review the Content AI character budget and whether it cuts off the information requested. Increase max_text_chars if the observed retrieval and runtime configuration justify it.' +
      (budget === null ? ' No runtime character limit was available; do not assume a value.' : ' The observed runtime max_text_chars is ' + budget + '.')
    const budgetEvidence = extracted.evidence.find(e => e.field_path.includes('max_text_chars') && e.observed_value === String(budget))
    if (budgetEvidence && !citations.some(e => sameEvidence(e, budgetEvidence))) citations.push(budgetEvidence)
    parsed.diagnosis.root_cause = 'Observed retrieved text ends abruptly and the cited user question requests broader information. ' +
      (nearBudget ? 'Text length reaches at least 95% of the observed character budget.' : 'Hypothesis: the retrieval character budget cut the answer short; review the original source before concluding omitted content exists.')
  }
  if (['CONTENT_AI_RETRIEVAL_FAILURE', 'INDEXING_FAILURE', 'RANKING_FAILURE', 'TOOL_FAILURE', 'ORCHESTRATION_FAILURE'].includes(type)) {
    parsed.remediation.review_attributes = null
  }
  const path = parsed.remediation.review_attributes
  const backendTypes = ['CONTENT_AI_RETRIEVAL_FAILURE', 'INDEXING_FAILURE', 'RANKING_FAILURE', 'TOOL_FAILURE', 'ORCHESTRATION_FAILURE']
  let route = path === null && backendTypes.includes(type) ? 'SUPPORT_TICKET' : routeForPath(path)
  if (signals.blocked && !signals.searchSucceeded && route === 'SUPPORT_TICKET' && type !== 'TOOL_FAILURE') {
    return investigation(extracted, 'A guardrail block prevents attributing this failure to unobserved retrieval.', citations)
  }
  if (route && path !== null && !validManifestPath(path, schema)) throw new Error('invalid_diagnosis_path')
  if (!traceCitations.length) route = null
  if (path && /max_chunks|result_limit|indexes_details/.test(path) &&
      !traceCitations.some(e => e.field_path.includes(path.split('.').pop()))) route = null
  if (path && path.includes('max_chunks') &&
      !traceCitations.some(e => /outputs.*(?:chunk|truncat|limit)/i.test(e.field_path))) route = null
  if (path && path.includes('max_text_chars') && type !== 'CONTENT_AI_RESPONSE_TRUNCATION') route = null
  if (type === 'TOOL_FAILURE' && !signals.toolErrors.length) route = null
  if (path && path.startsWith('tools[') && !signals.searchInvoked) route = null
  if (path && ['instructions[]', 'controls.response.suggestions.prompt', 'brand.style_rules[]'].includes(path) &&
      !traceCitations.some(e => {
        const field = path === 'instructions[]' ? 'instructions[' : path === 'brand.style_rules[]' ? 'style_rules[' : 'suggestions'
        return e.field_path.includes(field)
      })) route = null
  if (!route || parsed.remediation.route === 'NEEDS_INVESTIGATION') {
    return investigation(extracted, parsed.diagnosis.root_cause, citations)
  }
  if (type !== 'CONTENT_AI_RESPONSE_TRUNCATION' && type !== 'INCORRECT_GUARDRAIL_BLOCK') {
    parsed.diagnosis.confidence = complete && !signals.incompleteFields ? 'MEDIUM' : 'LOW'
    parsed.diagnosis.root_cause = 'Hypothesis supported by the cited observations: ' + parsed.diagnosis.root_cause
  }
  parsed.remediation.route = route
  parsed.remediation.composer_change = route === 'COMPOSER_FIX' ? parsed.remediation.suggested_fix : null
  parsed.remediation.support_ticket = route === 'SUPPORT_TICKET' ? parsed.remediation.suggested_fix : null
  return diagnosisSchema.parse(parsed)
}

function providerEvidence (extracted) {
  const allowedField = /(?:^|[.#])(?:user_message|assistant_message|outcome|guardrail_blocked|verdict|decision|prompt|role|content|text|query|error|score|title|finish_reason|name|arguments|max_text_chars|max_chunks|result_limit|manifest_version|revision|brand_scope)(?:$|[.[#])|(?:instructions|style_rules)\[\d+\]$|indexes_details\./
  // Forward only diagnostic fields; decoded containers are represented by filtered leaves.
  const filtered = extracted.evidence.filter(entry => {
    const decoded = parseJson(entry.observed_value)
    if (decoded && typeof decoded === 'object') return false
    return allowedField.test(entry.field_path)
  })
  if (filtered.some(entry => PRIVATE_VALUE.test(entry.observed_value))) throw new Error('diagnostic_data_not_shareable')
  return filtered
}

async function investigate (cfg, args, deadline) {
  const validated = inputSchema.safeParse(args)
  if (!validated.success) throw new Error('invalid_diagnostic_input')
  if (!cfg.langsmith.apiKey || !cfg.langsmith.projectId) throw new Error('langsmith_not_configured')
  if (deadline.remaining() <= 0) throw new Error('timeout')
  const trace = await makeClient(cfg.langsmith, deadline).runsByRequestId(args.request_id, 30, { raw: true })
  const extracted = extractEvidence(trace.runs || [], args.request_id, args.context_ai_response)
  if (!trace.found || !extracted.foundInteraction) return finalizeDiagnosis(null, extracted)
  if (!trace.complete && !extracted.signals.searchInvoked) return finalizeDiagnosis(null, extracted, manifestSchema, false)
  const candidate = await inferDiagnosis(cfg.bedrock, {
    user_question: extracted.userQuestion,
    actual_response: extracted.actualResponse,
    evidence: providerEvidence(extracted),
    signals: {
      blocked: extracted.signals.blocked,
      searchInvoked: extracted.signals.searchInvoked,
      searchSucceeded: extracted.signals.searchSucceeded,
      runtimeMaxTextChars: extracted.signals.runtimeMaxTextChars,
      traceComplete: trace.complete,
      fullFieldSelection: !trace.raw_fallback_detail
    },
    manifest_schema: manifestSchema
  }, diagnosisSchema, deadline)
  if (!diagnosisSchema.safeParse(candidate).success) throw new Error('invalid_diagnosis_response')
  return finalizeDiagnosis(candidate, extracted, manifestSchema, trace.complete)
}

module.exports = { extractEvidence, finalizeDiagnosis, diagnosisSchema, retrievalSchema, investigate }
