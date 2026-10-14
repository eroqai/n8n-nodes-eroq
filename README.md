# n8n-nodes-eroq

n8n community nodes for [eroq](https://eroq.ai), the AI creative studio: start your eroq **Flows**, generate **images** and **videos**, and start n8n workflows when a run or a render finishes.

Two nodes ship in this package:

- **eroq**: actions on your eroq workspace (Flows, images, videos, account).
- **eroq Trigger**: starts a workflow on eroq events (a flow run that succeeded, failed or waits for you, a render that succeeded or failed).

Everything goes through the public eroq API (`https://eroq.ai/v1`): same engines, same credit prices and same wallet as the studio. Failed renders are not charged.

## Installation

**Self-hosted n8n**: go to **Settings → Community nodes → Install**, enter `n8n-nodes-eroq`, accept the prompt, then search for "eroq" in the nodes panel.

For instances where the UI install is not available (queue mode, read-only images), install the package in n8n's custom nodes folder and restart n8n:

```sh
cd ~/.n8n/nodes
npm install n8n-nodes-eroq
```

**n8n Cloud** lists community nodes once n8n has verified them.

## Credentials

1. Create an API key at [eroq.ai/dashboard/developers](https://eroq.ai/dashboard/developers) (Developers → API keys). Keys start with `eroq_sk_`.
2. In n8n, open **Credentials → Add credential → eroq API** and paste the key.
3. Leave **Base URL** on `https://eroq.ai/v1`. It only changes for a local eroq (`http://localhost:4100/v1`; if n8n's SSRF protection is turned on, allow `localhost` with `N8N_SSRF_ALLOWED_HOSTNAMES`).

Saving the credential tests it with `GET /v1/account`. Every request sends the key as `Authorization: Bearer eroq_sk_…`. The key acts for its workspace: renders spend the workspace credits, and its role decides what it may do.

## eroq node

| Resource | Operation | What it does |
| --- | --- | --- |
| Account | Get | Credits left, usage over the last 30 days, and the workspace of the key (`GET /v1/account`). |
| Flow | Run | Starts a published flow and, by default, waits for its results. |
| Flow | Get Run | Where a run stands: each step's status, what it made (signed links), its credits. |
| Flow | Get Many | The workspace's flows, with their triggers and last run. Return All / Limit, and a Published Only filter. |
| Flow | Get Hook URL | The secret URL of a flow's "When a webhook is called" trigger. |
| Image | Generate | Renders an image from a prompt and, by default, waits for it. |
| Image | Get Job | Reads an image job (`processing`, `succeeded` or `failed`). |
| Video | Generate | Renders a clip from a prompt (optionally from a first frame). Returns the job at once by default. |
| Video | Get Job | Reads a video job. |

Flow and model pickers load from your workspace at runtime: **Flow** lists the published flows (drafts are marked as such where they can be read), **Model** lists the engines from `GET /v1/models` with their price. **Default** lets eroq pick the engine. Every picker also accepts an ID from an expression.

### Flow → Run

- **Flow**: a published flow. Drafts only run from the studio editor.
- **Prompt**: for flows whose trigger asks for one.
- **Options**
  - **Image URL**: a picture for triggers that take one.
  - **Creation ID**: a render of your library, for flows that start "After a render".
  - **Payload (JSON)**: the body a "When a webhook is called" trigger reads its fields from.
  - **Start From**: which trigger the run starts from. **Automatic** uses the flow's run trigger, or "After a render" when only a creation is sent.
  - **Callback URL**: an HTTPS address that receives one event when the run ends (see [Long flows](#long-flows-callback--wait-node)).
- **Wait for Completion** (on by default): reads the run every 5 seconds until it is `done`, `failed`, `stopped` or `waiting`, for at most **Timeout** seconds (600 by default).

Output: the run, with `id`, `status`, `results` (one entry per step: `status`, `output` kind, `url`, `text`, `credits`), `credits`, `startedAt` and `finishedAt`. Without waiting, the run comes back right away with `status: "running"` and its `poll` path.

A failed run stops the node with the error of the step that failed, and a run that is still going when the timeout ends stops it with the run ID (the run keeps going on eroq: read it later with **Get Run**). Turn on the node setting **On Error → Continue** to branch on those instead. A run that waits for a post to be approved in the studio is returned as is, with `status: "waiting"`.

### Image → Generate

- **Prompt** and **Model**.
- **Options**: **Aspect Ratio** (1:1, 3:4, 4:3, 9:16, 16:9), **Download File** and **Put Output File in Field**.
- **Wait for Completion** (on by default): reads the job every 2.5 seconds, for at most **Timeout** seconds (600 by default).

Output: the job, with `status`, `model`, `usage` and `data[]` (`url`, `content_type`, `library_id`). Links are signed and expire after about 30 minutes: turn on **Download File** to keep the image as binary data (field `data` by default), ready for a storage or social node. A failed render stops the node with eroq's message; its credits are already back.

### Video → Generate

- **Prompt** and **Model** (engines that start from a prompt; video-to-video engines are left out).
- **Options**: **Aspect Ratio** (1:1, 3:4, 4:3, 9:16, 16:9, 21:9), **Duration (Seconds)** (1 to 30, capped by your plan and snapped to what the engine supports), **Reference Image URLs** (up to 4, comma-separated; on engines that start from a frame, the first one is the first frame), **Download File**, **Put Output File in Field**.
- **Wait for Completion** (off by default, clips take minutes): reads the job every 5 seconds, for at most **Timeout** seconds (1800 by default).

Without waiting, the output is the job (`id`, `status: "processing"`, `poll`): read it later with **Video → Get Job**, or use the **eroq Trigger** with **Video Generation Succeeded**.

## eroq Trigger

- **Events** (one or more): Flow Run Succeeded, Flow Run Failed, Flow Run Waiting, Image Generation Succeeded, Image Generation Failed, Video Generation Succeeded, Video Generation Failed.
- **Flow**: narrows the flow run events to one flow (image and video events are not affected).

When the workflow is activated, the node subscribes its n8n webhook URL with `POST /v1/webhooks` (labelled `n8n · <workflow name>`) and keeps the subscription ID and signing secret in the node's data. Deactivating the workflow deletes the subscription. "Listen for test event" works the same way with n8n's test URL.

Each item is the event as eroq sends it:

```json
{
  "id": "evt_…",
  "type": "flow.run.succeeded",
  "created": 1760000000,
  "data": {
    "flow": { "id": "…", "name": "Post every render" },
    "run": { "id": "…", "status": "done", "source": "api", "credits": 45, "startedAt": "…", "finishedAt": "…", "inputs": { "prompt": "…" } },
    "outputs": [
      { "step": 2, "nodeId": "clip", "type": "generate.video", "kind": "video", "url": "https://…", "creationId": "…" }
    ]
  }
}
```

`outputs[].url` links are signed for 7 days. Image and video events carry `{ id, model, content_type, result_url, stored, duration? }`.

**Security.** Every delivery is signed: `eroq-signature: t=<unix>,v1=<hex>`, where `v1` is the HMAC-SHA256 of `<t>.<raw body>` with the subscription's secret. The trigger checks it in constant time on the raw bytes and refuses (HTTP 401) a missing or wrong signature, or a timestamp more than 5 minutes away. When another subscription points at the same n8n URL (left behind, or added by hand in the dashboard), the trigger answers it with HTTP 410, which makes eroq delete it, once eroq confirms the trigger's own subscription is alive.

**Requirements.** eroq only delivers to public HTTPS URLs. A self-hosted n8n behind a proxy or a tunnel must expose its webhooks over HTTPS (set `WEBHOOK_URL`). The API key's workspace role must be allowed to manage webhooks (owner or admin). A workspace keeps a limited number of webhook endpoints, shared with the dashboard and other automation tools: each active eroq Trigger uses one.

## Patterns

### Wait for the result in the same node

The simplest: **Flow → Run** (or **Image → Generate**) with **Wait for Completion** on. The next node gets the finished run or image. Good for flows and renders that end within a few minutes.

### Long flows: callback + Wait node

For flows that render videos, do not hold the node open: let eroq call the workflow back.

1. **eroq** node: **Flow → Run**, **Wait for Completion** off, **Options → Callback URL** = `{{ $execution.resumeUrl }}`.
2. **Wait** node right after it: **Resume** = *On Webhook Call*, **HTTP Method** = *POST* (set **Limit Wait Time** to bound it).
3. When the run ends (succeeded, failed or stopped), eroq POSTs one event to that URL. The Wait node resumes with it in `body`: `body.type`, `body.data.run.status`, `body.data.outputs[].url`.

The resume URL must be reachable over HTTPS from the internet. The callback is sent once, is not signed, and is not sent for runs that wait for a post. Flows that end within a second or two may finish before the Wait node listens: use **Wait for Completion** for those.

### Zero install: start a flow from the HTTP Request node

A flow with a **When a webhook is called** trigger has a secret URL, `https://eroq.ai/hooks/flows/<flowId>/<token>` (copy it in the studio, or read it with **Flow → Get Hook URL**). Any app can start the flow by POSTing JSON to it, without an API key, which also works from n8n without this package: an **HTTP Request** node with *POST*, that URL, and a JSON body. The trigger reads its prompt and picture from the fields chosen in the studio. Keep the URL secret: **New URL** in the studio revokes the old one.

## Errors

The node shows eroq's own error message, with a hint:

| HTTP | Meaning |
| --- | --- |
| 401 | The API key is invalid or was revoked. |
| 402 | Not enough credits on the workspace: top up at [eroq.ai/dashboard/billing](https://eroq.ai/dashboard/billing). |
| 403 | `plan_required` (a higher plan is needed) or `role_forbidden` (your workspace role cannot do this). |
| 404 | Unknown flow, run or job (image jobs expire after 24 hours, a flow keeps its last 30 runs). |
| 409 | `flow_not_published`: publish the flow in the studio first. |
| 429 | Rate limited: the hint gives the `Retry-After` delay. n8n's **Retry On Fail** setting handles it. |

## Development

```sh
npm install
npm run build   # n8n-node build: TypeScript to dist/, plus the icon
npm run lint    # n8n-node lint, strict mode (the rules n8n uses for verification)
npm test        # vitest with mocked n8n contexts, no network
npm run dev     # starts a local n8n with these nodes linked, rebuilds on change
```

```
credentials/EroqApi.credentials.ts   API key + base URL, Bearer auth, test on /v1/account
nodes/Eroq/Eroq.node.ts              the action node (resource/operation router)
nodes/Eroq/EroqTrigger.node.ts       the webhook trigger (subscription lifecycle, signature check)
nodes/Eroq/resources/                account, flow, image, video: parameters and operations
nodes/Eroq/shared/                   transport and errors, polling, signatures, downloads, pickers
test/                                unit tests
```

## Publishing (maintainers)

1. Bump `version` in `package.json` (semver).
2. `npm run build`, then `npm publish` from this folder, logged in to npm as the package owner (`npm login`). `prepublishOnly` runs the linter, the tests and the build first, and only `dist/`, this README and the license are published.
3. Self-hosted n8n instances can install the new version right away (Settings → Community nodes → Update).

**Optional: n8n verification** (listing on n8n Cloud and in the nodes panel):

- n8n verifies packages built from a **public GitHub repository** under the MIT license, with the same author on npm and GitHub and a `repository` field in `package.json` pointing to it. This folder lives in a private monorepo: copy it to its own public repository (for example `n8n-nodes-eroq`) and add the field.
- Since May 1, 2026, verified nodes must be **published from GitHub Actions with npm provenance**. `.github/workflows/publish.yml` does it on every version tag pushed to that repository. Set up the package's **Trusted Publisher** on npmjs.com (owner, repository, workflow `publish.yml`), or an `NPM_TOKEN` secret.
- Check the published package with `npx @n8n/scan-community-package n8n-nodes-eroq`.
- Submit it in the [n8n Creator Portal](https://creators.n8n.io/nodes).

## License

[MIT](LICENSE.md)
