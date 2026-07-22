import path from "node:path";
import { computeSourceDigest } from "./highlights.mjs";

export { computeSourceDigest };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const highlightDir = process.argv[2];
  if (!highlightDir) {
    console.error("usage: highlight-source-digest.mjs <highlight-directory>");
    process.exitCode = 1;
  } else {
    computeSourceDigest(path.resolve(highlightDir))
      .then(console.log)
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
