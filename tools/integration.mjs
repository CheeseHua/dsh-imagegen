// Integration probe: run the real plugin against the real cordis Context and
// the real dsh-tools registry with stubbed sibling services, and assert that
// both tools register, validate, render, and complete a real HTTP round trip.
//
// Run: node tools/integration.mjs
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '..', 'lib', 'index.js')
const mod = await import(pathToFileURL(target).href)

let pass = true
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`)
  if (!ok) pass = false
}

/** The tool registry requires a systemPrompt sibling; a stub is enough here.
 * `tools()` is the one method ToolRuntime actually calls during construction. */
class StubSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    this.providers = []
  }
  section() {
    return () => {}
  }
  tools(provider) {
    this.providers.push(provider)
    return () => {
      const index = this.providers.indexOf(provider)
      if (index !== -1) this.providers.splice(index, 1)
    }
  }
}

/** A minimal durable-image store: records saves and returns attachment refs. */
class StubAttachments extends Service {
  constructor(ctx) {
    super(ctx, 'attachments')
    this.saved = []
    this.imageLimits = {
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxImageBytes: 20 * 1024 * 1024,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 100000000,
      maxImageDimension: 20000,
    }
  }
  async saveImage({ data, mediaType, name }) {
    this.saved.push({ bytes: data.length, mediaType, name })
    return {
      attachmentId: `att-${this.saved.length}`,
      mediaType,
      bytes: data.length,
      width: 1024,
      height: 1024,
      name,
    }
  }
}

/** Minimal credential store: enough to prove the key is written, not read back. */
class StubCredentials extends Service {
  constructor(ctx) {
    super(ctx, 'credentials')
    this.map = new Map()
  }
  async resolve(ref) {
    const value = this.map.get(ref)
    return value === undefined ? undefined : { value }
  }
  async set(ref, value) {
    this.map.set(ref, value)
  }
}

/** Records the path-addressed ops the panel issues. */
class StubSettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings')
    this.ops = []
  }
  async mutate(_ns, ops) {
    this.ops.push(...ops)
  }
}

/** Build a fresh context carrying the real registry plus the stubs.
 * Services are constructed directly (not via ctx.plugin) so registration is
 * synchronous and the registry sees its systemPrompt sibling immediately. */
const buildContext = (config) => {
  const ctx = new Context()
  const systemPrompt = new StubSystemPrompt(ctx)
  const attachments = new StubAttachments(ctx)
  const tools = new ToolRuntime(ctx, {})
  mod.apply(ctx, config)
  return { ctx, attachments, tools, systemPrompt }
}

const baseConfig = {
  baseURL: 'https://example.invalid',
  model: 'gpt-image-2',
  apiKey: '',
  apiKeyEnv: 'IMG_API_KEY',
  outputDir: '',
  timeoutMs: 30000,
  defaultSize: '1024x1024',
  defaultQuality: 'high',
  extraBodyJson: '',
}

/* ── 1. registration and model-facing schema ─────────────────────────────── */

const { ctx, tools } = buildContext(baseConfig)

check('both tools registered', ctx.tools.schemas().map((row) => row.name).sort(), ['edit_image', 'generate_image'])

for (const toolName of ['generate_image', 'edit_image']) {
  const schema = ctx.tools.schemas().find((row) => row.name === toolName)
  check(`${toolName} is model-visible`, schema !== undefined, true)
  check(`${toolName} has a real description`, (schema?.description?.length ?? 0) > 20, true)
  check(`${toolName} requires prompt`, schema?.parameters?.required?.includes('prompt') ?? false, true)
  check(`${toolName} exposes no apiKey parameter`, 'apiKey' in (schema?.parameters?.properties ?? {}), false)
  check(`${toolName} leaks no key material in its schema`, JSON.stringify(schema).includes('sk-'), false)
}

const editSchema = ctx.tools.schemas().find((row) => row.name === 'edit_image')
check('edit_image requires images', editSchema.parameters.required.includes('images'), true)

const definition = tools.get('generate_image')
check('generate_image is concurrency-safe', definition.isConcurrencySafe({ prompt: 'x' }), true)
check('generate_image declares its timeout', definition.timeoutMs, 30000)
check('a pending card is produced', definition.presentCall({ prompt: 'a cat' })?.card, 'generic')
check(
  'output renders text then image blocks',
  definition.output
    .render({ prompt: 'x' }, {
      images: [
        {
          index: 1,
          path: 'C:/tmp/a.png',
          mimeType: 'image/png',
          bytes: 3,
          image: { attachmentId: 'a', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        },
      ],
      paths: ['C:/tmp/a.png'],
      model: 'gpt-image-2',
      endpoint: 'https://example.invalid/v1/images/generations',
      keySource: 'env:IMG_API_KEY',
      warnings: [],
    })
    .map((block) => block.type),
  ['text', 'image'],
)

/* ── 2. a missing key fails loudly and leaks nothing ─────────────────────── */

// Point the legacy fallback at a path that cannot exist so this section tests
// the real "nothing configured" state rather than whatever is on this machine.
process.env.IMG_LEGACY_CONFIG_FILE = path.join(here, '.no-such-key-file.json')
delete process.env.IMG_API_KEY
const emptyCtx = buildContext(baseConfig)
try {
  await emptyCtx.tools.get('generate_image').execute({ prompt: 'x' }, { signal: new AbortController().signal })
  check('missing key throws', 'no error', 'an error')
} catch (error) {
  check('missing key is actionable', /API Key/.test(error.message), true)
  check('missing-key error names the settings page', /插件配置/.test(error.message), true)
  check('missing-key error carries no secret', /sk-/.test(error.message), false)
}

/* ── 3. the full HTTP path against a local server ────────────────────────── */

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let seenAuth = null
let seenBody = null
let seenPath = null
let failNext = false

const server = createServer((req, res) => {
  seenAuth = req.headers.authorization ?? null
  seenPath = req.url ?? null
  if (failNext) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'bad key' } }))
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    seenBody = body
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const outDir = path.resolve(here, '..', '.probe-out')
const liveConfig = {
  ...baseConfig,
  baseURL: `http://127.0.0.1:${port}`,
  apiKey: 'sk-integration-secret-value',
  outputDir: outDir,
}
const live = buildContext(liveConfig)

