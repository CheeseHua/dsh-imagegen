// Local verification probe for dsh-imagegen (not shipped in the repo's lib/).
// Run: node tools/probe.mjs
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '..', 'lib', 'index.js')
const mod = await import(pathToFileURL(target).href)

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`)
  return ok
}

let pass = true
pass &= check('name', mod.name, 'dsh-imagegen')
pass &= check('inject', mod.inject, ['tools', 'attachments'])
pass &= check('endpoint bare host', mod.endpointFor('https://cf.api.fan', 'generations'), 'https://cf.api.fan/v1/images/generations')
pass &= check('endpoint /v1 + slash', mod.endpointFor('https://cf.api.fan/v1/', 'edits'), 'https://cf.api.fan/v1/images/edits')
pass &= check('endpoint empty → default', mod.endpointFor('', 'generations'), `${mod.DEFAULT_BASE_URL}/v1/images/generations`)
pass &= check('mask short', mod.maskSecret('abc'), '****')
pass &= check('mask long hides middle', mod.maskSecret('sk-abcdefghijklmnop'), '********mnop')
pass &= check('describeKey set', mod.describeKey('sk-abcdefghijklmnop'), '已配置(********mnop)')
pass &= check('describeKey unset', mod.describeKey(''), '未配置')
pass &= check('sniff png', mod.sniffExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '.png')
pass &= check('sniff jpg', mod.sniffExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), '.jpg')
pass &= check('mediaType png', mod.mediaTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
pass &= check('sanitize filename', mod.sanitizeFilename('a/b:c*d?.png'), 'a_b_c_d_.png')
pass &= check('sanitize empty', mod.sanitizeFilename('   '), 'image')
pass &= check('parseExtraBody empty', mod.parseExtraBody(''), {})
pass &= check('parseExtraBody object', mod.parseExtraBody('{"response_format":"b64_json"}'), { response_format: 'b64_json' })
pass &= check('errorDetail openai shape', mod.errorDetail('{"error":{"message":"boom"}}'), 'boom')

// The settings panel requires volatile fields; a non-volatile Config silently
// produces no editable page at all (see dsh-settings `volatileForm`, which
// walks `node.dict`). Schemastery serializes a schema as `{uid, refs}`.
const json = mod.Config.toJSON()
const root = json.refs?.[json.uid]
const properties = root?.dict ?? {}
const nameOf = (id) => Object.entries(properties).find(([, ref]) => ref === id)?.[0]
const fieldNames = Object.keys(properties)
const nodeOf = (name) => json.refs?.[properties[name]] ?? {}

const volatileFields = fieldNames.filter((field) => nodeOf(field).meta?.volatile === true)
const secretFields = fieldNames.filter((field) => nodeOf(field).meta?.role === 'secret')
console.log(`\nConfig root type   : ${root?.type}`)
console.log(`Config fields      : ${fieldNames.join(', ')}`)
console.log(`volatile fields    : ${volatileFields.join(', ')}`)
console.log(`secret fields      : ${secretFields.join(', ')}`)
pass &= check('root is an object', root?.type, 'object')
pass &= check('nine fields declared', fieldNames.length, 9)
pass &= check('every field is volatile', fieldNames.length === volatileFields.length, true)
pass &= check('apiKey is the only secret', secretFields, ['apiKey'])
pass &= check('apiKey default is empty', nodeOf('apiKey').meta?.default ?? '', '')
pass &= check('apiKeyEnv is a credential ref', nodeOf('apiKeyEnv').meta?.role, 'credential-ref')
pass &= check('schema has no plaintext key', JSON.stringify(json).includes('sk-'), false)
pass &= check('name lookup is stable', nameOf(properties.apiKey), 'apiKey')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES PRESENT'}`)
process.exitCode = pass ? 0 : 1
