/* 
* <license header>
*/

jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: jest.fn()
  }
}))

const { Core } = require('@adobe/aio-sdk')
const mockLoggerInstance = { info: jest.fn(), debug: jest.fn(), error: jest.fn() }
Core.Logger.mockReturnValue(mockLoggerInstance)

jest.mock('node-fetch')
const fetch = require('node-fetch')
const action = require('./../actions/mcp/index.js')

beforeEach(() => {
  Core.Logger.mockClear()
  mockLoggerInstance.info.mockReset()
  mockLoggerInstance.debug.mockReset()
  mockLoggerInstance.error.mockReset()
})

const fakeParams = { __ow_headers: { authorization: 'Bearer fake' } }
describe('MCP request diagnostics', () => {
  let output
  beforeEach(() => { output = jest.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { output.mockRestore() })

  test.each(['', '{"secret":"never-log-this",broken}'])('logs safe body diagnostics for a malformed request', async body => {
    const response = await action.main({
      __ow_method: 'post',
      __ow_headers: { authorization: 'Bearer private-test-key', 'content-type': 'application/json' },
      MCP_API_KEY: 'private-test-key',
      __ow_body: body
    })
    expect(response.statusCode).toBe(400)
    const error = JSON.parse(response.body).error
    expect(error.code).toBe(-32700)
    expect(error.data.diagnostic_id).toEqual(expect.any(String))
    const events = output.mock.calls.map(([line]) => JSON.parse(line))
    const failure = events.find(event => event[0] === 'mcp_parse_error')[1]
    expect(failure.diagnostic_id).toBe(error.data.diagnostic_id)
    expect(failure.body_length).toBe(body.length)
    expect(failure.error_code).toBe('invalid_json')
    expect(JSON.stringify(events)).not.toContain('never-log-this')
    expect(JSON.stringify(events)).not.toContain('private-test-key')
  })

  test('distinguishes base64 transport from plain JSON without logging the body', async () => {
    const response = await action.main({
      __ow_method: 'post',
      __ow_headers: { authorization: 'Bearer private-test-key', 'content-type': 'application/json' },
      MCP_API_KEY: 'private-test-key',
      __ow_body: Buffer.from('{"secret":"never-log-this",broken}').toString('base64')
    })
    expect(response.statusCode).toBe(400)
    const events = output.mock.calls.map(([line]) => JSON.parse(line))
    const failure = events.find(event => event[0] === 'mcp_parse_error')[1]
    expect(failure.encoding).toBe('base64')
    expect(failure.decoded_shape).toBe('object_text')
    expect(JSON.stringify(events)).not.toContain('never-log-this')
  })
})
describe('MCP tool publication', () => {
  const args = {
    manifest_id: '761df9f0-0348-450b-9631-7ba04cd103be',
    sandbox_id: '85b4fed7-fc50-4989-b4fe-d7fc50e98906',
    org_id: 'B4A122FD69126FF30A495FB9@AdobeOrg'
  }
  let upstream
  beforeEach(() => { upstream = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected_upstream_call')) })
  afterEach(() => { upstream.mockRestore() })

  async function call (method, params, config = {}) {
    const response = await action.main({
      __ow_method: 'post',
      __ow_headers: { authorization: 'Bearer mcp-test-key' },
      MCP_API_KEY: 'mcp-test-key',
      MANIFEST_BEARER_TOKEN: 'manifest-test-token',
      ...config,
      __ow_body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    expect(response.statusCode).toBe(200)
    return JSON.parse(response.body)
  }

  test('publishes manifest tools alongside trace and diagnostic tools without requiring manifest credentials', async () => {
    const response = await call('tools/list', {}, { MANIFEST_BEARER_TOKEN: undefined })
    expect(response.result.tools.map(tool => tool.name)).toEqual(['get_trace', 'investigate', 'get_manifest', 'update_manifest'])
    expect(response.result.tools.find(tool => tool.name === 'get_manifest').annotations.readOnlyHint).toBe(true)
    expect(response.result.tools.find(tool => tool.name === 'update_manifest').annotations.readOnlyHint).toBe(false)
    expect(upstream).not.toHaveBeenCalled()
  })

  test('returns a complete diagnostic JSON response without the general text cap', async () => {
    const requestId = '761df9f0-0348-450b-9631-7ba04cd103be'
    const actualResponse = 'x'.repeat(25000)
    const response = value => new global.Response(JSON.stringify(value), { status: 200 })
    upstream.mockResolvedValueOnce(response({ items: [{ id: 'root-run', trace_id: 'root-run' }] }))
      .mockResolvedValueOnce(response({ items: [{
        id: 'root-run',
        run_type: 'CHAIN',
        metadata: { request_id: requestId },
        inputs: { user_message: 'Australia travel options' },
        outputs: { outcome: 'blocked', assistant_message: actualResponse }
      }] }))
      .mockResolvedValueOnce(response({
        stopReason: 'end_turn',
        output: { message: { content: [{ text: JSON.stringify({
          request_id: requestId, user_question: '', actual_response: '',
          diagnosis: {
            issue_type: 'GUARDRAIL_REVIEW_REQUIRED',
            root_cause: 'Guardrails blocked the request.',
            confidence: 'MEDIUM',
            evidence: [{ run_id: 'root-run', field_path: 'outputs.outcome', observed_value: 'blocked' }]
          },
          remediation: {
            route: 'COMPOSER_FIX', review_attributes: 'controls.guardrails.prompt',
            suggested_fix: 'Review the guardrail.', composer_change: 'Review the guardrail.', support_ticket: null
          }
        }) }] } }
      }))
    const result = await call('tools/call', { name: 'investigate', arguments: { request_id: requestId } }, {
      LANGSMITH_API_KEY: 'langsmith-test-key',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-test-key',
      MANIFEST_BEARER_TOKEN: undefined
    })
    expect(result.result.isError).not.toBe(true)
    const diagnosis = JSON.parse(result.result.content[0].text)
    expect(diagnosis.actual_response).toBe(actualResponse)
    expect(diagnosis.remediation.route).toBe('COMPOSER_FIX')
    expect(diagnosis.remediation.support_ticket).toBeNull()
  })

  test('rejects an invalid investigate request before contacting upstream', async () => {
    const result = await call('tools/call', { name: 'investigate', arguments: { request_id: 'invalid' } })
    expect(result.result.isError).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
  })

  test('fetches traces without manifest credentials', async () => {
    upstream.mockResolvedValueOnce(new global.Response(JSON.stringify({ items: [] }), { status: 200 }))
    const response = await call('tools/call', {
      name: 'get_trace', arguments: { request_id: args.manifest_id }
    }, { LANGSMITH_API_KEY: 'langsmith-test-key', MANIFEST_BEARER_TOKEN: undefined })
    expect(response.result.isError).not.toBe(true)
    expect(JSON.parse(response.result.content[0].text).found).toBe(false)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(String(upstream.mock.calls[0][0])).toBe('https://api.smith.langchain.com/api/v2/runs/query')
  })

  test.each([
    ['get_manifest', '/versions/default', { revision: 3 }],
    ['update_manifest', '/compile-request', { accepted: true }]
  ])('restores %s using its retained manifest endpoint', async (toolName, suffix, body) => {
    upstream.mockResolvedValueOnce(new global.Response(JSON.stringify(body), { status: 200 }))
    const response = await call('tools/call', { name: toolName, arguments: args })
    expect(response.result.isError).not.toBe(true)
    expect(JSON.parse(response.result.content[0].text)).toEqual(body)
    expect(upstream).toHaveBeenCalledTimes(1)
    const [url, options] = upstream.mock.calls[0]
    expect(String(url)).toBe('https://bcos-compiler.corp.ethos10-prod-va7.ethos.adobe.net/v1/manifests/' + args.manifest_id + suffix)
    expect(options.method).toBe('GET')
    expect(options.headers.Authorization).toBe('Bearer manifest-test-token')
    expect(options.headers['x-gw-ims-org-id']).toBe(args.org_id)
    expect(options.headers['x-sandbox-id']).toBe(args.sandbox_id)
    expect(options.headers['x-api-key']).toBe(toolName === 'update_manifest' ? 'aep_copilot_engine' : undefined)
  })

  test.each(['get_manifest', 'update_manifest'])('%s reports missing credentials only when called', async toolName => {
    const response = await call('tools/call', { name: toolName, arguments: args }, { MANIFEST_BEARER_TOKEN: undefined })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('MANIFEST_BEARER_TOKEN missing')
    expect(upstream).not.toHaveBeenCalled()
  })

  test.each([
    ['get_manifest', { ...args, manifest_id: 'invalid' }],
    ['update_manifest', { ...args, sandbox_id: 'invalid' }],
    ['get_manifest', { ...args, org_id: 'invalid\r\nheader' }]
  ])('%s rejects invalid manifest arguments before upstream access', async (toolName, invalidArgs) => {
    const response = await call('tools/call', { name: toolName, arguments: invalidArgs })
    expect(response.result.isError).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
  })

  test('returns a manifest upstream error without exposing upstream response content', async () => {
    upstream.mockResolvedValueOnce(new global.Response('private upstream detail', { status: 403 }))
    const response = await call('tools/call', { name: 'get_manifest', arguments: args })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('HTTP 403')
    expect(response.result.content[0].text).not.toContain('private upstream detail')
  })

  test('rejects an unknown tool without contacting upstream', async () => {
    const response = await call('tools/call', { name: 'unknown_tool', arguments: args })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('not found')
    expect(upstream).not.toHaveBeenCalled()
  })
})
describe('mcp', () => {
  test('main should be defined', () => {
    expect(action.main).toBeInstanceOf(Function)
  })
  test('should set logger to use LOG_LEVEL param', async () => {
    await action.main({ ...fakeParams, LOG_LEVEL: 'fakeLevel' })
    expect(Core.Logger).toHaveBeenCalledWith(expect.any(String), { level: 'fakeLevel' })
  })
  test('should return an http reponse with the fetched content', async () => {
    const mockFetchResponse = {
      ok: true,
      json: () => Promise.resolve({ content: 'fake' })
    }
    fetch.mockResolvedValue(mockFetchResponse)
    const response = await action.main(fakeParams)
    expect(response).toEqual({
      statusCode: 200,
      body: { content: 'fake' }
    })
  })
  test('if there is an error should return a 500 and log the error', async () => {
    const fakeError = new Error('fake')
    fetch.mockRejectedValue(fakeError)
    const response = await action.main(fakeParams)
    expect(response).toEqual({
      error: {
        statusCode: 500,
        body: { error: 'server error' }
      }
    })
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(fakeError)
  })
  test('if returned service status code is not ok should return a 500 and log the status', async () => {
    const mockFetchResponse = {
      ok: false,
      status: 404
    }
    fetch.mockResolvedValue(mockFetchResponse)
    const response = await action.main(fakeParams)
    expect(response).toEqual({
      error: {
        statusCode: 500,
        body: { error: 'server error' }
      }
    })
    // error message should contain 404
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('404') }))
  })
  test('missing input request parameters, should return 400', async () => {
    const response = await action.main({})
    expect(response).toEqual({
      error: {
        statusCode: 400,
        body: { error: 'missing header(s) \'authorization\'' }
      }
    })
  })
})
