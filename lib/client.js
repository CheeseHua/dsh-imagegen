// dsh-imagegen — client half.
//
// Registers a 设置 →「生图」section that edits this plugin's configuration.
//
// The Web settings panel is itself a client plugin, so a host-only plugin never
// gets a section: it must ship this bundle (`dsh.client.platform = web`) and
// register into the `settings.section` slot.
//
// SECRET HANDLING: this file never receives the API key. The host service
// (ImagegenRuntime in lib/index.js) reports only `keySet` + `keySource`, so the
// key input below is strictly write-only — typing a value sends it once, and
// nothing in the bundle can read it back.

window.__ModuleLoader__.load({
  id: 'dsh-imagegen',
  factory: (require) => {
    var __create = Object.create
    var __defProp = Object.defineProperty
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor
    var __getOwnPropNames = Object.getOwnPropertyNames
    var __getProtoOf = Object.getPrototypeOf
    var __hasOwnProp = Object.prototype.hasOwnProperty
    var __copyProps = (to, from, except, desc) => {
      if ((from && typeof from === 'object') || typeof from === 'function') {
        for (let key of __getOwnPropNames(from)) {
          if (!__hasOwnProp.call(to, key) && key !== except) {
            __defProp(to, key, {
              get: () => from[key],
              enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
            })
          }
        }
      }
      return to
    }
    var __toESM = (mod, isNodeMode, target) => (
      (target = mod != null ? __create(__getProtoOf(mod)) : {}),
      __copyProps(
        isNodeMode || !mod || !mod.__esModule ? __defProp(target, 'default', { value: mod, enumerable: true }) : target,
        mod,
      )
    )
    var __toCommonJS = (mod) => __copyProps(__defProp({}, '__esModule', { value: true }), mod)

    var client_exports = {}
    var name = 'dsh-imagegen'
    var inject = ['slots']
    var import_react = __toESM(require('react'), 1)

    function el(type, props) {
      return import_react.default.createElement.apply(null, [type, props].concat(Array.prototype.slice.call(arguments, 2)))
    }

    var TEXT_FIELDS = [
      {
        key: 'baseURL',
        label: 'API 基地址',
        placeholder: 'https://cf.api.fan',
        hint: '带不带 /v1 都可以，插件会自动补全。',
      },
      { key: 'model', label: '模型', placeholder: 'gpt-image-2', hint: '例如 gpt-image-2、dall-e-3、flux-1.1-pro。' },
      {
        key: 'outputDir',
        label: '默认保存目录',
        placeholder: '留空 = 当前会话工作目录',
        hint: '绝对路径。留空则用会话的工作目录。',
      },
      { key: 'defaultSize', label: '默认尺寸', placeholder: '留空 = 服务端默认', hint: '例如 1024x1024、1536x1024。' },
      {
        key: 'defaultQuality',
        label: '默认质量',
        placeholder: '留空 = 服务端默认',
        hint: 'low / medium / high。',
      },
      {
        key: 'extraBodyJson',
        label: '附加请求体 (JSON)',
        placeholder: '{"response_format":"b64_json"}',
        hint: '中转站需要的额外字段，留空即可。',
      },
    ]

    var KEY_SOURCE_LABELS = {
      config: '设置面板里填写的 Key',
      'legacy-key-file': '旧的 ~/.dsh/imagegen-key.json',
      none: '尚未配置',
    }

    function sourceLabel(source) {
      if (KEY_SOURCE_LABELS[source] !== undefined) return KEY_SOURCE_LABELS[source]
      if (source.indexOf('credentials:') === 0) return '凭据服务 ' + source.slice('credentials:'.length)
      if (source.indexOf('env:') === 0) return '环境变量 ' + source.slice('env:'.length)
      return source
    }

    // Rendered in the panel footer so it is always obvious which bundle the
    // browser actually loaded — invaluable when a stale cache is suspected.
    var PANEL_BUILD = '1.1.0+routes'

    // This plugin's own routes (mirrors ROUTES in lib/index.js). Plain fetch is
    // used on purpose: it has no dependency on how the client runtime projects
    // Host services, so the panel keeps working across dsh versions.
    var ROUTES = {
      config: '/plugins/dsh-imagegen/config',
      key: '/plugins/dsh-imagegen/key',
    }

    /** One JSON round trip; surfaces the host's own error message on failure. */
    var call = (url, init) =>
      fetch(url, init).then((response) =>
        response
          .json()
          .catch(() => ({ ok: false, error: 'Host 返回了非 JSON 响应（HTTP ' + response.status + '）' }))
          .then((payload) => {
            if (!response.ok || payload.ok === false) {
              throw new Error(payload.error || 'HTTP ' + response.status)
            }
            return payload.config
          }),
      )

    var postJson = (url, body) =>
      call(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    function ImagegenSettings() {
      var [config, setConfig] = import_react.default.useState(null)
      var [draft, setDraft] = import_react.default.useState({})
      var [apiKey, setApiKey] = import_react.default.useState('')
      var [status, setStatus] = import_react.default.useState(null)
      var [busy, setBusy] = import_react.default.useState(false)

      var adopt = (next) => {
        setConfig(next)
        setDraft({
          baseURL: next.baseURL,
          model: next.model,
          outputDir: next.outputDir,
          timeoutMs: String(next.timeoutMs),
          defaultSize: next.defaultSize,
          defaultQuality: next.defaultQuality,
          extraBodyJson: next.extraBodyJson,
        })
      }

      import_react.default.useEffect(() => {
        var alive = true
        call(ROUTES.config)
          .then((next) => {
            if (alive) adopt(next)
          })
          .catch((err) => {
            if (alive) setStatus({ kind: 'err', text: '读取配置失败: ' + String((err && err.message) || err) })
          })
        return () => {
          alive = false
        }
      }, [])

      var save = () => {
        setBusy(true)
        setStatus(null)
        var timeout = Number(draft.timeoutMs)
        var patch = {
          baseURL: draft.baseURL,
          model: draft.model,
          outputDir: draft.outputDir,
          defaultSize: draft.defaultSize,
          defaultQuality: draft.defaultQuality,
          extraBodyJson: draft.extraBodyJson,
        }
        if (Number.isFinite(timeout) && timeout > 0) patch.timeoutMs = timeout

        var chain = postJson(ROUTES.config, patch)

        // The key is a separate, write-only call. Only send it when the user
        // actually typed something, so a plain save never rewrites the secret.
        var typed = apiKey.trim()
        if (typed.length > 0) {
          chain = chain.then(() =>
            postJson(ROUTES.key, { apiKey: typed }).then((next) => {
              setApiKey('')
              return next
            }),
          )
        }

        chain
          .then((next) => {
            adopt(next)
            setBusy(false)
            setStatus({ kind: 'ok', text: '已保存并即时生效。' })
          })
          .catch((err) => {
            setBusy(false)
            setStatus({ kind: 'err', text: '保存失败: ' + String((err && err.message) || err) })
          })
      }

      var clearKey = () => {
        if (typeof window !== 'undefined' && !window.confirm('确定清除已保存的 API Key 吗？')) return
        setBusy(true)
        setStatus(null)
        postJson(ROUTES.key, { clear: true })
          .then((next) => {
            adopt(next)
            setBusy(false)
            setStatus({ kind: 'ok', text: '已清除。' })
          })
          .catch((err) => {
            setBusy(false)
            setStatus({ kind: 'err', text: '清除失败: ' + String((err && err.message) || err) })
          })
      }

      if (config === null) {
        return el(
          'div',
          { style: { fontSize: 13, opacity: 0.7 } },
          status !== null ? status.text : '加载中…',
        )
      }

      var inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        fontSize: 13,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-3, transparent)',
        color: 'inherit',
      }
      var labelStyle = { fontSize: 12, opacity: 0.75, marginBottom: 3, display: 'block' }
      var rowStyle = { display: 'flex', flexDirection: 'column', gap: 2 }
      var gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }
      var buttonStyle = {
        padding: '7px 16px',
        fontSize: 13,
        borderRadius: 8,
        cursor: busy ? 'default' : 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
      }

      var set = (key) => (event) => {
        var value = event.target.value
        setDraft((prev) => Object.assign({}, prev, { [key]: value }))
      }

      var field = (spec) =>
        el(
          'label',
          { style: rowStyle, key: spec.key },
          el('span', { style: labelStyle }, spec.label),
          el('input', {
            type: 'text',
            value: draft[spec.key] === undefined ? '' : draft[spec.key],
            placeholder: spec.placeholder,
            onChange: set(spec.key),
            style: inputStyle,
          }),
          spec.hint !== undefined ? el('span', { style: { fontSize: 11, opacity: 0.55 } }, spec.hint) : null,
        )

      return el(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 } },

        el(
          'div',
          { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.6 } },
          '生图插件配置。改完点「保存」即时生效，无需重启。API Key 是只写字段：保存后不会回显，日志和工具结果里也不会出现明文。',
        ),

        el('div', { style: gridStyle }, TEXT_FIELDS.map(field)),

        el(
          'label',
          { style: rowStyle },
          el('span', { style: labelStyle }, '请求超时（毫秒）'),
          el('input', {
            type: 'number',
            min: 5000,
            max: 600000,
            value: draft.timeoutMs === undefined ? '' : draft.timeoutMs,
            onChange: set('timeoutMs'),
            style: inputStyle,
          }),
        ),

        el(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
            },
          },
          el(
            'div',
            { style: { fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            el('strong', null, 'API Key'),
            el(
              'span',
              { style: { opacity: 0.75 } },
              config.keySet ? '当前已配置（来源：' + sourceLabel(config.keySource) + '）' : '当前未配置',
            ),
          ),
          el('input', {
            type: 'password',
            value: apiKey,
            placeholder: config.keySet ? '留空 = 保持不变' : '粘贴你的 API Key',
            autoComplete: 'off',
            onChange: (event) => setApiKey(event.target.value),
            style: inputStyle,
          }),
          el(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            el('span', { style: { fontSize: 11, opacity: 0.55 } }, '写入凭据变量：' + config.apiKeyEnv),
            config.keySet
              ? el('button', { style: buttonStyle, onClick: clearKey, disabled: busy }, '清除已保存的 Key')
              : null,
          ),
        ),

        el(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          el('button', { style: buttonStyle, onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          status !== null
            ? el(
                'span',
                { style: { fontSize: 12, color: status.kind === 'ok' ? '#2e9e5b' : '#d64545' } },
                status.text,
              )
            : null,
        ),

        el(
          'div',
          { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.7 } },
          'Key 取值顺序：本面板填写的 → 凭据/环境变量 ' + config.apiKeyEnv + ' → 旧的 ~/.dsh/imagegen-key.json。',
        ),
        el('div', { style: { fontSize: 11, opacity: 0.45 } }, '实际调用接口：' + config.endpoint),
        el('div', { style: { fontSize: 10, opacity: 0.3 } }, '面板版本 ' + PANEL_BUILD),
      )
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'imagegen', order: 36, label: '生图' },
          () => import_react.default.createElement(ImagegenSettings, null),
        ),
      )
    }

    return __toCommonJS({ apply: apply, inject: inject, name: name })
  },
})