const value = await live.tools.get('generate_image').execute(
  { prompt: 'a red cube', n: 1 },
  { signal: new AbortController().signal },
)

check('generation returns one image', value.images.length, 1)
check('generation returns one path', value.paths.length, 1)
check('result reports the model', value.model, 'gpt-image-2')
check('result reports the resolved endpoint', value.endpoint, `http://127.0.0.1:${port}/v1/images/generations`)
check('result reports a non-secret key source', value.keySource, 'config')
check('no warnings when the count matches', value.warnings, [])
check('image carries durable attachment metadata', value.images[0].image?.attachmentId, 'att-1')
check('the attachment store received the bytes', live.attachments.saved.length, 1)
check('authorization header was sent', seenAuth, 'Bearer sk-integration-secret-value')
check('the configured default size rode the body', JSON.parse(seenBody).size, '1024x1024')
check('the configured default quality rode the body', JSON.parse(seenBody).quality, 'high')
check('the request used the generations path', seenPath, '/v1/images/generations')
check('the tool result never echoes the key', JSON.stringify(value).includes('sk-integration-secret-value'), false)
check('a file landed on disk', existsSync(value.paths[0]), true)

/* ── 4. the pre-plugin MCP key file still works as a fallback ────────────── */

const legacyFile = path.join(here, '.probe-legacy-key.json')
await writeFile(legacyFile, JSON.stringify({ apiKey: 'sk-from-legacy-file' }))
process.env.IMG_LEGACY_CONFIG_FILE = legacyFile
// No configured key and no credential ref, so only the legacy file can answer.
const legacyCtx = buildContext({ ...liveConfig, apiKey: '', apiKeyEnv: 'IMG_UNSET_KEY_ENV' })
const legacyValue = await legacyCtx.tools.get('generate_image').execute(
  { prompt: 'x' },
  { signal: new AbortController().signal },
)
check('legacy key file is honoured', legacyValue.keySource, 'legacy-key-file')
check('legacy key never reaches the result', JSON.stringify(legacyValue).includes('sk-from-legacy-file'), false)
await rm(legacyFile, { force: true })
delete process.env.IMG_LEGACY_CONFIG_FILE

/* ── 5. edit_image multipart path ────────────────────────────────────────── */

