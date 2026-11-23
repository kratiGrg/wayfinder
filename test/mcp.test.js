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
describe.each(['get_manifest', 'update_manifest'])('%s', toolName => {
  const args = {
    manifest_id: '761df9f0-0348-450b-9631-7ba04cd103be',
    sandbox_id: '85b4fed7-fc50-4989-b4fe-d7fc50e98906',
    org_id: 'B4A122FD69126FF30A495FB9@AdobeOrg'
  }
  let upstream
  beforeEach(() => { upstream = jest.spyOn(global, 'fetch') })
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

  test('is discoverable with caller IDs and no bearer-token input', async () => {
    const response = await call('tools/list', {})
    const tool = response.result.tools.find(tool => tool.name === toolName)
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['manifest_id', 'sandbox_id', 'org_id']))
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['manifest_id', 'sandbox_id', 'org_id'])
    const annotations = toolName === 'get_manifest'
      ? { readOnlyHint: true }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    expect(tool.annotations).toEqual(expect.objectContaining(annotations))
  })

  test('calls the correct endpoint with caller headers and the server token', async () => {
    const manifest = { id: args.manifest_id, content: 'x'.repeat(25000) }
    upstream.mockResolvedValue(new Response(JSON.stringify(manifest)))
    const response = await call('tools/call', { name: toolName, arguments: args })
    expect(JSON.parse(response.result.content[0].text)).toEqual(manifest)
    const path = toolName === 'get_manifest' ? '/versions/default' : '/compile-request'
    expect(upstream).toHaveBeenCalledWith(new URL('https://bcos-compiler.corp.ethos10-prod-va7.ethos.adobe.net/v1/manifests/' + args.manifest_id + path), expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      body: undefined,
      headers: {
        Accept: 'application/json',
        'x-gw-ims-org-id': args.org_id,
        'x-sandbox-id': args.sandbox_id,
        Authorization: 'Bearer manifest-test-token',
        ...(toolName === 'update_manifest' ? { 'x-api-key': 'aep_copilot_engine' } : {})
      }
    }))
  })

  test('fails clearly without a configured token', async () => {
    const response = await call('tools/call', { name: toolName, arguments: args }, { MANIFEST_BEARER_TOKEN: '' })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('MANIFEST_BEARER_TOKEN missing')
    expect(upstream).not.toHaveBeenCalled()
  })

  test('does not expose upstream error bodies or tokens', async () => {
    upstream.mockResolvedValue(new Response('secret upstream details manifest-test-token', { status: 401 }))
    const response = await call('tools/call', { name: toolName, arguments: args })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toBe('Manifest service returned an error (HTTP 401).')
  })

  test('rejects unsafe manifest paths before calling upstream', async () => {
    const response = await call('tools/call', { name: toolName, arguments: { ...args, manifest_id: '../other' } })
    expect(response.result.isError).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
  })

  test('reports invalid JSON without returning the upstream body', async () => {
    upstream.mockResolvedValue(new Response('not JSON'))
    const response = await call('tools/call', { name: toolName, arguments: args })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toBe('Manifest service returned invalid JSON.')
  })

  test('reports upstream timeouts', async () => {
    upstream.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const response = await call('tools/call', { name: toolName, arguments: args })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toBe('An upstream call timed out.')
  })

  test('handles an empty success body only for compile requests', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }))
    const response = await call('tools/call', { name: toolName, arguments: args })
    const expected = toolName === 'update_manifest'
      ? { content: [{ type: 'text', text: JSON.stringify({ status: 204 }) }] }
      : { isError: true, content: [{ type: 'text', text: 'Manifest service returned invalid JSON.' }] }
    expect(response.result).toEqual(expected)
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
