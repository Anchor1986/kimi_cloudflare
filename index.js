export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === "/") {
      return new Response(INDEX_HTML(), {
        headers: { "Content-Type": "text/html;charset=utf-8" }
      })
    }

    if (url.pathname === "/api/chat") {
      return chatHandler(request, env)
    }

    return new Response("404", { status: 404 })
  }
}

async function chatHandler(req, env) {
  const { message, userId } = await req.json();
  const key = `chat:${userId}`;

  let history = (await env.CONVERSATIONS.get(key, { type: "json" })) || [];
  history.push({ role: "user", content: message });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let fullResponse = "";

  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });

  // 后台处理 AI 流
  (async () => {
    try {
      const aiStream = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
        messages: history,
        stream: true,
        max_tokens: 4096,
      });

      const reader = aiStream.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 正确解码这一块数据
        const chunkText = decoder.decode(value, { stream: true });

        // === 关键：解析 OpenAI 格式的 chunk ===
        let token = "";
        try {
          // 有些 chunk 是纯 JSON，有些可能是多个 data 混在一起，这里简单处理
          const lines = chunkText.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const dataStr = trimmed.slice(6).trim();
            if (dataStr === "[DONE]" || dataStr === "") continue;

            const parsed = JSON.parse(dataStr);

            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
              const delta = parsed.choices[0].delta;
              token = delta.reasoning_content || delta.content || "";
            } else if (parsed.response) {
              token = parsed.response;
            }

            if (token) {
              fullResponse += token;
              // 转发给前端（统一成简单格式）
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ response: token })}\n\n`)
              );
            }
          }
        } catch (parseErr) {
          // 如果解析失败，直接尝试把原始文本发出去（保底）
          if (chunkText.trim()) {
            fullResponse += chunkText;
            await writer.write(
              encoder.encode(`data: ${JSON.stringify({ response: chunkText })}\n\n`)
            );
          }
        }
      }

      // 保存历史对话
      history.push({ role: "assistant", content: fullResponse });
      await env.CONVERSATIONS.put(key, JSON.stringify(history), {
        expirationTtl: 86400,
      });

    } catch (err) {
      console.error("AI stream error:", err);
      try {
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ error: "AI 生成出错" })}\n\n`)
        );
      } catch (e) {}
    } finally {
      try {
        await writer.close();
      } catch (e) {}
    }
  })();

  return response;
}

function INDEX_HTML() {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Kimi Chat</title>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #1e1e1e;   /* 深色背景 */
  color: #eee;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#chat {
  flex: 1;
  overflow-y: auto;
  padding: 15px 10px;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.msg {
  padding: 12px 16px;
  margin: 4px 0;
  border-radius: 18px;
  max-width: 85%;
  min-width: 50px;
  line-height: 1.45;
  font-size: 15.5px;
  word-wrap: break-word;
  display: inline-block;
  animation: fadeIn 0.2s ease-in;
}

.user {
  background: #007bff;
  color: white;
  margin-left: auto;
  border-bottom-right-radius: 4px;
}

.ai {
  background: #2c2c2c;
  color: #eee;
  margin-right: auto;
  border-bottom-left-radius: 4px;
  position: relative;
}

/* Markdown 渲染样式 */
.ai p { margin: 0.6em 0; }
.ai p:first-child { margin-top: 0; }
.ai p:last-child { margin-bottom: 0; }
.ai h1, .ai h2, .ai h3, .ai h4, .ai h5, .ai h6 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
}
.ai h1 { font-size: 1.35em; }
.ai h2 { font-size: 1.25em; }
.ai h3 { font-size: 1.15em; }
.ai ul, .ai ol {
  margin: 0.5em 0;
  padding-left: 1.4em;
}
.ai li { margin: 0.2em 0; }
.ai pre {
  background: #1a1a1a;
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
  margin: 0.6em 0;
  position: relative;
}
.ai .copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 4px 10px;
  font-size: 12px;
  background: #444;
  color: #ddd;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
}
.ai pre:hover .copy-btn {
  opacity: 1;
}
.ai .copy-btn:hover {
  background: #555;
}
.ai code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.ai pre code {
  background: transparent;
  padding: 0;
  color: #d4d4d4;
}
.ai :not(pre) > code {
  background: #3a3a3a;
  padding: 2px 5px;
  border-radius: 4px;
  color: #ff7b72;
}
.ai blockquote {
  border-left: 3px solid #555;
  margin: 0.6em 0;
  padding-left: 12px;
  color: #bbb;
}
.ai table {
  border-collapse: collapse;
  margin: 0.6em 0;
  width: 100%;
}
.ai th, .ai td {
  border: 1px solid #444;
  padding: 6px 10px;
  text-align: left;
}
.ai th {
  background: #333;
}
.ai hr {
  border: none;
  border-top: 1px solid #444;
  margin: 0.8em 0;
}
.ai a { color: #58a6ff; }
.ai img { max-width: 100%; border-radius: 6px; }

.loading::after {
  content: "";
  display: inline-block;
  width: 20px;
  text-align: left;
  animation: dots 1s steps(4, end) infinite;
}

@keyframes dots {
  0% { content: ""; }
  25% { content: "."; }
  50% { content: ".."; }
  75% { content: "..."; }
  100% { content: ""; }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}

#bar {
  padding: 10px 12px;
  background: #2c2c2c;
  border-top: 1px solid #444;
  display: flex;
  gap: 8px;
}

