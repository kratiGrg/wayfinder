'use strict'
const { safeFetch } = require('./http')

const HOST = 'bcos-compiler.corp.ethos10-prod-va7.ethos.adobe.net'

function makeClient (cfg, deadline) {
  async function request (args, path, extraHeaders = {}, allowEmpty = false) {
    const res = await safeFetch('https://' + HOST + '/v1/manifests/' + encodeURIComponent(args.manifest_id) + path, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-gw-ims-org-id': args.org_id,
        'x-sandbox-id': args.sandbox_id,
        Authorization: 'Bearer ' + cfg.bearerToken,
        ...extraHeaders
      },
      allowedHosts: [HOST],
      timeoutMs: Math.min(15000, deadline.remaining()),
      maxBytes: 16 * 1024 * 1024
    })
    if (!res.ok) throw new Error('manifest_http_' + res.status)
    if (allowEmpty && !res.text.trim()) return { status: res.status }
    try { return JSON.parse(res.text) } catch (error) { throw new Error('invalid_manifest_response') }
  }

  async function getManifest (args) {
    return request(args, '/versions/default')
  }

  async function updateManifest (args) {
    return request(args, '/compile-request', { 'x-api-key': 'aep_copilot_engine' }, true)
  }

  return { getManifest, updateManifest }
}

module.exports = { makeClient }