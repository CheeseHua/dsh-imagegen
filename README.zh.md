# dsh-imagegen

DeepSeek Harness 的生图插件：把 OpenAI 兼容的图片生成 / 图片编辑接口注册成两个原生工具，
**并在 Web 界面里可视化配置模型和 API**——不用再手改 JSON 文件、不用重启 Harness。

- 🖼 `generate_image`：文字生成图片
- 🧩 `edit_image`：1–4 张本地参考图 + 描述生成新图（图生图）
- ⚙️ 设置 → 插件 → 插件配置 →「生图」：基地址、模型、尺寸、质量、超时、附加请求体全部可视化编辑，**改完即时生效**
- 🔒 API Key 是**只写字段**：面板永远不回显，日志与工具结果里也不会出现
- 📎 生成的图片作为附件直接渲染在对话里（同时落盘返回绝对路径）

---

## 安装

```bash
# 在你的 dsh profile 目录里（例如 ~/.dsh/profiles/web）
dsh plugin add github:CheeseHua/dsh-imagegen
```

`package.json` 里的 `dsh.bundle.patch` 会让插件自带的 `cordis.patch.yml` 自动挂载，
所以安装后不需要手工编辑 profile 的 `cordis.patch.yml`。

<details>
<summary>手工挂载（不想用 dsh plugin add 时）</summary>

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: imagegen
      name: dsh-imagegen
```

`id`（这里是 `imagegen`）同时就是设置面板里那张配置卡对应的命名空间。
</details>

## 配置

打开 **设置 →「生图」**。它和「内联图片」「Vision Router」等一样是设置左侧的一个栏目，
编辑的就是插件的实时配置：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://cf.api.fan` | API 基地址。带不带 `/v1` 都行，插件自动补全 |
| `model` | `gpt-image-2` | 模型名，例如 `gpt-image-2`、`dall-e-3`、`flux-1.1-pro` |
| `apiKey` | _空_ | **只写**。留空表示沿用已保存的值 / 凭据 / 环境变量 |
| `apiKeyEnv` | `IMG_API_KEY` | 备用来源：从凭据服务或环境变量读 Key 的变量名 |
| `outputDir` | _空_ | 默认保存目录；留空用当前会话的工作目录 |
| `timeoutMs` | `180000` | 单次请求超时（毫秒） |
| `defaultSize` | _空_ | 默认尺寸，如 `1024x1024`；留空交给服务端 |
| `defaultQuality` | _空_ | 默认质量：`low` / `medium` / `high`；留空交给服务端 |
| `extraBodyJson` | _空_ | 附加请求体 JSON，例如 `{"response_format":"b64_json"}` |

> **为什么必须有客户端 bundle。** 纯宿主端插件不会自动获得设置页：设置面板本身就是一个
> 客户端插件，只有声明了 `dsh.client.platform = web` 并且提供 `lib/client.js` 注册到
> `settings.section` 插槽，栏目才会出现。`lib/client.js` 就是这个 bundle，
> 而 `lib/index.js` 通过 Typert manifest 发布它调用的免密端点 `ctx.remote.imagegen`。

### API Key 的取值顺序

1. 设置面板里填的 `apiKey`
2. `apiKeyEnv` 指向的**凭据服务**条目
3. `apiKeyEnv` 指向的**环境变量**
4. 迁移兜底：`~/.dsh/imagegen-key.json`（老 MCP 版生图留下的文件）

四处都没有时会明确报错并告诉你该去哪里填。

### API Key 不会被泄露

- `apiKey` 在 schema 里声明为 `role('secret')`。设置接口跨进程读取时会**结构性地剥掉**这个字段，
  面板只收到一个 `{ path, set }` 标记（"是否已配置"），因此**没有任何界面能显示 Key 的明文**。
- 保存走**按路径寻址的写操作**，而不是整段覆盖，所以一次表单提交既不会读到、也不会误删已存的 Key。
- 日志与错误信息统一经过掩码处理，最多只出现 `已配置(********mnop)` 这种形式。
- 工具结果里只有文件路径、模型名、接口地址和一个**非敏感的来源标签**（如 `config` / `env:IMG_API_KEY`）。

> 如果你要把它公开托管，请确认 profile 的 `cordis.patch.yml`（可能含 Key）不要提交进任何仓库。

## 工具

### `generate_image`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | ✅ | 画面描述；英文通常效果更好 |
| `size` | | 覆盖配置默认尺寸 |
| `quality` | | 覆盖配置默认质量 |
| `outputDir` | | 覆盖配置默认目录 |
| `filename` | | 文件名（不含扩展名） |
| `n` | | 张数 1–4，默认 1 |

### `edit_image`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | ✅ | 新画面描述，含参考图主体如何呈现 |
| `images` | ✅ | 1–4 个本地参考图路径；相对路径按会话工作目录解析 |
| `size` / `quality` / `outputDir` / `filename` / `n` | | 同上 |

两个工具都会把图片同时做两件事：**写成本地文件**（返回绝对路径）并**存为附件**，
所以对话里会直接看到图，文件也在磁盘上。

## 从旧版 MCP 生图迁移

旧版本是通过一个 MCP stdio 服务器注册 `mcp__imagegen__*` 工具的，配置只能写
`~/.dsh/imagegen-key.json`。迁移方法：

1. 安装本插件（见上）。
2. 停用旧的 MCP 行——在 profile 的 `cordis.patch.yml` 里把那条 `insert` 注释掉或加 `disabled: true`。
3. 打开设置面板填好模型 / 基地址；**Key 可以留空**，插件会自动读取原来的
   `~/.dsh/imagegen-key.json` 作为兜底。
4. 工具名从 `mcp__imagegen__generate_image` 变成 `generate_image`（参数完全兼容）。

## 兼容性

- 走标准 OpenAI 图片接口：`POST {baseURL}/v1/images/generations` 与 `POST {baseURL}/v1/images/edits`。
  中转站、官方 API、兼容实现都能用；`baseURL` 写成 `https://host/v1` 也不会重复拼 `/v1`。
- `response_format` 之类的额外字段请用 `extraBodyJson` 传，因为不同中转站支持程度不同。
- 返回体支持 `b64_json` 和 `url` 两种形式（`url` 会被下载后落盘）。
- 需要 Node ≥ 22，依赖 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools`（由 dsh 提供）。

## 开发

```bash
node tools/probe.mjs        # 纯函数 + Config schema 断言（无需 dsh）
node tools/integration.mjs  # 真实 cordis Context + 真实 ToolRegistry + 本地 HTTP 往返
```

`tools/integration.mjs` 会起一个本地 HTTP 服务器，真实跑完生成 / 图生图 / 错误分支，
并断言 Key 不出现在工具 schema、结果或错误消息里。`lib/` 里没有任何测试代码。

> **推送 CI 注意**：本仓库的 git 凭据缺少 `workflow` OAuth 作用域，改动
> `.github/workflows/` 的提交会被拒绝。执行一次
> `gh auth refresh -h github.com -s workflow` 即可恢复正常推送。

## 许可证

MIT
