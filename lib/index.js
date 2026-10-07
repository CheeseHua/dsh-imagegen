// dsh-imagegen — host half.
//
// Two native tools:
//   generate_image  text → image, via POST <baseURL>/v1/images/generations
//   edit_image      1-4 local reference images + text → image, via
//                   POST <baseURL>/v1/images/edits (multipart)
//
// Configuration is visual: this module exports a `Config` schema whose fields
// are marked `.volatile()`, which is the contract that makes the
// 设置 → 插件 → 插件配置 panel render a live form for this plugin's profile
// entry (id `imagegen` in cordis.patch.yml) — no reload needed.
//
// API-key handling — the key never leaves the host process:
//   * `apiKey` is declared `role('secret')`, so the settings wire strips it and
//     the panel only ever learns whether a value is set (`secrets[].set`). It
//     renders as a write-only input, and saves are path-addressed so a form
//     round-trip can never read back — or accidentally erase — the stored key.
//   * Every log line and error message goes through `maskSecret`/`describeKey`.
//     No code path prints the key, and no tool result echoes it.

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Stable Loader identity: also the default settings namespace of this plugin. */
export const name = 'dsh-imagegen'

/** `tools` is required; `attachments` gates the image-rendering blocks. */
export const inject = ['tools', 'attachments']

/** Where the pre-plugin MCP bridge kept its key; used only as a fallback. */
export const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'imagegen-key.json')

/**
 * Resolve the legacy key-file path at call time. `IMG_LEGACY_CONFIG_FILE`
 * overrides it (and `IMG_LEGACY_CONFIG_FILE=none` disables the fallback), which
 * keeps the path testable without shipping a writable module export.
 */
export function legacyConfigFile() {
  const override = process.env.IMG_LEGACY_CONFIG_FILE
  if (typeof override === 'string' && override.length > 0) {
    return override === 'none' ? undefined : override
  }
  return LEGACY_CONFIG_FILE
}

export const DEFAULT_BASE_URL = 'https://cf.api.fan'
export const DEFAULT_MODEL = 'gpt-image-2'
export const DEFAULT_API_KEY_ENV = 'IMG_API_KEY'

/** Media types the attachment store accepts, mirrored from the tool-fs contract. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Live plugin configuration. Fields marked `.volatile()` become the editable
 * form; unmarked fields would stay structural (in the profile patch).
 */
export const Config = z.object({
  baseURL: z
    .string()
    .default(DEFAULT_BASE_URL)
    .volatile()
    .description('API 基地址，例如 https://cf.api.fan。带不带 /v1 都可以，插件会自动补全。'),
  model: z
    .string()
    .default(DEFAULT_MODEL)
    .volatile()
    .description('模型名，例如 gpt-image-2、dall-e-3、flux-1.1-pro。'),
  apiKey: z
    .string()
    .role('secret')
    .default('')
    .volatile()
    .description('API Key（只写，不会回显）。留空表示沿用已保存的值 / 凭据 / 环境变量。'),
  apiKeyEnv: z
    .string()
    .role('credential-ref')
    .default(DEFAULT_API_KEY_ENV)
    .volatile()
    .description('备用来源：从凭据服务或环境变量读取 Key 的变量名。'),
  outputDir: z
    .string()
    .default('')
    .volatile()
    .description('默认保存目录（绝对路径）。留空则用当前会话的工作目录。'),
  timeoutMs: z
    .number()
    .min(5000)
    .max(600000)
    .default(180000)
    .volatile()
    .description('单次请求超时（毫秒）。'),
  defaultSize: z
    .string()
    .default('')
    .volatile()
    .description('默认尺寸，如 1024x1024；留空则交给服务端默认。'),
  defaultQuality: z
    .string()
    .default('')
    .volatile()
    .description('默认质量档位：low / medium / high；留空交给服务端。'),
  extraBodyJson: z
    .string()
    .default('')
    .volatile()
    .description('附加请求体（JSON 字符串），用于中转站的额外字段，例如 {"response_format":"b64_json"}。'),
})

/* ────────────────────────────── helpers ────────────────────────────── */

/** Last-4 mask for any log or summary line that must name a key. */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (text.length === 0) return '(unset)'
  if (text.length <= 8) return '****'
  return `${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`
}

/** Never-revealing key status for logs and results. */
export function describeKey(key) {
  return key ? `已配置(${maskSecret(key)})` : '未配置'
}

