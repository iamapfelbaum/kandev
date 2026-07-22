import path from "node:path";
import { buildPrSnippet, parseHighlightDescriptor } from "./highlights.mjs";

export { buildPrSnippet };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [highlightDir, headSha, owner = process.env.GITHUB_REPOSITORY?.split("/")[0], repo = process.env.GITHUB_REPOSITORY?.split("/")[1]] = process.argv.slice(2);
  if (!highlightDir || !headSha || !owner || !repo) {
    console.error("usage: highlight-pr-snippet.mjs <highlight-directory> <40-char-sha> [owner repo]");
    process.exitCode = 1;
  } else {
    parseHighlightDescriptor(path.join(path.resolve(highlightDir), "highlight.json"))
      .then((descriptor) => console.log(buildPrSnippet({ descriptor, owner, repo, headSha })))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
