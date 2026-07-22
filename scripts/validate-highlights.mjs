import path from "node:path";
import { HIGHLIGHTS_RELATIVE_DIR, validateHighlights } from "./highlights.mjs";

export { validateHighlights };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const repoRoot = process.cwd();
  validateHighlights({ repoRoot, highlightsDir: path.join(repoRoot, HIGHLIGHTS_RELATIVE_DIR) })
    .then((result) => console.log(`Validated ${result.count} Highlights (${result.activeCount} active, ${result.queuedCount} queued).`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
