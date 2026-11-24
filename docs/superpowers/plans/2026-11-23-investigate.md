# Investigate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline unless the user explicitly requests delegation.

**Goal:** Add an actionable, read-only Brand Concierge diagnostic MCP tool with evidence-backed recommendations.

**Architecture:** Reuse the complete LangSmith retrieval client, extract source-addressable evidence, and ask Bedrock Converse to infer the cause. Validate its output and enforce remediation routing locally. Bundle the authoritative manifest schema; do not expose manifest operations.

**Tech Stack:** Node.js CommonJS, existing Zod and MCP SDK, existing HTTP helpers, Jest, ESLint, Bedrock Converse with bearer authentication.

**Spec:** [Approved design](../specs/2026-11-23-investigate-design.md)

## Global Constraints

- Preserve `get_trace`, existing workspace edits, and unpublished manifest tools.
- MCP inputs are required UUID `request_id` and optional `context_ai_response`.
- Bundle root `manifest_schema.json` unchanged; placeholders are never runtime values.
- Endpoint: `https://bedrock-runtime.us-east-2.amazonaws.com`.
- Region: `us-east-2`; inference profile: `us.openai.gpt-6.1-sol`.
- Keep credentials in deployment configuration; do not read local credential files.
- Never send credentials or sensitive trace data to an external provider.
- Tests use synthetic fixtures and mocked networking; no live traces or provider calls.
- Explicit blocked verdict plus absent search warrants a Composer guardrail review.
- Distinguish a review recommendation from proof that a guardrail was incorrect.
- Never diagnose retrieval failure when guardrails prevented retrieval.
- Never invent runtime limits; use the approved 95% proximity threshold only for observed budgets.
- Never automatically modify configuration or submit tickets.
- Return the exact specified JSON structure without truncation.
- Use the existing action deadline and HTTP safety helpers.
- Report unrelated baseline failures without changing unrelated behavior.
- No dependency additions are needed.

## Files and boundaries

| File | Responsibility |
| --- | --- |
| `actions/mcp/lib/investigate.js` (new) | Evidence extraction, detection, model orchestration, schema-path checks, routing, exact output validation |
| `actions/mcp/lib/bedrock.js` (new) | Validated fixed-host Converse requests and response parsing |
| `test/investigate.test.js` (new) | Synthetic evidence, routing, provider, and orchestration regression tests |
| `actions/mcp/lib/tools.js` (modify) | Server-side Bedrock configuration, export diagnostic entry point, safe public error codes |
| `actions/mcp/index.js` (modify) | Publish `investigate`, preserve current tool publication, return uncapped diagnosis JSON |
| `test/mcp.test.js` (modify) | Update only directly related publication tests and add diagnostic calls |
| `app.config.yaml` (modify) | Inject Bedrock deployment inputs |
| `README.md` (modify) | Tool contract, setup, read-only behavior, error and routing semantics |
| `manifest_schema.json` (existing new user file) | Authoritative schema bundled by static CommonJS import |

Keep evidence and routing in one diagnostic module initially. Extract a separate
module only if implementation reveals a genuinely independent boundary; do not
refactor the existing trace-summary code.

## Task 1: Extract evidence and compute observed failure signals

**Files:** Create `actions/mcp/lib/investigate.js` and `test/investigate.test.js`.

**Interfaces:**

- `extractEvidence(rawRuns, requestId, contextAiResponse)` returns
  `{userQuestion, actualResponse, evidence, signals}`.
- Evidence entries are `{run_id, field_path, observed_value}`, with strings
  serialized consistently using `JSON.stringify` for non-string values.
- `signals` includes `blocked`, `searchInvoked`, `searchSucceeded`,
  `retrievedTexts`, and `runtimeMaxTextChars`.
- Reuse `normalizeRun(rawRun)` for standard run structure; retain each original
  run to cite original paths, including JSON-encoded arguments.
- `contextAiResponse` is an optional array of
  `{text: string, score?: number, metadata?: object}`.
  Store caller evidence with a reserved `run_id: "client:context_ai_response"`
  and indexed source paths. Document this provenance; never fabricate a
  LangSmith run identifier for client data.

