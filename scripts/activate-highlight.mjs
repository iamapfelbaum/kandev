import path from "node:path";
import { activateHighlight } from "./highlights.mjs";

export { activateHighlight };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [highlightDir, releaseVersion] = process.argv.slice(2);
  if (!highlightDir || !releaseVersion) {
    console.error("usage: activate-highlight.mjs <highlight-directory> <release-version>");
    process.exitCode = 1;
  } else {
    activateHighlight({ highlightDir: path.resolve(highlightDir), releaseVersion })
      .then((descriptor) => console.log(JSON.stringify(descriptor, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
