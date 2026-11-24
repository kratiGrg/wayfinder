'use strict'
const { extractEvidence, finalizeDiagnosis, diagnosisSchema, investigate } = require('../actions/mcp/lib/investigate')
const { inferDiagnosis } = require('../actions/mcp/lib/bedrock')
const { makeDeadline } = require('../actions/mcp/lib/http')
const manifestSchema = require('../manifest_schema.json')

const requestId = '761df9f0-0348-450b-9631-7ba04cd103be'
const root = {
  id: 'root-run',
  run_type: 'CHAIN',
  metadata: { request_id: requestId },
  inputs: { user_message: 'Describe all Australia travel options' },
  outputs: { assistant_message: 'I cannot answer.', outcome: 'blocked' }
}
const blockedRun = {
  id: 'guardrail-run',
  parent_run_ids: ['root-run'],
  run_type: 'LLM',
  inputs: { messages: [{ role: 'system', content: 'Block any query about Australia.' }] },
  outputs: {
    messages: [{
      role: 'assistant',
      finish_reason: 'stop',
      tool_calls: [{
        type: 'function',
        function: { name: 'GuardrailVerdict', arguments: '{"decision":"BLOCKED"}' }
      }]
    }]
  }
}
const searchRun = {
  id: 'search-run',
  parent_run_ids: ['root-run'],
  name: 'search_site_content_ai',
  run_type: 'TOOL',
  inputs: { query: 'Australia travel' },
  outputs: { result: [{ score: 0.8, data: { text: 'Travel options include...', metadata: { title: 'Travel' } } }] }
}

describe('trace-shaped truncation evidence', () => {
  const text = 'Travel options include remote beaches and the very few people you are \u2026'
  const retrievalCitation = {
    run_id: 'search-run',
    field_path: 'outputs.result#json[0].data.text',
    observed_value: text
  }
  const questionCitation = {
    run_id: 'answer-run',
    field_path: 'inputs.messages[1].content[0].text',
    observed_value: 'Describe all Australia travel options'
  }
  function fixture (role = 'user', question = root.inputs.user_message) {
    return extractEvidence([
      { ...root, outputs: { assistant_message: 'Here are some options.', outcome: 'success' } },
      { ...searchRun, outputs: { result: JSON.stringify([{ score: 0.8, data: { text, metadata: { title: 'Travel' } } }]) } },
      {
        id: 'answer-run',
        parent_run_ids: ['root-run'],
        run_type: 'LLM',
        inputs: { messages: [
          { role: 'system', content: [{ type: 'text', text: 'Answer travel questions.' }] },
          { role, content: [{ type: 'text', text: question }] }
        ] },
        outputs: {}
      }
    ], requestId)
  }
  function candidate (route, question = questionCitation) {
    return {
      request_id: requestId,
      user_question: '',
      actual_response: '',
      diagnosis: {
        issue_type: 'CONTENT_AI_RESPONSE_TRUNCATION',
        root_cause: 'Hypothesis: retrieval was cut short.',
        confidence: 'MEDIUM',
        evidence: [question, retrievalCitation]
      },
      remediation: {
        route,
        review_attributes: 'tools[].config.max_chunks',
        suggested_fix: 'Review chunks instead.',
        composer_change: null,
        support_ticket: null
      }
    }
  }

  test.each(['COMPOSER_FIX', 'SUPPORT_TICKET', 'NEEDS_INVESTIGATION'])(
    'prioritizes Support character-budget review over the model route %s', route => {
      const result = finalizeDiagnosis(candidate(route), fixture())
      expect(result.diagnosis.issue_type).toBe('CONTENT_AI_RESPONSE_TRUNCATION')
      expect(result.remediation.route).toBe('SUPPORT_TICKET')
      expect(result.remediation.review_attributes).toBe('tools[id=search_site_content_ai].config.max_text_chars')
      expect(result.remediation.suggested_fix).toContain('max_text_chars')
      expect(result.remediation.suggested_fix).toContain('No runtime character limit was available')
      expect(result.remediation.suggested_fix).not.toContain('max_chunks')
      expect(result.remediation.support_ticket).toBe(result.remediation.suggested_fix)
      expect(result.remediation.composer_change).toBeNull()
      expect(result.diagnosis.evidence).toContainEqual(retrievalCitation)
    })

  test.each(['system', 'assistant', 'tool'])('does not accept %s text as user-question evidence', role => {
    const result = finalizeDiagnosis(candidate('SUPPORT_TICKET'), fixture(role))
    expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
  })

  test('does not accept an unrelated historical user question', () => {
    const result = finalizeDiagnosis(candidate('SUPPORT_TICKET', {
      ...questionCitation, observed_value: 'A different question'
    }), fixture('user', 'A different question'))
    expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
  })

  test('preserves support for the root user_message question citation', () => {
    const result = finalizeDiagnosis(candidate('SUPPORT_TICKET', {
      run_id: 'root-run', field_path: 'inputs.user_message', observed_value: root.inputs.user_message
    }), fixture())
    expect(result.remediation.route).toBe('SUPPORT_TICKET')
  })

  test('preserves search failure checks despite abruptly ending output', () => {
    const extracted = extractEvidence([
      { ...root, outputs: { outcome: 'error' } },
      { ...searchRun, error: 'Search failed', outputs: { result: JSON.stringify([{ data: { text } }]) } }
    ], requestId)
    const result = finalizeDiagnosis(candidate('SUPPORT_TICKET', {
      run_id: 'root-run', field_path: 'inputs.user_message', observed_value: root.inputs.user_message
    }), extracted)
    expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
  })
})