- [ ] **Step 1: Add a failing regression for the user's verdict shape.**

```js
const { extractEvidence } = require('../actions/mcp/lib/investigate')
const requestId = '761df9f0-0348-450b-9631-7ba04cd103be'
const blockedRun = {
  id: 'guardrail-run',
  run_type: 'LLM',
  inputs: {},
  outputs: {
    messages: [{
      role: 'assistant',
      finish_reason: 'stop',
      tool_calls: [{
        type: 'function',
        function: {
          name: 'GuardrailVerdict',
          arguments: '{"decision":"BLOCKED"}'
        }
      }]
    }]
  }
}

describe('evidence extraction', () => {
  test('recognizes BLOCKED in JSON-encoded verdict arguments', () => {
    const extracted = extractEvidence([blockedRun], requestId)
    expect(extracted.signals.blocked).toBe(true)
    expect(extracted.signals.searchInvoked).toBe(false)
    expect(extracted.evidence).toContainEqual({
      run_id: 'guardrail-run',
      field_path: 'outputs.messages[0].tool_calls[0].function.arguments',
      observed_value: '{"decision":"BLOCKED"}'
    })
  })
})
```

- [ ] **Step 2: Run `npm test -- --runInBand test/investigate.test.js -t 'evidence extraction'`; expect a missing-module/export failure.**
- [ ] **Step 3: Implement guarded parsing and source-preserving extraction.**

```js
function verdictDecision (value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return null
    }
  }
  return value && typeof value === 'object' &&
    typeof value.decision === 'string' ? value.decision : null
}
```

Walk supported message arrays and verdict tool calls, checking their function
name before interpreting arguments. Read `outcome`, `guardrail_blocked`, prompt
inputs, and preflight metadata with source paths. Select the root interaction
whose request metadata matches the input UUID, not an unrelated conversation
turn. If no such root exists, retain missing question/response as empty strings
and record insufficient interaction evidence rather than borrow another turn.

Collect executed `tool` spans named `search_site_content_ai`; an LLM request
for that tool is not proof it executed. Retain tool errors and distinguish
missing outputs from a valid empty result. Parse retrieval arrays in
`outputs.result`, direct outputs, and JSON-string equivalents using the
existing search-result conventions, without the summary helper's text cuts.
Extract runtime budgets only from actual configuration fields in runs, never
from schema definitions. Do not search arbitrary prose for numeric limits.

- [ ] **Step 4: Add table-driven tests for an actual search span, a search error, terminal ellipsis, JSON-string run outputs, unrelated turns, and client evidence provenance.**

Use a successful search fixture with
`outputs: {result: [{score: 0.8, data: {text: 'Australia travel includes...'}}]}`.
Assert the original text is unchanged and the successful span is cited.
Replace its `error` with `'search failed'` and assert `searchSucceeded` is false.
Pass client text with no search span and assert it cannot set `searchInvoked`.

- [ ] **Step 5: Run the same targeted test command; expect all extraction cases to pass.**
- [ ] **Step 6: Commit only this task's files after verification, using the required Copilot co-author trailer.**

## Task 2: Validate diagnoses and enforce actionable routing

**Files:** Modify `actions/mcp/lib/investigate.js` and `test/investigate.test.js`.

**Interfaces:**

- Export `diagnosisSchema`, a strict Zod schema for the exact requested output.
- `finalizeDiagnosis(candidate, extracted, manifestSchema, complete)` validates
  citations and paths, computes routing, and returns a schema-valid result.
- `manifestSchema` is statically imported from `../../../manifest_schema.json`.
- `complete` is the LangSmith client's completion flag; absence-of-tool rules
  must not assume completeness when it is false.

- [ ] **Step 1: Add a failing actionable-review test.**

```js
describe('diagnostic routing', () => {
  test('reviews a blocked guardrail without requiring scope proof', () => {
    const extracted = extractEvidence([blockedRun], requestId)
    const result = finalizeDiagnosis(null, extracted, manifestSchema, true)
    expect(result.diagnosis.issue_type).toBe('GUARDRAIL_REVIEW_REQUIRED')
    expect(result.remediation.route).toBe('COMPOSER_FIX')
    expect(result.remediation.review_attributes).toBe('controls.guardrails.prompt')
    expect(result.remediation.composer_change).toMatch(/review/i)
    expect(result.remediation.support_ticket).toBeNull()
  })
})
```

