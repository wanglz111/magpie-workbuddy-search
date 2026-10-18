import { createSource } from "./src/source.mjs";
import { readSearch, searchWeb, responseFor, readText, SearchError } from "./src/search.mjs";

const PROVIDER = "workbuddy-search";
const BASE_URL = "https://workbuddy-search.invalid/v1";

export const WorkBuddySearchPlugin = async (input) => {
  const source = await createSource(input);
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {
        name: "WorkBuddy Search",
        npm: "@ai-sdk/anthropic",
        api: BASE_URL,
        searches: true,
        models: {
          "web-search": {
            name: "WorkBuddy Web Search",
            tool_call: true,
            limit: { context: 16000, output: 8192 },
          },
        },
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [{
        type: "oauth",
        label: "Reuse existing WorkBuddy AI login",
        authorize: async () => ({
          method: "auto",
          instructions: "Linking the existing WorkBuddy AI login; no new key is needed.",
          callback: async () => {
            await source.auth();
            return { type: "success", key: "linked:workbuddy-ai" };
          },
        }),
      }],
      async loader() {
        return {
          baseURL: BASE_URL,
          async fetch(input, init = {}) {
            const request = new Request(input, init);
            try {
              if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages")
                throw new SearchError(400, "Only POST /v1/messages search requests are supported");
              const body = JSON.parse(await readText(request, 65536, 413));
              const search = readSearch(body);
              const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
              const result = await searchWeb(source.fetch, search, signal);
              return responseFor(result, search.query, body.stream === true);
            } catch (error) {
              if (request.signal.aborted) throw error;
              const status = error instanceof SearchError ? error.status
                : error instanceof SyntaxError ? 400 : error.name === "TimeoutError" ? 504 : 502;
              return Response.json({
                type: "error",
                error: { type: "api_error", message: error.message },
              }, { status });
            }
          },
        };
      },
    },
  };
};
