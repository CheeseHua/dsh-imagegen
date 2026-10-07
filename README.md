# dsh-imagegen

A DeepSeek Harness plugin that turns any OpenAI-compatible image API into two
native tools — **and lets you configure the model and API from the Web UI**,
with no JSON editing and no Harness restart.

- 🖼 `generate_image` — text to image
- 🧩 `edit_image` — 1–4 local reference images plus a prompt (image-to-image)
- ⚙️ Settings → Plugins → Plugin configuration → "生图": base URL, model, size,
  quality, timeout and extra request-body fields are all editable live
- 🔒 The API key is a **write-only** field: the panel never renders it back, and
  it never appears in logs or tool results
- 📎 Generated images are stored as attachments and render directly in the
  conversation (a file is written to disk as well, and its path is returned)

## Install

```bash
# inside your dsh profile directory, e.g. ~/.dsh/profiles/web
dsh plugin add github:CheeseHua/dsh-imagegen
```

`dsh.bundle.patch` in `package.json` applies the bundled `cordis.patch.yml`
automatically, so no manual profile editing is required.

<details>
<summary>Manual mount</summary>

Add this to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: imagegen
      name: dsh-imagegen
```

The `id` (`imagegen`) is also the settings namespace of the configuration card.
</details>

## Configuration

Open **Settings →「生图」**. The section sits beside the other plugin sections
(内联图片, Vision Router, …) and edits the plugin's live configuration:

| Field | Default | Description |
| --- | --- | --- |
| `baseURL` | `https://cf.api.fan` | API base URL; with or without `/v1` |
| `model` | `gpt-image-2` | e.g. `gpt-image-2`, `dall-e-3`, `flux-1.1-pro` |
| `apiKey` | _empty_ | **Write-only.** Empty keeps the stored key / credential / env var |
| `apiKeyEnv` | `IMG_API_KEY` | Fallback source: credential-service or environment variable name |
| `outputDir` | _empty_ | Default save directory; empty uses the session workspace |
| `timeoutMs` | `180000` | Per-request timeout in milliseconds |
| `defaultSize` | _empty_ | e.g. `1024x1024`; empty defers to the provider |
| `defaultQuality` | _empty_ | `low` / `medium` / `high`; empty defers to the provider |
| `extraBodyJson` | _empty_ | Extra request-body JSON, e.g. `{"response_format":"b64_json"}` |

> **Why this plugin needs a client bundle.** A host-only plugin never gets a
> settings page: the Web settings panel is itself a client plugin, so a section
> only appears when the package declares `dsh.client.platform = web` and ships
> `lib/client.js` registering into the `settings.section` slot. `lib/client.js`
> is that bundle, and `lib/index.js` publishes the key-free endpoint it talks to
> (`ctx.remote.imagegen`) through a Typert manifest.

### API key resolution order

1. `apiKey` from the settings panel
2. the **credential service** entry named by `apiKeyEnv`
3. the **environment variable** named by `apiKeyEnv`
4. migration fallback: `~/.dsh/imagegen-key.json` (left by the older MCP version)

When none of the four supplies a key, the tool fails with an explicit message
telling you where to configure it.

### The key is never exposed

- `apiKey` is declared `role('secret')`. Cross-process settings reads
  **structurally strip** the field, so a panel only ever receives a
  `{ path, set }` marker ("is a value configured") — no UI can render the
  plaintext, because it never reaches the UI.
- Saves are **path-addressed** rather than wholesale replacement, so a form
  round-trip can neither read back nor accidentally erase the stored key.
- Logs and error messages pass through masking and show at most
  `已配置(********mnop)`.
- Tool results carry only file paths, the model, the endpoint, and a
  **non-sensitive source label** (`config` / `env:IMG_API_KEY` / …).

> If you plan to publish your setup, make sure your profile's
> `cordis.patch.yml` (which may hold the key) is never committed.

## Tools

### `generate_image`

| Argument | Required | Description |
| --- | --- | --- |
| `prompt` | ✅ | What to draw; English prompts usually work better |
| `size` | | Overrides the configured default size |
| `quality` | | Overrides the configured default quality |
| `outputDir` | | Overrides the configured default directory |
| `filename` | | Filename without extension |
| `n` | | 1–4 images, default 1 |

### `edit_image`

| Argument | Required | Description |
| --- | --- | --- |
| `prompt` | ✅ | The new scene, including how the reference subject appears |
| `images` | ✅ | 1–4 local reference image paths; relative paths resolve against the session workspace |
| `size` / `quality` / `outputDir` / `filename` / `n` | | As above |

Both tools do two things with every result: **write a local file** (the absolute
path is returned) and **store it as an attachment**, so the picture shows up in
the conversation while the file stays on disk.

## Migrating from the older MCP version

The previous version registered `mcp__imagegen__*` tools through an MCP stdio
server, configured only by `~/.dsh/imagegen-key.json`.

1. Install this plugin (above).
2. Disable the old MCP row in your profile's `cordis.patch.yml` (comment it out
   or add `disabled: true`).
3. Fill in the model / base URL in the settings panel. **You may leave the key
   empty** — the plugin falls back to the existing `~/.dsh/imagegen-key.json`.
4. Tool names change from `mcp__imagegen__generate_image` to `generate_image`;
   the arguments are fully compatible.

## Compatibility

- Standard OpenAI image endpoints: `POST {baseURL}/v1/images/generations` and
  `POST {baseURL}/v1/images/edits`. Works with relays, the official API, and
  compatible implementations; a `baseURL` that already ends in `/v1` is not
  doubled.
- Provider-specific fields (such as `response_format`) go through
  `extraBodyJson`, because relay support varies.
- Both `b64_json` and `url` responses are handled (`url` results are downloaded).
- Requires Node ≥ 22. Depends on `@deepseek-ai/schemastery` and
  `@deepseek-ai/dsh-tools`, both provided by dsh.

## Development

```bash
node tools/probe.mjs        # pure helpers + Config schema assertions (no dsh needed)
node tools/integration.mjs  # real cordis Context + real ToolRegistry + local HTTP round trip
```

`tools/integration.mjs` starts a local HTTP server and exercises generation,
image editing and the error paths for real, asserting that the key appears in
neither the tool schema, the results, nor any error message. Nothing in `lib/`
is test scaffolding.

> **Pushing to CI:** the git credential for this repository lacks the `workflow`
> OAuth scope, so a commit that modifies `.github/workflows/` is rejected. Run
> `gh auth refresh -h github.com -s workflow` once to restore ordinary pushes.

## License

MIT
