import { randomUUID } from "node:crypto";

export class SearchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readText(message, limit, oversizeStatus = 502) {
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SearchError(oversizeStatus, `Body exceeds ${limit} bytes`);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function readSearch(body) {
  if (body?.model !== "web-search") throw new SearchError(400, "Unsupported search model");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new SearchError(400, "stream must be a boolean");
  if (!Array.isArray(body.tools) || body.tools.length !== 1 ||
      body.tools[0]?.type !== "web_search_20250305" || body.tools[0]?.name !== "web_search")
    throw new SearchError(400, "This provider only executes hosted web_search requests");
  const tool = body.tools[0];
  for (const name of Object.keys(tool)) {
    if (!["type", "name", "max_uses", "allowed_domains", "blocked_domains"].includes(name))
      throw new SearchError(400, `Unsupported web_search option: ${name}`);
  }
  if (tool.max_uses !== undefined && (!Number.isInteger(tool.max_uses) || tool.max_uses < 1))
    throw new SearchError(400, "max_uses must be a positive integer");
  if (tool.allowed_domains && tool.blocked_domains)
    throw new SearchError(400, "allowed_domains and blocked_domains are mutually exclusive");
  for (const field of ["allowed_domains", "blocked_domains"]) {
    if (tool[field] !== undefined && (!Array.isArray(tool[field]) ||
        !tool[field].every((d) => typeof d === "string" &&
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(d))))
      throw new SearchError(400, `${field} must contain DNS hostnames`);
  }
  if (body.tool_choice && !(
    ["auto", "any"].includes(body.tool_choice.type) ||
    (body.tool_choice.type === "tool" && body.tool_choice.name === "web_search")
  )) throw new SearchError(400, "tool_choice must allow web_search");
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
  const query = Array.isArray(last?.content)
    ? last.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n")
    : last?.content;
  if (last?.role !== "user" || typeof query !== "string" || !query.trim() || query.length > 8000)
    throw new SearchError(400, "Last message must be a user search query of 1 to 8000 characters");
  return { query: query.trim(), allowed: tool.allowed_domains, blocked: tool.blocked_domains };
}

export async function searchWeb(fetch, search, signal) {
  const res = await fetch("https://www.workbuddy.ai/agenttool/v1/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      "X-Request-ID": randomUUID().replaceAll("-", ""),
    },
    body: JSON.stringify({ query: search.query, type: "text2text", max_results: 5 }),
    signal,
  });
  const raw = await readText(res, 2 * 1024 * 1024);
  if (!res.ok)
    throw new SearchError(res.status === 401 || res.status === 403 ? res.status : 502,
      `WorkBuddy search returned HTTP ${res.status}`);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SearchError(502, "WorkBuddy search returned invalid JSON");
  }
  if (!data || typeof data !== "object")
    throw new SearchError(502, "WorkBuddy search returned an invalid response");
  if (data.code !== undefined && data.code !== null && String(data.code) !== "0")
    throw new SearchError(String(data.code) === "15001" ? 429 : 502,
      `WorkBuddy search refused the request (code ${data.code})`);
  if (!Array.isArray(data.results)) throw new SearchError(502, "WorkBuddy search returned no results array");
  const matches = (host, domains) => domains.some((d) =>
    host === d.toLowerCase() || host.endsWith("." + d.toLowerCase()));
  const results = data.results.map((r) => {
    if (!r || typeof r.title !== "string" || typeof r.url !== "string" || typeof r.snippet !== "string")
      throw new SearchError(502, "WorkBuddy search returned an invalid result");
    let url;
    try {
      url = new URL(r.url);
    } catch {
      throw new SearchError(502, "WorkBuddy search returned an invalid source URL");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new SearchError(502, "WorkBuddy search returned a non-HTTP source");
    return { title: r.title, url: r.url, snippet: r.snippet, host: url.hostname };
  }).filter((r) => (!search.allowed || matches(r.host, search.allowed)) &&
    (!search.blocked || !matches(r.host, search.blocked))).slice(0, 5);
  if (!results.length)
    throw new SearchError(502, "WorkBuddy search returned no results matching the requested domains");
  return results;
}

export function responseFor(results, query, streaming) {
  const id = "srvtoolu_" + randomUUID().replaceAll("-", "");
  const text = results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.url}`).join("\n\n");
  const content = [
    { type: "server_tool_use", id, name: "web_search", input: { query } },
    { type: "web_search_tool_result", tool_use_id: id, content: results.map((r) => ({
      type: "web_search_result", title: r.title, url: r.url, encrypted_content: "",
    })) },
    { type: "text", text },
  ];
  const message = {
    id: "msg_" + randomUUID().replaceAll("-", ""), type: "message", role: "assistant",
    model: "web-search", content, stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 1 } },
  };
  if (!streaming) return Response.json(message);
  const frames = [];
  const emit = (type, fields) => frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  emit("message_start", { message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      emit("content_block_start", { index, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "server_tool_use") {
      emit("content_block_start", { index, content_block: { ...block, input: {} } });
      emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      emit("content_block_start", { index, content_block: block });
    }
    emit("content_block_stop", { index });
  }
  emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
  emit("message_stop", {});
  return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
}