Import `finalizeDiagnosis` and root `manifestSchema` in the test file.
The null candidate represents sufficient deterministic evidence for a review,
not a provider error fallback.

- [ ] **Step 2: Run `npm test -- --runInBand test/investigate.test.js -t 'diagnostic routing'`; expect failure for the new export.**
- [ ] **Step 3: Define the exact output contract and deterministic routing.**

```js
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
```

Use the verified extracted question/response/request ID, not model replacements.
Verify every candidate citation matches an entry in the evidence collection.
Reject fabricated citations with `invalid_diagnosis_evidence`; do not quietly
remove them. Reject shape violations with `invalid_diagnosis_response`.

Map only guardrails, instructions, suggestions, and style to Composer. Map
retrieval budgets, hybrid configuration, indexing/ranking, and tool errors to
Support. Parse path segments and array selectors as data, without evaluation.
Validate any selector structurally against relevant array schema entries;
require the selected tool identity from a supported trace span. Backend
diagnoses have null manifest paths.

For blocked search, prevent retrieval diagnoses and prefer a guardrail review.
A legitimate safety block may yield a no-change investigation result instead
of a prompt-weakening recommendation. Proven conflicting restriction plus
independent scope evidence allows `INCORRECT_GUARDRAIL_BLOCK`. For absent
search without an explicit block, offer a LOW-confidence guardrail review only
when the trace is complete and no observed orchestration/tool failure explains
the absence.

Truncation requires a successful search and observed abrupt text ending plus
evidence that broader information was requested. A runtime budget is optional:
unknown budget means qualified review advice, not an invented numeric fix.
When present, calculate Unicode code-point length consistently and compare
with `0.95 * max_text_chars`; cite both measured text and source budget.
Do not recommend chunks merely because character truncation was detected.

- [ ] **Step 4: Add focused routing tests.**

Test 94/100 and 95/100 character boundary cases using synthetic text;
terminal ellipsis without a runtime limit; no terminal truncation signal;
legitimate safety block; conflicting geographic restriction with explicit
brand-scope evidence; absent-search LOW review; incomplete trace; fabricated
citation; unknown manifest path; support-only chunk/hybrid fixes; blocked
search with client retrieval text; and tool-failure routing with null path.
Assert recommendation fields and confidence, not just issue names.

- [ ] **Step 5: Run the routing selector and then both extraction/routing describes together.**
- [ ] **Step 6: Commit only the verified diagnostic/test changes with the co-author trailer.**

## Task 3: Implement bounded Bedrock inference and diagnostic orchestration

**Files:** Create `actions/mcp/lib/bedrock.js`; modify `actions/mcp/lib/investigate.js`, `actions/mcp/lib/tools.js`, `test/investigate.test.js`, and `app.config.yaml`.

**Interfaces:**

- `inferDiagnosis(cfg, payload, deadline)` in `bedrock.js` returns a parsed
  candidate or throws a coded error.
- `investigate(cfg, args, deadline)` fetches complete runs through
  `makeClient(cfg.langsmith, deadline).runsByRequestId(args.request_id, 30, {raw: true})`,
  extracts evidence, invokes Bedrock once when inference is needed, and finalizes.
- Add `cfg.bedrock = {apiKey, endpoint, region, modelId}` using deployment
  parameters `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_ENDPOINT`, `BEDROCK_REGION`,
  and `BEDROCK_MODEL_ID`, with the approved non-secret endpoint/model defaults.

- [ ] **Step 1: Add mocked Converse tests under `describe('Bedrock inference', ...)`.**

Mock `safeFetch` with a successful response:

```js
safeFetch.mockResolvedValue({
  ok: true,
  status: 200,
  text: JSON.stringify({
    stopReason: 'end_turn',
    output: {message: {content: [{text: JSON.stringify(candidate)}]}}
  })
})
```

