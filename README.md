# bcTraceUpdate

Welcome to my Adobe I/O Application!

## Setup

- Populate the `.env` file in the project root and fill it as shown [below](#env)

## Local Dev

- `aio app run` to start your local Dev server
- App will run on `localhost:9080` by default

By default the UI will be served locally but actions will be deployed and served from Adobe I/O Runtime. To run your actions locally use the `aio app dev` option.

For more information on the difference between `aio app run` and `aio app dev`, see [here](https://developer.adobe.com/app-builder/docs/guides/development/#aio-app-dev-vs-aio-app-run)

## MCP Manifest Tools

The MCP action exposes `get_manifest` and `update_manifest` alongside `get_trace`. Set
`MANIFEST_BEARER_TOKEN` in `.env` to the compiler service token (without the
`Bearer ` prefix). The caller authenticates to MCP with `MCP_API_KEY`, not this
upstream token.

Example `tools/call` parameters:

```json
{
  "name": "get_manifest",
  "arguments": {
    "manifest_id": "761df9f0-0348-450b-9631-7ba04cd103be",
    "sandbox_id": "85b4fed7-fc50-4989-b4fe-d7fc50e98906",
    "org_id": "B4A122FD69126FF30A495FB9@AdobeOrg"
  }
}
```

The tool returns the complete JSON from `/v1/manifests/{manifest_id}/versions/default`.

`update_manifest` calls `GET /v1/manifests/{manifest_id}/compile-request` with
`x-api-key: aep_copilot_engine` and the same server-held bearer token. It may
change server state and does not accept replacement manifest JSON. Example
`tools/call` parameters:

```json
{
  "name": "update_manifest",
  "arguments": {
    "manifest_id": "a1329fa5-f6b8-4270-8046-f77352751951",
    "sandbox_id": "cd5df39e-86e0-47c8-9df3-9e86e077c829",
    "org_id": "708E423B67F3C2050A495C27@AdobeOrg"
  }
}
```

The compile response JSON is returned in full; an empty successful response
returns `{ "status": <HTTP status> }`. Redirects are refused for both tools.

The compiler host is internal; the local machine or deployed Runtime action must
have network access to it. Restart `aio app dev` after changing `.env` or action inputs.

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
