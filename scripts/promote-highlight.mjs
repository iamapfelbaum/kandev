import path from "node:path";
import { promoteHighlight } from "./highlights.mjs";

export { promoteHighlight };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const highlightDir = process.argv[2];
  const sourceDigest = process.argv[3];
  if (!highlightDir) {
    console.error("usage: promote-highlight.mjs <highlight-directory> [source-digest]");
    process.exitCode = 1;
  } else {
    promoteHighlight({ highlightDir: path.resolve(highlightDir), sourceDigest })
      .then((descriptor) => console.log(JSON.stringify(descriptor, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