Define `candidate` as a complete diagnosis fixture using Task 2's schema.
Assert the exact region/profile URL, Bearer header, JSON system/user messages,
response parsing, and remaining-deadline timeout. Supply only a synthetic
`'bedrock-test-token'` as the key.

- [ ] **Step 2: Run `npm test -- --runInBand test/investigate.test.js -t 'Bedrock inference'`; expect missing module/function failure.**
- [ ] **Step 3: Implement direct HTTPS Converse with the existing helper.**

```js
const response = await safeFetch(
  cfg.endpoint + '/model/' + encodeURIComponent(cfg.modelId) + '/converse',
  {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + cfg.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      system: [{text: diagnosticInstructions}],
      messages: [{role: 'user', content: [{text: JSON.stringify(payload)}]}],
      inferenceConfig: {maxTokens: 4096}
    }),
    allowedHosts: ['bedrock-runtime.us-east-2.amazonaws.com'],
    timeoutMs: Math.min(30000, deadline.remaining()),
    maxBytes: 1024 * 1024
  }
)
```

Validate the endpoint is exactly the approved HTTPS origin without credentials,
query, fragment, or custom path. Validate the region and model against the
approved values. Reject missing keys as `bedrock_not_configured`. Check the
deadline before each network call and throw `timeout` at exhaustion.
Use a clear system prompt incorporating all approved diagnostic rules and the
strict output schema. Demand JSON only; parse plain JSON without silently
accepting markdown wrappers. Require successful completion and text content;
reject token-limit stops or malformed responses as `invalid_bedrock_response`.
Return generic HTTP error codes without echoing provider bodies.

Whitelist evidence fields before constructing provider input. Exclude headers,
tokens, tenant identifiers, URLs carrying credentials, and unrelated trace
fields. Do not assume a blacklist can establish privacy: if required evidence
is sensitive or cannot be safely shared, retain it locally, recommend review
from available non-sensitive facts, or emit an explicit
`diagnostic_data_not_shareable` error when inference is necessary. Never send
raw runs to Bedrock. Tests should capture request bodies to enforce exclusions.

For not-found traces, return a LOW-confidence `NEEDS_INVESTIGATION` diagnosis
with empty question/response and a trace lookup recommendation. Preserve
`complete: false` and rejected full-field-select warnings in local evidence;
do not imply complete retrieval. Provider errors always remain errors, not
successful deterministic fallback responses.

- [ ] **Step 4: Add safe public errors and deployment parameters.**

```yaml
AWS_BEARER_TOKEN_BEDROCK: $AWS_BEARER_TOKEN_BEDROCK
BEDROCK_REGION: us-east-2
BEDROCK_ENDPOINT: https://bedrock-runtime.us-east-2.amazonaws.com
BEDROCK_MODEL_ID: us.openai.gpt-6.1-sol
```

Insert these under only the existing MCP action's `inputs`. Add fixed public
messages for `bedrock_not_configured`, `invalid_bedrock_config`,
`invalid_bedrock_response`, `invalid_diagnosis_response`,
`invalid_diagnosis_evidence`, `diagnostic_data_not_shareable`, and
`bedrock_http_401/403/429` plus a generic other-HTTP-error message.
Do not log trace contents, provider payloads, or raw exception bodies.

- [ ] **Step 5: Test 401/403/429/500, exhausted deadline, oversized response, malformed JSON, token-limit stop, excluded secret fields, missing trace, incomplete trace, and successful end-to-end mocked orchestration.**
- [ ] **Step 6: Run `npm test -- --runInBand test/investigate.test.js`; expect all diagnostic tests to pass.**
- [ ] **Step 7: Commit the verified task files only with the co-author trailer; do not stage the user's schema file without permission.**

## Task 4: Publish the MCP contract and verify packaging

**Files:** Modify `actions/mcp/index.js`, `test/mcp.test.js`, and `README.md`.

**Interfaces:** Register `investigate` with required UUID and optional normalized
client retrieval array. Use the `tools.investigate` export from Task 3.