/** Normalize a user-supplied base URL, tolerating trailing slashes. */
export function normalizeBaseURL(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return DEFAULT_BASE_URL
  return trimmed
}

/** Build one images endpoint, tolerating `<host>` and `<host>/v1` spellings. */
export function endpointFor(baseURL, suffix) {
  const base = normalizeBaseURL(baseURL)
  const root = base.endsWith('/v1') ? base : `${base}/v1`
  return `${root}/images/${suffix}`
}

/** Sniff an image extension from magic bytes. */
export function sniffExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57) return '.webp'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  return '.png'
}

/** Media type the attachment store expects, from the bytes themselves. */
export function mediaTypeOf(buf) {
  const ext = sniffExt(buf)
  if (ext === '.jpg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

/** Strip path-hostile characters from a caller-supplied filename. */
export function sanitizeFilename(value) {
  const clean = String(value ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return clean || 'image'
}

/** Timestamp suffix that is safe on every platform. */
export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Parse the free-form extra-body JSON, returning `{}` for empty input. */
export function parseExtraBody(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`附加请求体不是合法 JSON：${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('附加请求体必须是一个 JSON 对象，例如 {"response_format":"b64_json"}')
  }
  return parsed
}

/**
 * Read the pre-plugin MCP bridge's key file. Used only when neither the visual
 * configuration nor a credential reference supplies a key, so an existing user
 * keeps working after migrating without pasting the key again.
 * @param configFile - explicit path; defaults to {@link legacyConfigFile}.
 */
export function readLegacyKey(configFile = legacyConfigFile()) {
  if (configFile === undefined) return undefined
  try {
    if (!existsSync(configFile)) return undefined
    const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
    const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : ''
    return key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

/** Fetch with a hard timeout that also composes the caller's cancellation signal. */
async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Pull a human-readable message out of an OpenAI-compatible error body. */
export function errorDetail(raw) {
  try {
    const parsed = JSON.parse(raw)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    if (typeof message === 'string' && message.length > 0) return message
    return JSON.stringify(parsed).slice(0, 400)
  } catch {
    return String(raw ?? '').slice(0, 400)
  }
}

/** Turn one `data[]` entry into raw bytes, downloading a URL result if needed. */
async function materializeEntry(entry, timeoutMs, signal) {
  if (typeof entry?.b64_json === 'string' && entry.b64_json.length > 0) {
    return Buffer.from(entry.b64_json, 'base64')
  }
  if (typeof entry?.url === 'string' && entry.url.length > 0) {
    const response = await fetchWithTimeout(entry.url, {}, timeoutMs, signal)
    if (!response.ok) throw new Error(`下载生成结果失败：HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  throw new Error(`无法识别的图片返回：${JSON.stringify(entry ?? null).slice(0, 200)}`)
}

/** Resolve a unique destination path, never overwriting an existing file. */
export function uniquePath(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}${ext}`)
  let counter = 1
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${baseName}-${counter}${ext}`)
    counter += 1
  }
  return candidate
}

/** The structured image value an `ImageBlock` is rebuilt from. */
export const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: IMAGE_MEDIA_TYPES, required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

/* ─────────────────────────────── plugin ─────────────────────────────── */

/**
 * Register the image tools against the live configuration.
 * @param ctx - registration scope; `tools` and `attachments` are mounted.
 * @param config - resolved Config for this plugin instance.
 */
