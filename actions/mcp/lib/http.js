'use strict'

// Outbound HTTP with SSRF controls (adobe-security-services, Step 6):
// - HTTPS only
// - host must be in an allowlist built from deployer-controlled config, never from tool arguments
// - redirects are refused (re-validating each hop is not needed if there are none)
// - hard timeout and response size cap
async function readCapped (res, maxBytes) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      try { await reader.cancel() } catch (e) { /* ignore */ }
      throw new Error('response_too_large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function safeFetch (url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = 15000, maxBytes = 5 * 1024 * 1024, allowedHosts = [] } = opts
  let u
  try { u = new URL(url) } catch (e) { throw new Error('invalid_url') }
  if (u.protocol !== 'https:') throw new Error('https_required')
  if (!allowedHosts.includes(u.hostname)) throw new Error('host_not_allowed')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs))
  try {
    const res = await fetch(u, { method, headers, body, redirect: 'error', signal: ctrl.signal })
    const text = await readCapped(res, maxBytes)
    return { status: res.status, ok: res.ok, text }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('timeout')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Total time budget for one tool call, so the action returns before the Runtime limit.
function makeDeadline (totalMs) {
  const end = Date.now() + totalMs
  return { remaining: () => Math.max(0, end - Date.now()) }
}

module.exports = { safeFetch, makeDeadline }
