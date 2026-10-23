# n8n-nodes-modelflare

Modelflare node for [n8n](https://n8n.io): chat, image and video generation with one Modelflare **Smart API Key** for every model available to your account — GPT, Claude, Gemini and more.

一个 Modelflare **Smart API Key**，在 n8n 工作流里调用你账号可用的全部文本、图像和视频模型。

## Get a Smart API Key / 获取 Smart API Key

1. Sign up / 注册: https://modelflare.dev/sign-up?utm_source=n8n&utm_medium=plugin&utm_campaign=integrations
2. Console → API Keys → **Create Smart API Key**, and pick a routing strategy (Balanced / Stability first / Low price first).

## Install / 安装

In n8n: **Settings → Community Nodes → Install**, enter `n8n-nodes-modelflare`. See the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials / 凭据

Create a **Modelflare API** credential with your Smart API Key and the base URL:

| Field | Value |
|---|---|
| Smart API Key | your Smart API Key |
| Base URL | Global `https://modelflare.dev/v1` (default) · China `https://origin.modelflare.dev/v1` · or Custom |

## Operations / 操作

| Resource | Operation | What it does |
|---|---|---|
| Text | Message a Model | Sends a prompt, optional system message and optional image URL to a text/vision model and returns the reply. |
| Image | Generate | Generates or edits an image and returns it as binary data. Gemini image models use `generateContent`; the others use the Images API. |
| Video | Generate | Creates a video task, waits up to the configured time and returns the video as binary data, or the task ID if it is still running. |
| Video | Get Status / Download | Checks a task, or downloads a finished video. |

The model lists come from your key's `GET /v1/models?scope=authorized`, so new models appear without editing the key. Use the typed **Additional Options** collections for supported text, image, and video controls; each model's exact contract is documented at https://docs.modelflare.dev/models/. Calls are billed to your Modelflare balance by actual usage.

## Troubleshooting / 常见问题

- **401**: the key is missing or invalid. Create a Smart API Key at https://modelflare.dev/keys.
- **`model_not_found`**: a regular key only calls the models of its own group. A Smart API Key calls every model available to your account. If you already use a Smart API Key, that model is not available to your account right now.
- **403 `insufficient_user_quota`**: top up at https://modelflare.dev/billing.

## License

MIT © Havenbyte LLC
