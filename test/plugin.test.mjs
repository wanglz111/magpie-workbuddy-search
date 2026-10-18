import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkBuddySearchPlugin } from "../index.mjs";

const AUTH_MODULE = `
export const WorkBuddyAIAuthPlugin = async (input) => ({
  auth: {
    async loader(auth) {
      return {
        async fetch(url, init = {}) {
          const saved = await auth();
          input.calls.push({
            access: saved.access,
            url,
            headers: Object.fromEntries(new Headers(init.headers)),
          });
          return new Response(JSON.stringify({
            code: 0,
            results: [{
              title: "Example result",
              url: "https://example.com/guide",
              snippet: "A useful snippet.",
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      };
    },
  },
});
`;

function request(overrides = {}) {
  return new Request("https://workbuddy-search.invalid/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "web-search",
      stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "find the guide" }],
      ...overrides,
    }),
  });
}

async function createPlugin(t, auth = { type: "oauth", access: "token-one" }) {
  const directory = await mkdtemp(join(tmpdir(), "magpie-workbuddy-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleDirectory = join(directory, "plugins", "node_modules",
    "@magpie-community", "opencode-workbuddy-auth");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(moduleDirectory, "index.mjs"), AUTH_MODULE);
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({ "workbuddy-ai": auth }));

  const calls = [];
  const input = { directory, calls };
  const hooks = await WorkBuddySearchPlugin(input);
  const provider = await hooks.auth.loader();
  return { directory, calls, hooks, provider, input };
}

test("auth loader reads the current source token on every request", async (t) => {
  const { directory, calls, provider } = await createPlugin(t);

  const first = await provider.fetch(request());
  assert.equal(first.status, 200);
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({
    "workbuddy-ai": { type: "oauth", access: "token-two" },
  }));
  const second = await provider.fetch(request());
  assert.equal(second.status, 200);

  assert.deepEqual(calls.map((call) => call.access), ["token-one", "token-two"]);
  assert.equal(calls[0].url, "https://www.workbuddy.ai/agenttool/v1/search");
  assert.equal(calls[0].headers["x-request-id"].length, 32);
});

test("linking delegates to the original provider without copying its token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-workbuddy-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleDirectory = join(directory, "plugins", "node_modules",
    "@magpie-community", "opencode-workbuddy-auth");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(moduleDirectory, "index.mjs"), `
export const WorkBuddyAIAuthPlugin = async (input) => {
  input.calls.push({ authSet: input.client.auth.set });
  return {
    auth: {
      loader: async (auth) => ({
        fetch: async () => {
          const saved = await auth();
          await input.client.auth.set({
            path: { id: "workbuddy-ai" },
            body: { ...saved, access: "refreshed-source-token" },
          });
          return new Response(JSON.stringify({
            code: 0,
            results: [{
              title: "Example result",
              url: "https://example.com/guide",
              snippet: "A useful snippet.",
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      }),
    },
  };
};
`);
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({
    "workbuddy-ai": { type: "oauth", access: "source-token" },
  }));
  const calls = [];
  const authSet = async ({ path, body }) => {
    calls.push({ path, body });
    const saved = JSON.parse(await readFile(join(directory, "plugin-auth.json"), "utf8"));
    saved[path.id] = body;
    await writeFile(join(directory, "plugin-auth.json"), JSON.stringify(saved));
  };
  const input = { directory, calls, client: { auth: { set: authSet } } };
  const hooks = await WorkBuddySearchPlugin(input);

  const authorization = await hooks.auth.methods[0].authorize();
  assert.deepEqual(await authorization.callback(), {
    type: "success",
    key: "linked:workbuddy-ai",
  });
  assert.equal(calls[0].authSet, authSet);

  const provider = await hooks.auth.loader();
  assert.equal((await provider.fetch(request())).status, 200);
  assert.deepEqual(calls[1].path, { id: "workbuddy-ai" });
  assert.equal(calls[1].body.access, "refreshed-source-token");

  const saved = JSON.parse(await readFile(join(directory, "plugin-auth.json"), "utf8"));
  assert.equal(saved["workbuddy-ai"].access, "refreshed-source-token");
  assert.equal(Object.hasOwn(saved, "workbuddy-search"), false);
});

test("missing original login rejects before the upstream search", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-workbuddy-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleDirectory = join(directory, "plugins", "node_modules",
    "@magpie-community", "opencode-workbuddy-auth");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(moduleDirectory, "index.mjs"), `
export const WorkBuddyAIAuthPlugin = async (input) => ({
  auth: {
    loader: async () => ({
      fetch: async () => {
        input.calls.push("upstream called");
        return new Response("{}", { status: 200 });
      },
    }),
  },
});
`);
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({}));
  const calls = [];
  const hooks = await WorkBuddySearchPlugin({ directory, calls });
  const provider = await hooks.auth.loader();

  const response = await provider.fetch(request());
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
  assert.match((await response.json()).error.message, /Sign in to workbuddy-ai/);
});

test("invalid input is rejected before the upstream is called", async (t) => {
  const { provider, calls } = await createPlugin(t);
  const cases = [
    ["unsupported model", { model: "other" }, 400],
    ["missing tool", { tools: [] }, 400],
    ["unsafe tool option", {
      tools: [{ type: "web_search_20250305", name: "web_search", extra: true }],
    }, 400],
    ["empty query", { messages: [{ role: "user", content: "  " }] }, 400],
  ];

  for (const [name, overrides, status] of cases) {
    const response = await provider.fetch(request(overrides));
    assert.equal(response.status, status, name);
    assert.equal((await response.json()).type, "error", name);
  }
  assert.deepEqual(calls, []);
});

test("upstream refusals and malformed replies become error responses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-workbuddy-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleDirectory = join(directory, "plugins", "node_modules",
    "@magpie-community", "opencode-workbuddy-auth");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(moduleDirectory, "index.mjs"), `
export const WorkBuddyAIAuthPlugin = async (input) => ({
  auth: {
    loader: async (auth) => ({
      fetch: async () => {
        const saved = await auth();
        const response = input.responses.shift();
        return new Response(response.body, { status: response.status });
      },
    }),
  },
});
`);
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({
    "workbuddy-ai": { type: "oauth", access: "source-token" },
  }));
  const responses = [
    { status: 500, body: JSON.stringify({ code: 0, results: [OK_RESULT] }) },
    { status: 200, body: JSON.stringify({ code: 15001, results: [OK_RESULT] }) },
    { status: 200, body: JSON.stringify({ code: 0, results: [{ title: "bad" }] }) },
  ];
  const input = { directory, responses };
  const hooks = await WorkBuddySearchPlugin(input);
  const provider = await hooks.auth.loader();

  const statuses = [];
  for (const expectedStatus of [502, 429, 502]) {
    const response = await provider.fetch(request());
    statuses.push(response.status);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).type, "error");
  }
  assert.deepEqual(statuses, [502, 429, 502]);
});

const OK_RESULT = {
  title: "Example result",
  url: "https://example.com/guide",
  snippet: "A useful snippet.",
};