- [ ] **Step 1: Change the publication assertion to expect `['get_trace', 'investigate']` and add a diagnostic call test mocking the diagnostic implementation.**
- [ ] **Step 2: Run `npm test -- --runInBand test/mcp.test.js -t 'MCP tool publication'`; expect publication mismatch before registration.**
- [ ] **Step 3: Add the read-only registration using existing patterns.**

```js
server.registerTool('investigate', {
  description: 'Diagnose a Brand Concierge request and recommend a Composer review or Support ticket; never applies changes or submits tickets.',
  inputSchema: {
    request_id: z.string().uuid(),
    context_ai_response: z.array(z.object({
      text: z.string(),
      score: z.number().finite().optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }).strict()).optional()
  },
  annotations: {readOnlyHint: true, openWorldHint: true}
}, async (args) => {
  try {
    log('investigate', args.request_id)
    return asText(await tools.investigate(
      cfg, args, tools.makeDeadline(tools.TOTAL_BUDGET_MS)
    ), true)
  } catch (error) {
    log('investigate_error', args.request_id, tools.publicError(error))
    return asError(error)
  }
})
```

Use existing whitespace conventions when implementing. Do not expose optional
lookback or schema inputs, and do not change the `get_trace` implementation.
Add output schema/structuredContent only if supported by the installed MCP
SDK without changing the required JSON payload.

- [ ] **Step 4: Verify exact JSON output, invalid UUID/retrieval rejection before upstream calls, uncapped output exceeding 24,000 characters, safe error responses, and continuing rejection of direct manifest-tool calls.**
- [ ] **Step 5: Document the two tools in README, the server schema requirement, retrieval array shape, Bedrock environment variables, representative input/output, guardrail review versus incorrect-block semantics, Support routing, and no automatic actions.**

Example input:

```json
{
  "request_id": "761df9f0-0348-450b-9631-7ba04cd103be",
  "context_ai_response": [
    {"text": "Australia travel includes...", "score": 0.8, "metadata": {}}
  ]
}
```

The example is synthetic. Explain that `context_ai_response` is omitted for a
blocked search. Document that the API key must be configured on Runtime;
do not run a live deployment without user authorization.

- [ ] **Step 6: Run the focused integration and unit tests in one runner.**

```bash
npm test -- --runInBand test/investigate.test.js test/mcp.test.js \
  -t 'evidence extraction|diagnostic routing|Bedrock inference|diagnostic orchestration|MCP tool publication'
npx eslint actions/mcp/index.js actions/mcp/lib/tools.js \
  actions/mcp/lib/investigate.js actions/mcp/lib/bedrock.js \
  test/investigate.test.js test/mcp.test.js
git diff --check
```

If directly related tests fail, fix the root cause and rerun these selectors.
Legacy generic-action tests in `test/mcp.test.js` predate its current MCP
behavior; do not rewrite them as part of this feature.

- [ ] **Step 7: Verify the static schema import is resolvable without network access.**

```bash
node -e "require('./actions/mcp/index.js'); console.log('MCP action and bundled dependencies load')"
```

For deployed packaging, use the repository's documented `aio app build`
capability only if available; never substitute a deployment for a local build.
If the CLI is unavailable, report packaging verification as unavailable, not
passed. Confirm the user's schema is included in any eventual feature commit,
with their permission, since it is currently untracked.

- [ ] **Step 8: Summarize verified behavior and any baseline/build limitations. Commit only authorized changes with the co-author trailer; do not push, deploy, create tickets, or change manifests.**

## Plan self-review

- All approved inputs, server schema ownership, and provider configuration are
  covered by Tasks 1, 3, and 4.
- The user's exact JSON-encoded guardrail verdict is tested in Task 1 and
  actionable review routing in Task 2.
- Truncation without invented limits, provenance, completeness, source
  validation, and routing are covered by Tasks 1 and 2.
- Data-sharing restrictions, safe errors, and deadline behavior are covered by
  Task 3. Tests do not use real customer or trace data.
- MCP publication, exact JSON, existing behavior, docs, and packaging checks
  are covered by Task 4.
- All named exported interfaces are defined in their producing tasks.