describe('evidence extraction', () => {
  test('recognizes the JSON-encoded BLOCKED verdict and cites its original field', () => {
    const result = extractEvidence([root, blockedRun], requestId)
    expect(result.signals.blocked).toBe(true)
    expect(result.signals.searchInvoked).toBe(false)
    expect(result.evidence).toContainEqual({
      run_id: 'guardrail-run',
      field_path: 'outputs.messages[0].tool_calls[0].function.arguments',
      observed_value: '{"decision":"BLOCKED"}'
    })

    const questionEvidence = {
      run_id: 'root-run',
      field_path: 'inputs.user_message',
      observed_value: 'Describe all Australia travel options'
    }
    const promptEvidence = {
      run_id: 'guardrail-run',
      field_path: 'inputs.messages[0].content',
      observed_value: 'Block any query about Australia.'
    }
    function proposal (type, path, evidence) {
      return {
        request_id: requestId,
        user_question: '',
        actual_response: '',
        diagnosis: {
          issue_type: type,
          root_cause: 'The cited observations support reviewing this restriction.',
          confidence: 'HIGH',
          evidence
        },
        remediation: {
          route: 'COMPOSER_FIX',
          review_attributes: path,
          suggested_fix: 'Review the configuration against the observed failure.',
          composer_change: 'Review the configuration.',
          support_ticket: null
        }
      }
    }

    describe('diagnostic routing', () => {
      test('reviews an explicitly blocked guardrail without requiring independent scope proof', () => {
        const extracted = extractEvidence([root, blockedRun], requestId)
        const result = finalizeDiagnosis(null, extracted, manifestSchema, true)
        expect(result.diagnosis.issue_type).toBe('GUARDRAIL_REVIEW_REQUIRED')
        expect(result.remediation.route).toBe('COMPOSER_FIX')
        expect(result.remediation.review_attributes).toBe('controls.guardrails.prompt')
        expect(result.remediation.composer_change).toMatch(/review/i)
        expect(result.remediation.support_ticket).toBeNull()
      })

      test('does not diagnose retrieval from client results when guardrails prevented execution', () => {
        const extracted = extractEvidence([root, blockedRun], requestId, [{ text: 'Travel...' }])
        const result = finalizeDiagnosis(proposal('CONTENT_AI_RESPONSE_TRUNCATION',
          'tools[id=search_site_content_ai].config.max_text_chars', [questionEvidence]), extracted)
        expect(result.remediation.route).toBe('COMPOSER_FIX')
        expect(result.diagnosis.issue_type).toBe('GUARDRAIL_REVIEW_REQUIRED')
      })

      test('distinguishes a proven conflicting rule from a review recommendation', () => {
        const scopedRoot = { ...root, inputs: { ...root.inputs, instructions: ['Answer Australia travel questions.'] } }
        const extracted = extractEvidence([scopedRoot, blockedRun], requestId)
        const result = finalizeDiagnosis(proposal('INCORRECT_GUARDRAIL_BLOCK', 'controls.guardrails.prompt', [
          promptEvidence,
          { run_id: 'root-run', field_path: 'inputs.instructions[0]', observed_value: 'Answer Australia travel questions.' }
        ]), extracted)
        expect(result.diagnosis.issue_type).toBe('INCORRECT_GUARDRAIL_BLOCK')
        expect(result.remediation.composer_change).toMatch(/preserving legitimate safety/i)
      })

      test('retains a legitimately evidenced safety restriction', () => {
        const safetyPrompt = 'Do not disclose passwords or credentials.'
        const extracted = extractEvidence([
          { ...root, inputs: { user_message: 'Disclose the stored passwords' } },
          { ...blockedRun, inputs: { messages: [{ role: 'system', content: safetyPrompt }] } }
        ], requestId)
        const result = finalizeDiagnosis(proposal('LEGITIMATE_GUARDRAIL_BLOCK',
          'controls.guardrails.prompt', [{ ...promptEvidence, observed_value: safetyPrompt }]), extracted)
        expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
        expect(result.remediation.composer_change).toBeNull()
      })

      test('recommends a low-confidence guardrail review for absent search without claiming causation', () => {
        const extracted = extractEvidence([{ ...root, outputs: {} }], requestId)
        const result = finalizeDiagnosis(null, extracted)
        expect(result.remediation.route).toBe('COMPOSER_FIX')
        expect(result.diagnosis.confidence).toBe('LOW')
        expect(result.diagnosis.root_cause).toMatch(/^Hypothesis:/)
      })

      test('does not interpret an incomplete trace as absence of execution', () => {
        const result = finalizeDiagnosis(null, extractEvidence([root], requestId), manifestSchema, false)
        expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
        expect(result.remediation.composer_change).toBeNull()
      })

      test.each([[94, 'MEDIUM'], [95, 'HIGH']])('measures the character proximity boundary at %i/100', (length, confidence) => {
        const text = 'x'.repeat(length - 3) + '...'
        const extracted = extractEvidence([
          { ...root, inputs: { ...root.inputs, manifest: { tools: [{ id: 'search_site_content_ai', config: { max_text_chars: 100 } }] } } },
          { ...searchRun, outputs: { result: [{ data: { text } }] } }
        ], requestId)
        const result = finalizeDiagnosis(proposal('CONTENT_AI_RESPONSE_TRUNCATION',
          'tools[id=search_site_content_ai].config.max_text_chars', [
            questionEvidence,
            { run_id: 'search-run', field_path: 'outputs.result[0].data.text', observed_value: text }
          ]), extracted)
        expect(result.diagnosis.confidence).toBe(confidence)
        expect(result.remediation.route).toBe('SUPPORT_TICKET')
        expect(result.remediation.composer_change).toBeNull()
        expect(result.diagnosis.evidence).toContainEqual({
          run_id: 'root-run',
          field_path: 'inputs.manifest.tools[0].config.max_text_chars',
          observed_value: '100'
        })
      })

      test('recommends a character-budget review without inventing an unknown runtime limit', () => {
        const extracted = extractEvidence([root, searchRun], requestId)
        const result = finalizeDiagnosis(proposal('CONTENT_AI_RESPONSE_TRUNCATION',
          'tools[id=search_site_content_ai].config.max_text_chars', [
            questionEvidence,
            { run_id: 'search-run', field_path: 'outputs.result[0].data.text', observed_value: 'Travel options include...' }
          ]), extracted)
        expect(result.remediation.route).toBe('SUPPORT_TICKET')
        expect(result.diagnosis.confidence).toBe('MEDIUM')
        expect(result.remediation.suggested_fix).toContain('No runtime character limit was available')
        expect(result.remediation.suggested_fix).not.toContain('max_chunks')
      })

      test('rejects a truncation diagnosis for a completed sentence', () => {
        const text = 'Australia has these travel options.'
        const extracted = extractEvidence([root, { ...searchRun, outputs: { result: [{ data: { text } }] } }], requestId)
        const result = finalizeDiagnosis(proposal('CONTENT_AI_RESPONSE_TRUNCATION',
          'tools[id=search_site_content_ai].config.max_text_chars', [
            questionEvidence,
            { run_id: 'search-run', field_path: 'outputs.result[0].data.text', observed_value: text }
          ]), extracted)
        expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
      })

      test('rejects fabricated observed values rather than silently dropping evidence', () => {
        const extracted = extractEvidence([root, blockedRun], requestId)
        expect(() => finalizeDiagnosis(proposal('GUARDRAIL_REVIEW_REQUIRED',
          'controls.guardrails.prompt', [{ ...promptEvidence, observed_value: 'Invented rule' }]), extracted))
          .toThrow('invalid_diagnosis_evidence')
      })

      test('does not recommend a chunk change from a configured chunk budget alone', () => {
        const extracted = extractEvidence([
          { ...root, inputs: { ...root.inputs, manifest: { tools: [{ id: 'search_site_content_ai', config: { max_chunks: 5 } }] } } },
          searchRun
        ], requestId)
        const result = finalizeDiagnosis(proposal('CHUNK_LIMIT', 'tools[].config.max_chunks', [{
          run_id: 'root-run', field_path: 'inputs.manifest.tools[0].config.max_chunks', observed_value: '5'
        }]), extracted)
        expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
        expect(result.remediation.support_ticket).toBeNull()
      })

      test('rejects a nonexistent manifest configuration path', () => {
        const extracted = extractEvidence([root, searchRun], requestId)
        expect(() => finalizeDiagnosis(proposal('SEARCH_BOOST', 'tools[].config.indexes_details.nonexistent',
          [questionEvidence]), extracted)).toThrow('invalid_diagnosis_path')
      })

      test('forces tool failures to Support even when the model proposes a Composer path', () => {
        const extracted = extractEvidence([root, { ...searchRun, error: 'search failed' }], requestId)
        const result = finalizeDiagnosis(proposal('TOOL_FAILURE', 'brand.style_rules[]', [{
          run_id: 'search-run', field_path: 'error', observed_value: 'search failed'
        }]), extracted)
        expect(result.remediation.route).toBe('SUPPORT_TICKET')
        expect(result.remediation.review_attributes).toBeNull()
        expect(result.remediation.composer_change).toBeNull()
      })
    })

    const bedrockConfig = {
      apiKey: 'bedrock-test-token',
      endpoint: 'https://bedrock-runtime.us-east-2.amazonaws.com',
      region: 'us-east-2',
      modelId: 'us.openai.gpt-6.1-sol'
    }
    const cfg = {
      langsmith: { apiKey: 'langsmith-test-token', projectId: requestId, endpoint: 'https://api.smith.langchain.com' },
      bedrock: bedrockConfig
    }
    const reviewCandidate = proposal('GUARDRAIL_REVIEW_REQUIRED', 'controls.guardrails.prompt', [promptEvidence])
    const bedrockResponse = candidate => ({
      stopReason: 'end_turn',
      output: { message: { role: 'assistant', content: [{ text: JSON.stringify(candidate) }] } }
    })
    let upstream
    beforeEach(() => { upstream = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected_upstream_call')) })
    afterEach(() => { upstream.mockRestore() })
    const respond = (value, status = 200) => new global.Response(JSON.stringify(value), { status })

    describe('Bedrock inference', () => {
      test('uses the approved Converse URL, bearer authentication and bounded request', async () => {
        upstream.mockResolvedValue(respond(bedrockResponse(reviewCandidate)))
        const result = await inferDiagnosis(bedrockConfig, { evidence: [promptEvidence] }, diagnosisSchema, makeDeadline(50000))
        expect(result.diagnosis.issue_type).toBe('GUARDRAIL_REVIEW_REQUIRED')
        const [url, options] = upstream.mock.calls[0]
        expect(String(url)).toBe('https://bedrock-runtime.us-east-2.amazonaws.com/model/us.openai.gpt-6.1-sol/converse')
        expect(options.headers.Authorization).toBe('Bearer bedrock-test-token')
        expect(options.redirect).toBe('error')
        expect(JSON.parse(options.body).messages[0].content[0].text).toContain('guardrail-run')
      })

      test.each([401, 403, 429, 500])('surfaces provider HTTP %i instead of fabricating a diagnosis', async status => {
        upstream.mockResolvedValue(respond({ error: 'private upstream detail' }, status))
        await expect(inferDiagnosis(bedrockConfig, {}, diagnosisSchema, makeDeadline(50000))).rejects.toThrow('bedrock_http_' + status)
      })

      test('rejects token-limit stops and malformed model JSON', async () => {
        upstream.mockResolvedValueOnce(respond({ ...bedrockResponse(reviewCandidate), stopReason: 'max_tokens' }))
          .mockResolvedValueOnce(respond({
            stopReason: 'end_turn', output: { message: { content: [{ text: 'not JSON' }] } }
          }))
        await expect(inferDiagnosis(bedrockConfig, {}, diagnosisSchema, makeDeadline(50000))).rejects.toThrow('invalid_bedrock_response')
        await expect(inferDiagnosis(bedrockConfig, {}, diagnosisSchema, makeDeadline(50000))).rejects.toThrow('invalid_bedrock_response')
      })

      test('does not contact upstream after deadline exhaustion or for an unapproved endpoint', async () => {
        await expect(inferDiagnosis(bedrockConfig, {}, diagnosisSchema, { remaining: () => 0 })).rejects.toThrow('timeout')
        await expect(inferDiagnosis({ ...bedrockConfig, endpoint: 'https://example.com' }, {}, diagnosisSchema, makeDeadline(50000)))
          .rejects.toThrow('invalid_bedrock_config')
        expect(upstream).not.toHaveBeenCalled()
      })
    })

    describe('diagnostic orchestration', () => {
      function traceResponses (runs = [root, blockedRun], complete = true) {
        upstream.mockResolvedValueOnce(respond({ items: [{ id: 'root-run', trace_id: 'root-run' }] }))
          .mockResolvedValueOnce(respond({ items: runs, ...(complete ? {} : { next_cursor: 'more' }) }))
      }

      test('fetches full trace internally and restores the exact interaction fields', async () => {
        traceResponses()
        upstream.mockResolvedValueOnce(respond(bedrockResponse(reviewCandidate)))
        const result = await investigate(cfg, { request_id: requestId }, makeDeadline(50000))
        expect(result.remediation.route).toBe('COMPOSER_FIX')
        expect(result.actual_response).toBe('I cannot answer.')
        expect(result.user_question).toBe('Describe all Australia travel options')
        expect(Object.keys(result)).toEqual(['request_id', 'user_question', 'actual_response', 'diagnosis', 'remediation'])
        const body = JSON.parse(upstream.mock.calls[1][1].body)
        expect(body.selects).toContain('MANIFEST')
      })

      test('excludes private header fields from the provider payload', async () => {
        traceResponses([{ ...root, inputs: { ...root.inputs, headers: { Authorization: 'Bearer must-not-leak' } } }, blockedRun])
        upstream.mockResolvedValueOnce(respond(bedrockResponse(reviewCandidate)))
        await investigate(cfg, { request_id: requestId }, makeDeadline(50000))
        expect(upstream.mock.calls[2][1].body).not.toContain('must-not-leak')
      })

      test('refuses to send sensitive evidence to Bedrock', async () => {
        traceResponses([{ ...root, inputs: { user_message: 'Contact person@example.com' } }, blockedRun])
        await expect(investigate(cfg, { request_id: requestId }, makeDeadline(50000))).rejects.toThrow('diagnostic_data_not_shareable')
        expect(upstream).toHaveBeenCalledTimes(2)
      })

      test('reports missing traces as insufficient evidence without invoking the model', async () => {
        upstream.mockResolvedValueOnce(respond({ items: [] }))
        const result = await investigate(cfg, { request_id: requestId }, makeDeadline(50000))
        expect(result.remediation.route).toBe('NEEDS_INVESTIGATION')
        expect(result.user_question).toBe('')
        expect(upstream).toHaveBeenCalledTimes(1)
      })

      test('propagates model failures instead of returning successful guardrail advice', async () => {
        traceResponses()
        upstream.mockResolvedValueOnce(respond({}, 500))
        await expect(investigate(cfg, { request_id: requestId }, makeDeadline(50000))).rejects.toThrow('bedrock_http_500')
      })

      test('rejects invalid diagnostic inputs before any upstream request', async () => {
        await expect(investigate(cfg, { request_id: 'invalid' }, makeDeadline(50000))).rejects.toThrow('invalid_diagnostic_input')
        expect(upstream).not.toHaveBeenCalled()
      })
    })
    expect(result.userQuestion).toBe('Describe all Australia travel options')
  })

  test('extracts verdicts from JSON-string outputs without artificial text truncation', () => {
    const result = extractEvidence([
      { ...root, outputs: {} },
      { ...blockedRun, outputs: JSON.stringify(blockedRun.outputs) },
      { ...searchRun, outputs: { result: JSON.stringify(searchRun.outputs.result) } }
    ], requestId)
    expect(result.signals.blocked).toBe(true)
    expect(result.signals.retrievedTexts).toEqual(['Travel options include...'])
    expect(result.signals.searchSucceeded).toBe(true)
  })

  test('does not treat a requested tool call or client retrieval as execution', () => {
    const result = extractEvidence([root, {
      ...blockedRun,
      outputs: { messages: [{ tool_calls: [{ function: { name: 'search_site_content_ai', arguments: '{}' } }] }] }
    }], requestId, [{ text: 'Client supplied travel text', score: 0.5 }])
    expect(result.signals.searchInvoked).toBe(false)
    expect(result.evidence).toContainEqual({
      run_id: 'client:context_ai_response',
      field_path: 'context_ai_response[0].text',
      observed_value: 'Client supplied travel text'
    })
  })

  test('does not mark errored or output-less searches as successful', () => {
    for (const run of [{ ...searchRun, error: 'search failed' }, { ...searchRun, outputs: {} }]) {
      const result = extractEvidence([root, run], requestId)
      expect(result.signals.searchInvoked).toBe(true)
      expect(result.signals.searchSucceeded).toBe(false)
    }
  })

  test('uses the matching interaction rather than unrelated root and child spans', () => {
    const result = extractEvidence([
      { ...root, id: 'other-root', metadata: { request_id: 'other-request' }, inputs: { user_message: 'Wrong query' } },
      { ...searchRun, parent_run_ids: ['other-root'] },
      root, blockedRun
    ], requestId)
    expect(result.userQuestion).toBe('Describe all Australia travel options')
    expect(result.signals.searchInvoked).toBe(false)
  })

  test('reads runtime character budgets but excludes credentials from evidence', () => {
    const result = extractEvidence([{
      ...root,
      inputs: {
        ...root.inputs,
        manifest: { tools: [{ id: 'search_site_content_ai', config: { max_text_chars: 100 } }] },
        headers: { Authorization: 'Bearer secret' }
      }
    }, searchRun], requestId)
    expect(result.signals.runtimeMaxTextChars).toBe(100)
    expect(JSON.stringify(result.evidence)).not.toContain('Bearer secret')
  })
})
