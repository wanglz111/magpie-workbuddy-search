import assert from "node:assert/strict";
import test from "node:test";

import { readSearch, responseFor, searchWeb } from "../src/search.mjs";

const OK_RESULT = {
  title: "Example result",
  url: "https://docs.example.com/guide",
  snippet: "A useful snippet.",
};

function requestBody(overrides = {}) {
  return {
    model: "web-search",
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: "find the guide" }],
    ...overrides,
  };
}

function fakeUpstream(payload, init = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (init.reject) throw init.reject;
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, requests };
}

test("readSearch accepts structured content and trims its text", () => {
  const body = requestBody({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "  first line  " },
        { type: "image", source: {} },
        { type: "text", text: "second line" },
      ],
    }],
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 1,
      allowed_domains: ["example.com"],
    }],
  });

  assert.deepEqual(readSearch(body), {
    query: "first line  \nsecond line",
    allowed: ["example.com"],
    blocked: undefined,
  });
});

test("searchWeb forwards one bounded request and filters by DNS suffix", async () => {
  const upstream = fakeUpstream({
    code: 0,
    results: [
      { ...OK_RESULT, title: "Exact", url: "https://example.com/a" },
      { ...OK_RESULT, title: "Subdomain", url: "https://news.example.com/b" },
      { ...OK_RESULT, title: "Blocked child", url: "https://ads.example.com/c" },
      { ...OK_RESULT, title: "Lookalike", url: "https://badexample.com/d" },
      { ...OK_RESULT, title: "Other", url: "https://other.test/e" },
    ],
  });
  const search = { query: "guide", allowed: ["example.com"], blocked: ["ads.example.com"] };

  const results = await searchWeb(upstream.fetch, search, new AbortController().signal);

  assert.deepEqual(results.map(({ title, host }) => ({ title, host })), [
    { title: "Exact", host: "example.com" },
    { title: "Subdomain", host: "news.example.com" },
  ]);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, "https://www.workbuddy.ai/agenttool/v1/search");
  assert.deepEqual(JSON.parse(upstream.requests[0].options.body), {
    query: "guide",
    type: "text2text",
    max_results: 5,
  });
  assert.match(upstream.requests[0].options.headers["X-Request-ID"], /^[a-f0-9]{32}$/);
});

test("blocked domains reject lookalikes but allow proper subdomains", async () => {
  const upstream = fakeUpstream({
    code: 0,
    results: [
      { ...OK_RESULT, title: "Blocked", url: "https://api.blocked.test/a" },
      { ...OK_RESULT, title: "Lookalike", url: "https://notblocked.test/b" },
      { ...OK_RESULT, title: "Allowed", url: "https://allowed.test/c" },
    ],
  });
  const search = { query: "guide", allowed: undefined, blocked: ["blocked.test"] };

  const results = await searchWeb(upstream.fetch, search, new AbortController().signal);

  assert.deepEqual(results.map((result) => result.title), ["Lookalike", "Allowed"]);
});

test("upstream HTTP failures never produce results", async (t) => {
  for (const [status, expected] of [[401, 401], [403, 403], [429, 502], [500, 502]]) {
    await t.test(`HTTP ${status}`, async () => {
      const upstream = fakeUpstream({ code: 0, results: [OK_RESULT] }, { status });
      await assert.rejects(
        searchWeb(upstream.fetch, { query: "guide" }, new AbortController().signal),
        (error) => error.status === expected,
      );
    });
  }
});

test("quota refusals are surfaced as 429 and other refusals fail", async (t) => {
  for (const [code, status] of [[15001, 429], ["15001", 429], [40001, 502]]) {
    await t.test(`code ${code}`, async () => {
      const upstream = fakeUpstream({ code, results: [OK_RESULT] });
      await assert.rejects(
        searchWeb(upstream.fetch, { query: "guide" }, new AbortController().signal),
        (error) => error.status === status,
      );
    });
  }
});

test("malformed upstream data is rejected rather than returned", async (t) => {
  const cases = [
    ["invalid JSON", "not-json", "invalid JSON"],
    ["missing results", { code: 0 }, "no results array"],
    ["non-object result", { code: 0, results: [null] }, "invalid result"],
    ["invalid source URL", { code: 0, results: [{ ...OK_RESULT, url: "not a URL" }] }, "invalid source URL"],
    ["non-HTTP source", { code: 0, results: [{ ...OK_RESULT, url: "file:///tmp/guide" }] }, "non-HTTP source"],
    ["empty result list", { code: 0, results: [] }, "no results matching"],
  ];

  for (const [name, payload, message] of cases) {
    await t.test(name, async () => {
      const upstream = fakeUpstream(payload);
      await assert.rejects(
        searchWeb(upstream.fetch, { query: "guide" }, new AbortController().signal),
        (error) => error.status === 502 && error.message.includes(message),
      );
    });
  }
});

test("network failures are not converted into successful results", async () => {
  const failure = new Error("network unavailable");
  const upstream = fakeUpstream(undefined, { reject: failure });

  await assert.rejects(
    searchWeb(upstream.fetch, { query: "guide" }, new AbortController().signal),
    (error) => error === failure,
  );
});

test("responseFor returns structured sources and the rendered text", () => {
  const results = [{
    title: "Example",
    url: "https://example.com/a",
    snippet: "Example snippet",
  }];

  const response = responseFor(results, "guide", false);
  assert.equal(response.status, 200);
  return response.json().then((message) => {
    assert.equal(message.content[0].type, "server_tool_use");
    assert.deepEqual(message.content[0].input, { query: "guide" });
    assert.deepEqual(message.content[1].content[0], {
      type: "web_search_result",
      title: "Example",
      url: "https://example.com/a",
      encrypted_content: "",
    });
    assert.equal(message.content[2].text, "1. Example\nExample snippet\nhttps://example.com/a");
  });
});

test("streaming responses use SSE event and data framing", async () => {
  const response = responseFor([{
    title: "Example",
    url: "https://example.com/a",
    snippet: "Example snippet",
  }], "guide", true);

  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const raw = await response.text();
  const frames = raw.trim().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    assert.match(lines[0], /^event: [a-z_]+$/);
    assert.match(lines[1], /^data: \{/);
    return JSON.parse(lines[1].slice("data: ".length));
  });

  assert.deepEqual(frames.map((frame) => frame.type), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(frames[1].content_block.type, "server_tool_use");
  assert.equal(frames[6].content_block.type, "text");
  assert.equal(frames[7].delta.text, "1. Example\nExample snippet\nhttps://example.com/a");
});
