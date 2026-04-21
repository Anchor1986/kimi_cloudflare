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
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f5f5f5;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    #chat {
      flex: 1;
      overflow-y: auto;
      padding: 15px 10px;
      background: #f5f5f5;
      scrollbar-width: thin;
    }

    .msg {
      padding: 12px 16px;
      margin: 8px 0;
      border-radius: 18px;
      max-width: 85%;
      line-height: 1.45;
      font-size: 15.5px;
      word-wrap: break-word;
    }

    .user {
      background: #007bff;
      color: white;
      margin-left: auto;
      border-bottom-right-radius: 4px;
    }

    .ai {
      background: white;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
      margin-right: auto;
      border-bottom-left-radius: 4px;
    }

    #bar {
      padding: 10px 12px;
      background: white;
      border-top: 1px solid #ddd;
      display: flex;
      gap: 8px;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.05);
    }

    #input {
      flex: 1;
      padding: 14px 16px;
      border: 1px solid #ddd;
      border-radius: 25px;
      font-size: 16px;           /* 防止移动端自动缩放 */
      outline: none;
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

    /* 移动端优化 */
    @media (max-width: 768px) {
      #chat {
        padding: 12px 8px;
      }
      
      .msg {
        max-width: 92%;
        padding: 11px 14px;
        font-size: 15.5px;
      }

      #bar {
        padding: 8px 10px;
      }

      #input {
        padding: 13px 16px;
      }
    }

    /* 超小屏额外优化 */
    @media (max-width: 480px) {
      .msg {
        max-width: 95%;
      }
    }
  </style>

</head>

<body>

<div id="chat"></div>

<div id="bar">
<input id="input">
<button onclick="sendMessage()">发送</button>
</div>

<script>
const chat = document.getElementById("chat")
const userId = Math.random().toString(36)

function add(role, text) {
  const div = document.createElement("div")
  div.className = "msg " + role
  div.innerText = text
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

  const aiBox = add("ai", "")   // 空的 AI 消息框

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, userId: userId })
    })

    if (!res.ok) {
      aiBox.innerText = "请求失败"
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

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

            // === 关键解析逻辑（适配你现在的流格式）===
            let token = ""

            if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
              const delta = parsed.choices[0].delta
              // 优先取 reasoning_content（你模型输出的大部分内容在这里）
              if (delta.reasoning_content) {
                token = delta.reasoning_content
              } 
              // 再取普通 content（最终回答部分）
              else if (delta.content) {
                token = delta.content
              }
            } 
            // 兼容最后总结的 response 字段
            else if (parsed.response) {
              token = parsed.response
            }

            if (token) {
              aiBox.innerText += token
              chat.scrollTop = chat.scrollHeight
            }
          } catch (e) {
            // 解析失败时尝试直接追加（保底）
            if (dataStr && dataStr !== "[DONE]") {
              aiBox.innerText += dataStr
              chat.scrollTop = chat.scrollHeight
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Stream error:", err)
    aiBox.innerText += "[发生错误]"
  }
}

const input = document.getElementById("input")
input.addEventListener("keydown", function(e) {
  if (e.key === "Enter") {
    e.preventDefault()   
    sendMessage()
  }
})
</script>

</body>
</html>
`
}