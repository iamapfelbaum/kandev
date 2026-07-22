import path from "node:path";
import { withdrawHighlight } from "./highlights.mjs";

export { withdrawHighlight };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [highlightDir, ...reasonParts] = process.argv.slice(2);
  const reason = reasonParts.join(" ");
  if (!highlightDir || !reason) {
    console.error("usage: withdraw-highlight.mjs <highlight-directory> <reason>");
    process.exitCode = 1;
  } else {
    withdrawHighlight({ highlightDir: path.resolve(highlightDir), reason })
      .then((descriptor) => console.log(JSON.stringify(descriptor, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