#input {
  flex: 1;
  padding: 14px 16px;
  border: 1px solid #444;
  border-radius: 25px;
  font-size: 16px;
  outline: none;
  background: #1e1e1e;
  color: #eee;
}

button {
  padding: 0 20px;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 25px;
  font-size: 16px;
  min-width: 60px;
  cursor: pointer;
}

button:active {
  background: #0062cc;
}

@media (max-width: 768px) {
  #chat { padding: 12px 8px; }
  .msg { max-width: 92%; padding: 11px 14px; font-size: 15.5px; }
  #bar { padding: 8px 10px; }
  #input { padding: 13px 16px; }
}

@media (max-width: 480px) { .msg { max-width: 95%; } }
</style>
</head>

<body>

<div id="chat"></div>

<div id="bar">
<input id="input" placeholder="输入消息...">
<button onclick="sendMessage()">发送</button>
</div>

<!-- 在 body 结束前引入 marked -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>

<script>
const chat = document.getElementById("chat")
const userId = Math.random().toString(36)

function addCopyButtons(container) {
  container.querySelectorAll("pre").forEach(pre => {
    if (pre.querySelector(".copy-btn")) return
    const btn = document.createElement("button")
    btn.className = "copy-btn"
    btn.textContent = "复制"
    btn.onclick = () => {
      const code = pre.querySelector("code")
      const text = code ? code.innerText : pre.innerText
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "已复制"
        setTimeout(() => btn.textContent = "复制", 1500)
      }).catch(() => {
        btn.textContent = "失败"
        setTimeout(() => btn.textContent = "复制", 1500)
      })
    }
    pre.appendChild(btn)
  })
}

function add(role, text="", loading=false) {
  const div = document.createElement("div")
  div.className = "msg " + role
  if (loading) div.classList.add("loading")
  // 初始可以为空
  div.innerHTML = text ? marked.parse(text) : ""
  if (text) addCopyButtons(div)
  chat.appendChild(div)
  chat.scrollTop = chat.scrollHeight
  return div
}

async function sendMessage() {
  const input = document.getElementById("input")
  const text = input.value.trim()
  if (!text) return

  add("user", text)
  input.value = ""

  const aiBox = add("ai", "", true)  // loading 动画

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, userId: userId })
    })

    if (!res.ok) {
      aiBox.innerHTML = "<em>请求失败</em>"
      aiBox.classList.remove("loading")
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let mdText = ""   // 累积原始 Markdown 文本
    aiBox.innerHTML = ""
    aiBox.classList.remove("loading")

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6).trim()
          if (dataStr === "[DONE]" || dataStr === "") continue

          try {
            const parsed = JSON.parse(dataStr)
            let token = ""
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
              const delta = parsed.choices[0].delta
              if (delta.reasoning_content) token = delta.reasoning_content
              else if (delta.content) token = delta.content
            } else if (parsed.response) token = parsed.response

            if (token) {
              mdText += token
              aiBox.innerHTML = marked.parse(mdText)
              addCopyButtons(aiBox)
              chat.scrollTop = chat.scrollHeight
            }
          } catch(e) {
            // 解析失败时，直接把原始数据当文本追加
            if (dataStr && dataStr !== "[DONE]") {
              mdText += dataStr
              aiBox.innerHTML = marked.parse(mdText)
              addCopyButtons(aiBox)
              chat.scrollTop = chat.scrollHeight
            }
          }
        }
      }
    }
  } catch(err) {
    console.error("Stream error:", err)
    aiBox.innerHTML += "<em>[发生错误]</em>"
  }
}

const input = document.getElementById("input")
input.addEventListener("keydown", function(e) {
  if (e.key === "Enter") { e.preventDefault(); sendMessage() }
})
</script>

</body>
</html>
`
}
