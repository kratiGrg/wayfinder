# bcTraceUpdate

Welcome to my Adobe I/O Application!

## Setup

- Populate the `.env` file in the project root and fill it as shown [below](#env)

## Local Dev

- `aio app run` to start your local Dev server
- App will run on `localhost:9080` by default

By default the UI will be served locally but actions will be deployed and served from Adobe I/O Runtime. To run your actions locally use the `aio app dev` option.

For more information on the difference between `aio app run` and `aio app dev`, see [here](https://developer.adobe.com/app-builder/docs/guides/development/#aio-app-dev-vs-aio-app-run)

## MCP Tools

The MCP action exposes `get_trace`, `investigate`, `get_manifest`, and
`update_manifest`. Callers authenticate with `MCP_API_KEY`.

### Investigate

`investigate` diagnoses a failed Brand Concierge interaction and returns
`request_id`, `user_question`, `actual_response`, `diagnosis`, and `remediation`
as JSON. It reuses the complete LangSmith trace retrieval implementation, not
the truncated summaries or only the first raw output part of `get_trace`.

Inputs:

```json
{
  "request_id": "761df9f0-0348-450b-9631-7ba04cd103be",
  "context_ai_response": [
    {
      "text": "Retrieved travel information...",
      "score": 0.8,
      "metadata": { "title": "Travel" }
    }
  ]
}
```

`request_id` is required. `context_ai_response` is an optional array of retrieval
text, scores, and metadata supplied by the MCP client; omit it if search was
blocked. This input spelling is intentional. Client retrieval evidence is
identified by `run_id: "client:context_ai_response"` and cannot prove a tool ran.
Field paths containing `#json` address decoded fields inside a JSON-string
source field.

The authoritative `manifest_schema.json` in the project root is bundled on the
server. Callers do not supply a schema. Its type placeholders never establish
runtime configuration values.

Configure the MCP action's deployment inputs:

- `LANGSMITH_API_KEY`: existing trace access key.
- `AWS_BEARER_TOKEN_BEDROCK`: Bedrock API key; populate through the deployment
  environment, never commit the value.
- `BEDROCK_REGION`: `us-east-2`.
- `BEDROCK_ENDPOINT`: `https://bedrock-runtime.us-east-2.amazonaws.com`.
- `BEDROCK_MODEL_ID`: `us.openai.gpt-6.1-sol` inference profile.

Analysis uses Bedrock Converse with bearer authentication. Its endpoint and
inference profile are restricted to these approved values. Sensitive headers
and credential fields are excluded; recognizable sensitive content prevents
external model analysis. Do not supply confidential or personal trace content
for external analysis. Diagnostic evidence is bounded, never silently cut to
fit a request. Provider errors and invalid model JSON are explicit MCP errors.

Routing:

- `COMPOSER_FIX`: guardrails, instructions, suggestions, and brand style.
- `SUPPORT_TICKET`: retrieval character/chunk/result limits, hybrid search,
  boosts, indexing, ranking, and tool failures.
- `NEEDS_INVESTIGATION`: no supported actionable remediation, an incomplete
  trace that cannot establish the failure stage, or a legitimate safety block
  requiring no configuration change.

A `GuardrailVerdict` call with `{"decision":"BLOCKED"}` and no Content AI
execution recommends reviewing `controls.guardrails.prompt`. Missing brand
scope does not prevent this review; `INCORRECT_GUARDRAIL_BLOCK` requires evidence
of a conflicting effective rule and independent brand scope. Legitimate safety
restrictions are preserved. Absent search without a verdict can warrant a
LOW-confidence guardrail review, explicitly labeled as a hypothesis.

Successful search with abruptly ending retrieved text and a broader user
question can recommend reviewing `max_text_chars` without assuming a limit.
When an actual runtime character budget exists, 95% proximity strengthens the
diagnosis. Chunk changes require separate supporting chunk evidence.
Question citations may reference the root `inputs.user_message` or a matching
user-role message at `inputs.messages[i].content[j].text` (or string content).
Assistant, system, tool, and unrelated historical messages cannot establish the
user question. JSON-encoded search results retain evidence paths such as
`outputs.result#json[0].data.text`. Once truncation is established, Support
review of `max_text_chars` takes priority over an inconclusive or Composer route;
unknown runtime limits are never invented.

Only the applicable recommendation field (`composer_change` or
`support_ticket`) is populated. The tool never changes configuration or
submits tickets. Redeploy the action to publish the new tool.

`remediation.review_attributes` identifies the manifest configuration path to
review, or is `null` for backend issues without an applicable manifest field.
It replaces the previous `manifest_path` output field; its value remains a
single string or `null`.

### Request parsing diagnostics

The MCP action logs `mcp_request_received`, followed by `mcp_request_parsed`
or `mcp_parse_error`. Parsing diagnostics include a correlation ID, body type
and length, inferred encoding, decoded shape and length, and a numeric JSON
error position when available. They never include request bodies,
authorization headers, or raw parser exception messages.

A JSON-RPC parse-error response includes `error.data.diagnostic_id`; match
that ID to the server log entry. During `aio app dev`, logs appear in the
terminal running the dev server. An empty body and a base64-decoded empty
body are distinguished from malformed nonempty JSON.

### Manifest tools

`get_manifest` fetches the default manifest version. `update_manifest` restores
the existing compile-request operation; it does not accept arbitrary manifest
edits or patches. Compilation can change state and should only be requested
explicitly.

Both tools take the following arguments:

```json
{
  "manifest_id": "761df9f0-0348-450b-9631-7ba04cd103be",
  "sandbox_id": "85b4fed7-fc50-4989-b4fe-d7fc50e98906",
  "org_id": "B4A122FD69126FF30A495FB9@AdobeOrg"
}
```

Configure `MANIFEST_BEARER_TOKEN` in the deployment environment, never in tool
arguments or source control. The token is checked only when a manifest tool
is called. Missing credentials or manifest-service failures do not prevent
`get_trace` or `investigate` from running; neither invokes the manifest tools.
Their existing handlers and implementations are unchanged.

Redeploy the action and refresh the MCP client's tool list to expose the
restored manifest tools on a deployed server.

## Test & Coverage

- Run `aio app test` to run unit tests for ui and actions
- Run `aio app test --e2e` to run e2e tests

## Deploy & Cleanup

- `aio app deploy` to build and deploy all actions on Runtime and static files to CDN
- `aio app undeploy` to undeploy the app

## Config

### `.env`

You can generate this file using the command `aio app use`. 

```bash
# This file must **not** be committed to source control

## please provide your Adobe I/O Runtime credentials
# AIO_RUNTIME_AUTH=
# AIO_RUNTIME_NAMESPACE=
```

### `app.config.yaml`

- Main configuration file that defines an application's implementation. 
- More information on this file, application configuration, and extension configuration 
  can be found [here](https://developer.adobe.com/app-builder/docs/guides/configuration/#appconfigyaml)

#### Action Dependencies

- You have two options to resolve your actions' dependencies:

  1. **Packaged action file**: Add your action's dependencies to the root
   `package.json` and install them using `npm install`. Then set the `function`
   field in `app.config.yaml` to point to the **entry file** of your action
   folder. We will use `webpack` to package your code and dependencies into a
   single minified js file. The action will then be deployed as a single file.
   Use this method if you want to reduce the size of your actions.

  2. **Zipped action folder**: In the folder containing the action code add a
     `package.json` with the action's dependencies. Then set the `function`
     field in `app.config.yaml` to point to the **folder** of that action. We will
     install the required dependencies within that directory and zip the folder
     before deploying it as a zipped action. Use this method if you want to keep
     your action's dependencies separated.

## Debugging in VS Code

While running your local server (`aio app dev`), both UI and actions can be debugged. To do so follow the instructions [here](https://developer.adobe.com/app-builder/docs/guides/development/#debugging)

## Typescript support for UI

To use typescript use `.tsx` extension for react components and add a `tsconfig.json` 
and make sure you have the below config added
```
 {
  "compilerOptions": {
      "jsx": "react"
    }
  } 
```
