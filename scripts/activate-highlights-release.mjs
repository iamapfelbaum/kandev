import path from "node:path";
import { activateHighlightsForRelease, HIGHLIGHTS_RELATIVE_DIR } from "./highlights.mjs";

export { activateHighlightsForRelease };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const releaseVersion = process.argv[2];
  if (!releaseVersion) {
    console.error("usage: activate-highlights-release.mjs <release-version>");
    process.exitCode = 1;
  } else {
    activateHighlightsForRelease({
      highlightsDir: path.join(process.cwd(), HIGHLIGHTS_RELATIVE_DIR),
      releaseVersion,
    })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
