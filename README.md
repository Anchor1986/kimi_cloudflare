# Kimi on Cloudflare Workers

利用 Cloudflare 每天提供的免费 Worker AI 额度，免费使用 Kimi K2.6 模型。

## 一键部署

```bash
npm install -g wrangler && wrangler login && wrangler kv:namespace create CONVERSATIONS
```

将返回的 KV ID 填入 `wrangler.toml`，然后：

```bash
wrangler deploy
```

## 特性

- **免费使用**：Cloudflare Worker AI 每天提供免费额度
- **流式响应**：实时流式输出，体验流畅
- **对话上下文**：自动保存对话历史，通过 KV 存储
- **简洁 UI**：适配移动端的简洁聊天界面

## 部署

1. 创建 Cloudflare 账户并安装 [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)：

```bash
npm install -g wrangler
```

2. 登录 Cloudflare：

```bash
wrangler login
```

3. 创建 KV 命名空间：

```bash
wrangler kv:namespace create CONVERSATIONS
```

4. 将 KV 命名空间 ID 填入 `wrangler.toml`：

```
[[kv_namespaces]]
binding = "CONVERSATIONS"
id = "<你的 KV 命名空间 ID>"
```

5. 部署：

```bash
wrangler deploy
```

## 使用

部署后访问 Workers 域名即可开始聊天。

## 技术栈

- Cloudflare Workers
- Cloudflare Worker AI (`@cf/moonshotai/kimi-k2.6`)
- Cloudflare KV（对话历史存储）