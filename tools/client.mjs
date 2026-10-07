// Client-bundle probe: load lib/client.js the way the Web GUI's ModuleLoader
// does, then register the section and render it with a stubbed host so the
// registration path, the read path and the write path all actually execute.
//
// Run: node tools/client.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.resolve(here, '..', 'lib', 'client.js'), 'utf8')

let pass = true
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`)
  if (!ok) pass = false
}

/* ── a tiny React stand-in: createElement + the two hooks the bundle uses ── */

const hookState = []
let hookIndex = 0
let effects = []

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const slot = hookIndex++
    if (hookState[slot] === undefined) hookState[slot] = typeof initial === 'function' ? initial() : initial
    return [
      hookState[slot],
      (next) => {
        hookState[slot] = typeof next === 'function' ? next(hookState[slot]) : next
      },
    ]
  },
  useEffect: (fn) => {
    hookIndex++
    effects.push(fn)
  },
}

/* ── capture the module exactly as the loader does ───────────────────────── */

let loaderId = null
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      loaderId = entry.id
      registered = entry.factory((name) => {
        if (name === 'react') return react
        throw new Error(`unexpected require(${name})`)
      })
    },
  },
}
globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } }
new Function('window', `${source}\nreturn window.__ModuleLoader__;`)(globalThis.window)

check('bundle registers under the plugin id', loaderId, 'dsh-imagegen')
check('module exposes name', registered?.name, 'dsh-imagegen')
check('module injects the slots service', registered?.inject, ['slots'])
check('module exposes apply', typeof registered?.apply, 'function')

/* ── a fetch stand-in for the plugin's own routes ────────────────────────── */

const calls = []
const hostConfig = {
  baseURL: 'https://cf.api.fan',
  model: 'gpt-image-2',
  apiKeyEnv: 'IMG_API_KEY',
  outputDir: '',
  timeoutMs: 180000,
  defaultSize: '',
  defaultQuality: '',
  extraBodyJson: '',
  keySet: true,
  keySource: 'legacy-key-file',
  endpoint: 'https://cf.api.fan/v1/images/generations',
}
let failNextPost = null
globalThis.fetch = async (url, init) => {
  const method = init?.method ?? 'GET'
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  calls.push([method, url, body])
  // Only writes can fail here, so the initial GET still renders the form.
  if (failNextPost !== null && method === 'POST') {
    const message = failNextPost
    failNextPost = null
    return { ok: false, status: 400, json: async () => ({ ok: false, error: message }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, config: hostConfig }) }
}

const registrations = []
const slots = {
  inject: (_slot, run) => run(),
  register: (options, render) => registrations.push({ options, render }),
}
const ctx = {
  get: (key) => (key === 'slots' ? slots : undefined),
  effect: () => () => {},
}
registered.apply(ctx)

check('exactly one section registered', registrations.length, 1)
const section = registrations[0]
check('registered into settings.section', section.options.name, 'settings.section')
check('section id', section.options.id, 'imagegen')
check('section label is 生图', section.options.label, '生图')


/* ── render helpers ──────────────────────────────────────────────────────── */

/** Invoke a function component (that is where hooks live), then recurse. */
const instantiate = (value) => {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((entry) => instantiate(entry))
  if (typeof value === 'object' && typeof value.type === 'function') {
    return instantiate(value.type(value.props))
  }
  if (typeof value === 'object' && value.type !== undefined) {
    return { ...value, children: (value.children ?? []).map((child) => instantiate(child)) }
  }
  return value
}

/** Mount the section and drain effects so the async config read settles.
 * Hook state is cleared first: each mount is a fresh component instance. */
const mount = async () => {
  hookState.length = 0
  hookIndex = 0
  effects = []
  instantiate(section.render({}))
  const pending = effects
  effects = []
  for (const fn of pending) fn()
  await new Promise((resolve) => setTimeout(resolve, 15))
  hookIndex = 0
  effects = []
  return instantiate(section.render({}))
}

/** Depth-first walk collecting every element in the tree. */
const collect = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

const flattenText = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return flattenText(node.children)
}

/* ── mount against the stubbed host ──────────────────────────────────────── */

const tree = await mount()
check('renders a container element', tree?.type, 'div')
const nodes = collect(tree)
const inputs = nodes.filter((node) => node.type === 'input')
const buttons = nodes.filter((node) => node.type === 'button')

const CONFIG_ROUTE = '/plugins/dsh-imagegen/config'
const KEY_ROUTE = '/plugins/dsh-imagegen/key'
const hits = (method, url) => calls.filter(([m, u]) => m === method && u === url)

check('the config was actually read', hits('GET', CONFIG_ROUTE).length, 1)
check('renders a password input for the key', inputs.some((node) => node.props.type === 'password'), true)
check(
  'password input disables autocomplete',
  inputs.find((node) => node.props.type === 'password')?.props.autoComplete,
  'off',
)
check('reports the existing key as configured', flattenText(tree).includes('当前已配置'), true)
check('reports the key source', flattenText(tree).includes('imagegen-key.json'), true)
check('shows the resolved endpoint', flattenText(tree).includes('/v1/images/generations'), true)
check('never renders key material', JSON.stringify(tree).includes('sk-'), false)
check('shows a panel build marker', flattenText(tree).includes('面板版本 1.1.0'), true)

// Typing a key re-renders (as React would), then saving must write it once.
const password = inputs.find((node) => node.props.type === 'password')
password.props.onChange({ target: { value: 'sk-typed-by-user' } })
hookIndex = 0
effects = []
const typedTree = instantiate(section.render({}))
const save = collect(typedTree)
  .filter((node) => node.type === 'button')
  .find((node) => flattenText(node) === '保存')
check('has a save button', save !== undefined, true)
save.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 15))
check('save posted the config patch', hits('POST', CONFIG_ROUTE).length, 1)
check('save wrote the typed key once', hits('POST', KEY_ROUTE)[0]?.[2], { apiKey: 'sk-typed-by-user' })

// A plain save (nothing typed) must leave the stored secret alone.
calls.length = 0
const tree2 = await mount()
const save2 = collect(tree2)
  .filter((node) => node.type === 'button')
  .find((node) => flattenText(node) === '保存')
save2.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 15))
check('plain save still updates config', hits('POST', CONFIG_ROUTE).length, 1)
check('plain save never touches the key', hits('POST', KEY_ROUTE).length, 0)

// Clearing is explicit and separate.
calls.length = 0
globalThis.window.confirm = () => true
const tree3 = await mount()
const clear = collect(tree3)
  .filter((node) => node.type === 'button')
  .find((node) => flattenText(node).includes('清除'))
check('has a clear-key button when a key is set', clear !== undefined, true)
clear.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 15))
check('clear asks the host to clear', hits('POST', KEY_ROUTE)[0]?.[2], { clear: true })

// A host-side failure must surface in the panel, not throw.
calls.length = 0
failNextPost = '凭据服务不可用'
const tree4 = await mount()
const save4 = collect(tree4)
  .filter((node) => node.type === 'button')
  .find((node) => flattenText(node) === '保存')
save4.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 15))
// Re-render so the status the failed save installed is visible.
hookIndex = 0
effects = []
const afterFailure = instantiate(section.render({}))
check('a host error renders a message', flattenText(afterFailure).includes('保存失败'), true)
check('the host message is shown verbatim', flattenText(afterFailure).includes('凭据服务不可用'), true)

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES PRESENT'}`)
process.exitCode = pass ? 0 : 1
