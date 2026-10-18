import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SearchError } from "./search.mjs";

export async function createSource(input) {
  const authPath = join(input.directory, "plugin-auth.json");
  const modulePath = join(input.directory, "plugins", "node_modules",
    "@magpie-community", "opencode-workbuddy-auth", "index.mjs");
  const { WorkBuddyAIAuthPlugin } = await import(pathToFileURL(modulePath).href);
  const upstream = await WorkBuddyAIAuthPlugin(input);
  const auth = async () => {
    const saved = JSON.parse(await readFile(authPath, "utf8"))["workbuddy-ai"];
    if (saved?.type !== "oauth" || !(saved.access || saved.source === "desktop"))
      throw new SearchError(401, "Sign in to workbuddy-ai in Magpie before using WorkBuddy Search");
    return saved;
  };
  return {
    auth,
    async fetch(url, init) {
      await auth();
      // Delegate signing and token renewal to the installed WorkBuddy plugin.
      // Its auth.set writes refreshed tokens back to the original login.
      const loader = await upstream.auth.loader(auth);
      return loader.fetch(url, init);
    },
  };
}
