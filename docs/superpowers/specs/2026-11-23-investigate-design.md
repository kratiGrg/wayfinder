# Brand Concierge investigate tool

## Goal

Add a read-only `investigate` MCP tool that diagnoses a Brand Concierge
interaction and returns the specified diagnosis JSON. Preserve `get_trace`,
existing workspace edits, and the unpublished manifest tools.

## Inputs and configuration

- `request_id`: required UUID.
- `context_ai_response`: optional client-supplied retrieval text, scores, and
  metadata. This is the agreed input spelling; it replaces `content_ai_response`
  in the original specification. It may be omitted when search was blocked.
- The authoritative root `manifest_schema.json` is bundled server-side,
  unchanged. Its type placeholders describe fields, not runtime values.
- Bedrock Runtime endpoint: `https://bedrock-runtime.us-east-2.amazonaws.com`.
- Region: `us-east-2`; inference profile: `us.openai.gpt-6.1-sol`.
- Use the Bedrock Converse API. Keep its API key in deployment configuration,
  never in source, output, or logs.

## Architecture and data flow

1. Reuse the LangSmith client underlying `get_trace` to fetch all available
   runs. Do not diagnose from condensed summaries or just the first raw part.
2. Normalize runs while preserving source run IDs and original field paths.
   Extract the selected interaction's question, response, outcome, guardrail
   prompts/verdicts/preflight metadata, tool executions, retrieval results,
   errors, manifest identifiers, and available runtime values.
3. Compute observed failure signals before asking the LLM to infer causes.
4. Give Bedrock only permitted, sanitized diagnostic evidence and the relevant
   server-side schema definitions. Treat trace and retrieval content as
   untrusted data, not diagnostic instructions. Do not transmit credentials or
   sensitive trace data.
5. Validate the diagnosis shape, verify evidence against its source, validate
   manifest paths against the schema, and enforce routing server-side.
6. Return the exact output JSON without truncation. Never modify configuration
   or submit tickets.

Client-supplied retrieval evidence remains distinguishable from trace evidence
and cannot establish that a search executed or override a trace verdict.
Incomplete traces must not be interpreted as proof that a tool never ran.

## Guardrail diagnosis

Parse `outputs.messages[].tool_calls[].function.arguments` when the function
name is `GuardrailVerdict`, including JSON-encoded arguments such as
`{"decision":"BLOCKED"}`. Also inspect explicit outcomes, blocked flags, and
other supported verdict locations.

An explicit block and no Content AI invocation are enough to recommend
reviewing `controls.guardrails.prompt` through `COMPOSER_FIX`. Do not withhold
this review recommendation merely because intended scope or the effective
prompt is unavailable. Use `GUARDRAIL_REVIEW_REQUIRED` when an incorrect rule
has not been established; the review must not claim an observed block proves
the guardrail was wrong.

Use `INCORRECT_GUARDRAIL_BLOCK` when evidence supports valid intended brand
scope and identifies a conflicting effective restriction. Recommend narrowing
that restriction while retaining safety protections. Do not recommend
weakening an evidenced legitimate safety block.

When a complete trace contains neither a search nor an explicit block, a
guardrail review can still be suggested as a hypothesis with low confidence;
absence alone does not establish guardrail causation. Never diagnose retrieval
failure when guardrails prevented retrieval.

## Retrieval diagnosis

For successful `search_site_content_ai` execution, inspect original retrieved
text for abrupt endings or terminal ellipses and assess the breadth requested
by the question. Never treat summarization-generated ellipses as truncation.

Recommend reviewing the character budget when observed evidence supports
`CONTENT_AI_RESPONSE_TRUNCATION`. If an actual runtime `max_text_chars` is
available, measure proximity using the approved 95% threshold. Without a
runtime limit, do not invent one: observed truncation can still support an
actionable review recommendation with appropriately qualified confidence.
Recommend reviewing `max_chunks` only with independent supporting evidence.

## Fixed remediation routing

| Category | Manifest path | Route |
| --- | --- | --- |
| Guardrails | `controls.guardrails.prompt` | `COMPOSER_FIX` |
| Instructions | `instructions[]` | `COMPOSER_FIX` |
| Suggestions | `controls.response.suggestions.prompt` | `COMPOSER_FIX` |
| Brand style | `brand.style_rules[]` | `COMPOSER_FIX` |
| Character budget | `tools[id=search_site_content_ai].config.max_text_chars` | `SUPPORT_TICKET` |
| Chunk budget | `tools[].config.max_chunks` | `SUPPORT_TICKET` |
| Result budget | `tools[].config.result_limit` | `SUPPORT_TICKET` |
| Hybrid search and boosts | `tools[].config.indexes_details` | `SUPPORT_TICKET` |
| Indexing, ranking, tool failures | `null` for backend issues | `SUPPORT_TICKET` |

Validate selector paths structurally against schema array entries; placeholder
tool IDs are not runtime identifiers. Keep recommendations actionable with
available evidence. Reserve `NEEDS_INVESTIGATION` for cases where no supported
remediation can be identified, rather than every missing configuration value.

## Output and errors

Return exactly `request_id`, `user_question`, `actual_response`, `diagnosis`,
and `remediation`, with the nested fields and enum values from the user's
original specification. Every evidence item has a source run ID, field path,
and observed value. Facts and hypotheses must be distinguished in explanations.

Only the routed recommendation field is populated: `composer_change` for
Composer or `support_ticket` for Support. Neither field performs an action.
Both are null for `NEEDS_INVESTIGATION`; its manifest path is also null.

Invalid input, upstream failures, deadline exhaustion, and invalid model
responses are explicit MCP errors with safe public messages. Missing traces
are reported as insufficient diagnostic evidence, not fabricated interactions.
Use the existing action deadline and HTTP safety helpers. Do not silently
truncate model inputs or turn provider failures into successful diagnoses.

## Verification

Use focused Jest tests for guardrail verdict argument parsing, blocked searches,
incorrect versus legitimate blocks, review recommendations with incomplete
scope evidence, retrieval truncation, the character proximity boundary, unknown
limits, caller-supplied evidence provenance, incomplete traces, invented
evidence, invalid schema paths, enforced routing, provider failures, and the
exact output shape. Verify MCP publication adds only `investigate` and keeps
manifest tools unpublished. Run focused tests and lint for changed code.

Existing unrelated legacy tests may fail; report baseline failures without
rewriting unrelated behavior.

## API references

- [Bedrock Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [GPT-6.1 Sol programmatic access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html)