export function apply(ctx, config = {}) {
  /** Read one config field, tolerating a plain object or a schemastery object. */
  const read = (key, fallback) => {
    if (config === undefined || config === null) return fallback
    let value
    if (typeof config.get === 'function') {
      try {
        value = config.get(key)
      } catch {
        value = undefined
      }
    }
    if (value === undefined && typeof config === 'object') value = config[key]
    if (value === undefined || value === null) return fallback
    return value
  }

  const stringField = (key, fallback) => {
    const value = read(key, fallback)
    const text = typeof value === 'string' ? value.trim() : ''
    return text.length > 0 ? text : fallback
  }

  const numberField = (key, fallback) => {
    const value = Number(read(key, fallback))
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  /**
   * Resolve the API key with a documented precedence. The value is used for the
   * Authorization header only — it is never logged and never returned.
   */
  const resolveKey = async () => {
    const literal = stringField('apiKey', '')
    if (literal.length > 0) return { key: literal, source: 'config' }

    const ref = stringField('apiKeyEnv', DEFAULT_API_KEY_ENV)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && ref.length > 0) {
      try {
        const resolved = await credentials.resolve(ref)
        const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
        if (value.length > 0) return { key: value, source: `credentials:${ref}` }
      } catch {
        /* fall through to the next source */
      }
    }

    const fromEnv = typeof ref === 'string' && ref.length > 0 ? process.env[ref] : undefined
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      return { key: fromEnv.trim(), source: `env:${ref}` }
    }

    const legacy = readLegacyKey()
    if (legacy !== undefined) return { key: legacy, source: 'legacy-key-file' }

    throw new Error(
      '生图未配置 API Key：请在 设置 → 插件 → 插件配置 →「生图」中填写 API Key，' +
        `或把 Key 写入凭据 / 环境变量 ${ref || DEFAULT_API_KEY_ENV}。`,
    )
  }

  /** Default save directory: explicit, else configured, else session workspace. */
  const resolveDir = (exec, requested) => {
    const explicit = typeof requested === 'string' && requested.trim().length > 0 ? requested.trim() : ''
    if (explicit.length > 0) return path.resolve(explicit)
    const configured = stringField('outputDir', '')
    if (configured.length > 0) return path.resolve(configured)
    return sessionCwd(exec)
  }

  const sessionCwd = (exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? path.resolve(cwd) : process.cwd()
  }

  /** Resolve a caller-supplied reference image against the session workspace. */
  const resolveInput = (exec, raw) => {
    const text = String(raw ?? '').trim()
    if (text.length === 0) throw new Error('参考图路径不能为空')
    if (path.isAbsolute(text)) return path.resolve(text)
    return path.resolve(sessionCwd(exec), text)
  }

  /** Persist every returned entry and store it durably for inline rendering. */
  const persist = async ({ data, dir, filename, prefix, signal, timeoutMs }) => {
    const attachments = ctx.get('attachments')
    mkdirSync(dir, { recursive: true })
    const saved = []
    for (let index = 0; index < data.length; index += 1) {
      const bytes = await materializeEntry(data[index], timeoutMs, signal)
      const mediaType = mediaTypeOf(bytes)
      const stem = sanitizeFilename(filename && filename.trim().length > 0 ? filename : `${prefix}-${timestampSlug()}`)
      const name = data.length > 1 ? `${stem}-${index + 1}` : stem
      const filePath = uniquePath(dir, name, sniffExt(bytes))
      writeFileSync(filePath, bytes)

      // Durable copy so the conversation can render the picture itself. A store
      // that refuses the image (limits, unsupported format) must not fail the
      // generation: the file on disk is already the delivered artifact.
      let image
      if (attachments !== undefined) {
        try {
          const ref = await attachments.saveImage({ data: bytes, mediaType, name: path.basename(filePath) })
          image = {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          }
        } catch {
          /* fall back to a path-only result */
        }
      }
      saved.push({ path: filePath, mediaType, bytes: bytes.length, ...(image === undefined ? {} : { image }) })
    }
    return saved
  }

  /** Canonical value shared by both tools. */
  const toValue = (saved, meta) => ({
    images: saved.map((entry, index) => ({
      index: index + 1,
      path: entry.path,
      mimeType: entry.mediaType,
      bytes: entry.bytes,
      ...(entry.image === undefined ? {} : { image: entry.image }),
    })),
    paths: saved.map((entry) => entry.path),
    model: meta.model,
    endpoint: meta.endpoint,
    keySource: meta.keySource,
    warnings: meta.warnings,
  })

  /** Model-facing text: paths and provenance, never the key. */
  const renderText = (value, title) => {
    const lines = [
      `${title} ${value.paths.length} 张（模型 ${value.model}，接口 ${value.endpoint}，密钥来源 ${value.keySource}）`,
      ...value.paths,
    ]
    if (value.warnings.length > 0) lines.push('', ...value.warnings.map((warning) => `⚠ ${warning}`))
    lines.push('', '图片会直接在对话中渲染，也可在预览面板打开文件。')
    return lines.join('\n')
  }

  /** One image block per stored result; a store-refused image degrades to its path. */
  const renderValue = (value, title) => {
    const blocks = [{ type: 'text', text: renderText(value, title) }]
    for (const image of value.images) {
      if (image.image !== undefined) blocks.push({ type: 'image', attachment: image.image })
    }
    return blocks
  }

  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      images: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', required: true },
            path: { type: 'string', required: true },
            mimeType: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            image: IMAGE_VALUE_SCHEMA,
          },
        },
      },
      paths: { type: 'array', required: true, items: { type: 'string' } },
      model: { type: 'string', required: true },
      endpoint: { type: 'string', required: true },
      keySource: { type: 'string', required: true },
      warnings: { type: 'array', required: true, items: { type: 'string' } },
    },
  }

  const promptParam = {
    type: 'string',
    required: true,
    description: '画面描述，越具体越好（主体、场景、风格、光线、构图）；英文描述通常效果更佳。',
  }
  const sizeParam = {
    type: 'string',
    description: '图片尺寸，如 1024x1024、1536x1024、1024x1536、auto；不传则用配置默认值或服务端默认。',
  }
  const qualityParam = {
    type: 'string',
    description: '质量档位：low / medium / high / auto；不传则用配置默认值或服务端默认。',
  }
  const outputDirParam = {
    type: 'string',
    description: '保存目录（绝对路径，或相对会话工作目录）。不传则用配置里的 outputDir，再退到会话工作目录。',
  }
  const filenameParam = { type: 'string', description: '文件名（不含扩展名）；默认按时间自动生成。' }
  const countParam = { type: 'integer', description: '一次生成的图片张数，1-4，默认 1。' }

  ctx.tools.register(
    defineTool({
      name: 'generate_image',
      description:
        '调用生图模型（OpenAI 兼容接口）根据文字描述生成图片，保存到本地文件并返回绝对路径；图片会直接在对话中渲染。' +
        '模型与 API 可在 设置 → 插件 → 插件配置 →「生图」中可视化配置。',
      parameters: {
        prompt: promptParam,
        size: sizeParam,
        quality: qualityParam,
        outputDir: outputDirParam,
        filename: filenameParam,
        n: countParam,
      },
      output: {
        schema: outputSchema,
        render: (_args, value) => renderValue(value, '已生成'),
      },
      timeoutMs: numberField('timeoutMs', 180000),
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'execute',
        title: '生成图片',
        rawInput: { prompt: args.prompt },
      }),
      async execute(args, exec) {
        const { key, source } = await resolveKey()
        const endpoint = endpointFor(stringField('baseURL', DEFAULT_BASE_URL), 'generations')
        const model = stringField('model', DEFAULT_MODEL)
        const timeoutMs = numberField('timeoutMs', 180000)
        const requested = Number.isInteger(args.n) && args.n > 0 ? args.n : 1
        const warnings = []

        const body = { model, prompt: args.prompt, n: requested, ...parseExtraBody(stringField('extraBodyJson', '')) }
        const size =
          (typeof args.size === 'string' ? args.size.trim() : '') ||
          stringField('defaultSize', '')
        const quality =
          (typeof args.quality === 'string' ? args.quality.trim() : '') ||
          stringField('defaultQuality', '')
        if (size.length > 0) body.size = size
        if (quality.length > 0) body.quality = quality

        // Logs deliberately name the endpoint/model/count and the key STATUS only.
        ctx.logger?.info?.(`imagegen: POST ${endpoint} model=${model} n=${requested} key=${describeKey(key)}`)

        const response = await fetchWithTimeout(
          endpoint,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
          },
          timeoutMs,
          exec.signal,
        )

        const raw = await response.text()
        if (!response.ok) throw new Error(`生图接口返回 HTTP ${response.status}：${errorDetail(raw)}`)

        let json
        try {
          json = JSON.parse(raw)
        } catch {
          throw new Error(`生图接口返回非 JSON 内容：${raw.slice(0, 200)}`)
        }
        if (!Array.isArray(json?.data) || json.data.length === 0) {
          throw new Error(`生图接口未返回图片数据：${JSON.stringify(json ?? null).slice(0, 300)}`)
        }
        if (json.data.length !== requested) {
          warnings.push(`请求 ${requested} 张，接口实际返回 ${json.data.length} 张。`)
        }

        const saved = await persist({
          data: json.data,
          dir: resolveDir(exec, args.outputDir),
          filename: args.filename,
          prefix: 'image',
          signal: exec.signal,
          timeoutMs,
        })
        return toValue(saved, { model, endpoint, keySource: source, warnings })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'edit_image',
      description:
        '参考图生图（图生图）：上传 1-4 张本地参考图片，让模型基于参考图内容生成新图片（例如把参考人物放进新场景），' +
        '保存到本地文件并返回绝对路径；图片会直接在对话中渲染。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '描述要生成的新画面，包括参考图主体应如何呈现；英文描述通常效果更佳。',
        },
        images: {
          type: 'array',
          required: true,
          description: '本地参考图片路径列表（png/jpg/webp），1-4 张。相对路径按会话工作目录解析。',
          items: { type: 'string' },
        },
        size: sizeParam,
        quality: qualityParam,
        outputDir: outputDirParam,
        filename: filenameParam,
        n: countParam,
      },
      output: {
        schema: outputSchema,
        render: (_args, value) => renderValue(value, '已基于参考图生成'),
      },
      timeoutMs: numberField('timeoutMs', 180000),
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        kind: 'execute',
        title: '参考图生图',
        rawInput: { prompt: args.prompt, images: args.images },
      }),
      async execute(args, exec) {
        if (!Array.isArray(args.images) || args.images.length === 0) throw new Error('至少需要 1 张参考图')
        if (args.images.length > 4) throw new Error('参考图最多 4 张')

        const { key, source } = await resolveKey()
        const endpoint = endpointFor(stringField('baseURL', DEFAULT_BASE_URL), 'edits')
        const model = stringField('model', DEFAULT_MODEL)
        const timeoutMs = numberField('timeoutMs', 180000)
        const requested = Number.isInteger(args.n) && args.n > 0 ? args.n : 1
        const warnings = []

        const resolvedInputs = args.images.map((raw) => resolveInput(exec, raw))
        for (const filePath of resolvedInputs) {
          if (!existsSync(filePath)) throw new Error(`参考图不存在：${filePath}`)
        }

        const form = new FormData()
        form.append('model', model)
        form.append('prompt', args.prompt)
        form.append('n', String(requested))
        const size =
          (typeof args.size === 'string' ? args.size.trim() : '') ||
          stringField('defaultSize', '')
        const quality =
          (typeof args.quality === 'string' ? args.quality.trim() : '') ||
          stringField('defaultQuality', '')
        if (size.length > 0) form.append('size', size)
        if (quality.length > 0) form.append('quality', quality)
        for (let index = 0; index < resolvedInputs.length; index += 1) {
          const filePath = resolvedInputs[index]
          const bytes = await readFile(filePath)
          const mediaType = mediaTypeOf(bytes)
          const ext = path.extname(filePath).toLowerCase() || '.png'
          form.append('image[]', new Blob([bytes], { type: mediaType }), `ref${index}${ext}`)
        }

        ctx.logger?.info?.(
          `imagegen: POST ${endpoint} model=${model} refs=${resolvedInputs.length} n=${requested} key=${describeKey(key)}`,
        )

        const response = await fetchWithTimeout(
          endpoint,
          { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form },
          timeoutMs,
          exec.signal,
        )

        const raw = await response.text()
        if (!response.ok) throw new Error(`生图编辑接口返回 HTTP ${response.status}：${errorDetail(raw)}`)

        let json
        try {
          json = JSON.parse(raw)
        } catch {
          throw new Error(`生图编辑接口返回非 JSON 内容：${raw.slice(0, 200)}`)
        }
        if (!Array.isArray(json?.data) || json.data.length === 0) {
          throw new Error(`生图编辑接口未返回图片数据：${JSON.stringify(json ?? null).slice(0, 300)}`)
        }
        if (json.data.length !== requested) {
          warnings.push(`请求 ${requested} 张，接口实际返回 ${json.data.length} 张。`)
        }

        const saved = await persist({
          data: json.data,
          dir: resolveDir(exec, args.outputDir),
          filename: args.filename,
          prefix: 'edit',
          signal: exec.signal,
          timeoutMs,
        })
        return toValue(saved, { model, endpoint, keySource: source, warnings })
      },
    }),
  )

  // Ask the settings panel to render this plugin's automatic page from `Config`.
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.effect(
        () => settingsCtx.settings.configure({ auto: true }),
        'dsh-imagegen: settings page policy',
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-imagegen: settings page policy unavailable: ${error?.message ?? error}`)
    }
  })
}
