const BACKEND_URL = "http://localhost:8787";

async function requestBackend({ method, path, body, timeoutMs }) {
  if (typeof path !== "string" || !path.startsWith("/api/")) {
    throw new Error("Unsupported backend path");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 10000);
  try {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: method === "POST" ? "POST" : "GET",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Backend ${path} returned ${response.status}: ${text.slice(0, 180)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "agent24:backend") return undefined;

  requestBackend(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