await writeFile(path.join(outDir, 'ref.png'), png)
seenBody = null
const edited = await live.tools.get('edit_image').execute(
  { prompt: 'put the object on a beach', images: [path.join(outDir, 'ref.png')], n: 1 },
  { signal: new AbortController().signal },
)
check('edit returns one image', edited.images.length, 1)
check('edit used the edits path', seenPath, '/v1/images/edits')
check('edit sent multipart form data', seenBody?.includes('name="model"') ?? false, true)
check('edit sent the prompt', seenBody?.includes('beach') ?? false, true)
check('edit sent the reference file part', seenBody?.includes('name="image[]"') ?? false, true)
check('edit result never echoes the key', JSON.stringify(edited).includes('sk-integration-secret-value'), false)

/* ── 6. provider errors surface safely ───────────────────────────────────── */

failNext = true
try {
  await live.tools.get('generate_image').execute({ prompt: 'x' }, { signal: new AbortController().signal })
  check('an HTTP error propagates', 'no error', 'an error')
} catch (error) {
  check('HTTP status is reported', /HTTP 401/.test(error.message), true)
  check('provider detail is reported', /bad key/.test(error.message), true)
  check('error carries no api key', /sk-integration-secret-value/.test(error.message), false)
}

/* ── 7. the settings panel service is strictly key-free ──────────────────── */

// The panel talks to ImagegenRuntime over Typert. Drive it directly: the point
// of these checks is that the API key can be written but never read back.
// Keep the legacy fallback out of the way so this section is machine-independent.
process.env.IMG_LEGACY_CONFIG_FILE = path.join(here, '.no-such-key-file.json')
const panelCtx = new Context()
const panelCredentials = new StubCredentials(panelCtx)
const panelSettings = new StubSettings(panelCtx)
const emptyReaders = mod.configReaders({ ...baseConfig, apiKey: '', apiKeyEnv: 'IMG_PANEL_TEST_KEY' })
const runtime = new mod.ImagegenRuntime(panelCtx, emptyReaders, { ...baseConfig, apiKey: '' })

const initial = await runtime.getConfig()
check('panel reports keySet=false with no key anywhere', initial.keySet, false)
check('panel reports source none', initial.keySource, 'none')
check('panel exposes the endpoint', initial.endpoint, 'https://example.invalid/v1/images/generations')
check(
  'panel payload has no apiKey field',
  Object.hasOwn(initial, 'apiKey'),
  false,
)
check('panel payload is key-free', JSON.stringify(initial).includes('sk-'), false)

const afterWrite = await runtime.setApiKey({ apiKey: 'sk-panel-secret-9999' })
check('writing a key flips keySet', afterWrite.keySet, true)
check('the write went to the credential service', panelCredentials.map.get('IMG_PANEL_TEST_KEY'), 'sk-panel-secret-9999')
check('the write never returns the secret', JSON.stringify(afterWrite).includes('sk-panel-secret-9999'), false)

const afterClear = await runtime.setApiKey({ clear: true })
check('clearing removes the stored value', panelCredentials.map.get('IMG_PANEL_TEST_KEY'), '')
check('clearing reports keySet=false again', afterClear.keySet, false)
delete process.env.IMG_LEGACY_CONFIG_FILE

// Ordinary fields route through the path-addressed settings mutation, so a
// form save can never restate (and therefore never erase) the stored secret.
await runtime.setConfig({ model: 'dall-e-3', timeoutMs: 4242, outputDir: 'C:/tmp/out' })
check('setConfig mutated the model path', panelSettings.ops.find((o) => o.path[0] === 'model')?.value, 'dall-e-3')
check('setConfig mutated the timeout path', panelSettings.ops.find((o) => o.path[0] === 'timeoutMs')?.value, 4242)
check(
  'setConfig never touches the apiKey path',
  panelSettings.ops.some((o) => o.path[0] === 'apiKey'),
  false,
)

/* ── 8. the client bundle exists and registers the settings section ──────── */

const clientSource = await readFile(path.resolve(here, '..', 'lib', 'client.js'), 'utf8')
check('client bundle uses the ModuleLoader wrapper', clientSource.includes('window.__ModuleLoader__.load'), true)
check('client bundle registers a settings section', clientSource.includes('settings.section'), true)
check('client bundle labels the section 生图', clientSource.includes("label: '生图'"), true)
check('client bundle only calls setApiKey, never reads a key', clientSource.includes('getApiKey'), false)

await rm(outDir, { recursive: true, force: true })
server.close()

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES PRESENT'}`)
process.exitCode = pass ? 0 : 1
