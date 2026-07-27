import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(evalDir, "..");
const repoRoot = path.resolve(skillDir, "../../..");

function readOrEmpty(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

const skill = readOrEmpty(path.join(skillDir, "SKILL.md"));
const referencesDir = path.join(skillDir, "references");
const references = fs.existsSync(referencesDir)
  ? fs
      .readdirSync(referencesDir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => readOrEmpty(path.join(referencesDir, name)))
      .join("\n")
  : "";
const bundle = `${skill}\n${references}`;
const spec = readOrEmpty(path.join(repoRoot, "docs/specs/highlights/spec.md"));
const authoringSpec = readOrEmpty(
  path.join(repoRoot, "docs/specs/highlights/authoring.md"),
);
const mediaReadme = readOrEmpty(
  path.join(repoRoot, "docs/public/media/highlights/README.md"),
);
const productVideoCaptureSkill = readOrEmpty(
  path.join(repoRoot, ".agents/skills/product-video-capture/SKILL.md"),
);
const productDemoSeedingSkill = readOrEmpty(
  path.join(repoRoot, ".agents/skills/product-demo-seeding/SKILL.md"),
);
const docsBundle = `${spec}\n${authoringSpec}\n${mediaReadme}`;
const completeBundle = `${bundle}\n${docsBundle}`;
const evals = readOrEmpty(path.join(evalDir, "evals.json"));

test("documents the executable app-local pipeline eval command everywhere", () => {
  const command = "pnpm --dir apps/web e2e:highlight-pipeline";
  const sources = {
    spec,
    authoringSpec,
    mediaReadme,
    productVideoCaptureSkill,
    productDemoSeedingSkill,
    evals,
  };
  assert.equal(
    fs.existsSync(path.join(repoRoot, "package.json")),
    false,
    "repository root intentionally has no package.json",
  );
  for (const [label, source] of Object.entries(sources)) {
    assert.match(source, new RegExp(command.replaceAll("/", "\\/")), label);
    assert.doesNotMatch(
      source,
      /forthcoming[^\n]{0,120}(?:highlight-pipeline|fresh-agent|integration|eval)/i,
      label,
    );
  }
});

test("separates the immutable quick-start template from customizable scaffolds", () => {
  assert.match(
    completeBundle,
    /scaffold \.\/quick-start\.scenario\.json --template quick-start/,
  );
  assert.match(
    completeBundle,
    /quick-start[^\n]{0,120}canonical[^\n]{0,160}(?:cannot|does not)[^\n]{0,100}(?:--id|identity)/i,
  );
  for (const override of ["--id", "--title", "--profile"]) {
    assert.match(
      completeBundle,
      new RegExp(
        `--template quick-start[^\\n]{0,240}${override.replace("-", "\\-")}[^\\n]{0,80}(?:reject|not accepted|cannot override)`,
        "i",
      ),
    );
  }
  assert.match(
    completeBundle,
    /scaffold \.\/my-highlight\.scenario\.json --id my-highlight --title [^\n]+ --profile desktop/,
  );
});

test("documents the closed runtime, source proof, landing root, and run identity", () => {
  assert.match(
    completeBundle,
    /default[^\n]{0,100}(?:closed|only)[^\n]{0,100}kandev-isolated-e2e/i,
  );
  assert.match(
    completeBundle,
    /run \.\/my-highlight\.scenario\.json[^\n]+--runtime kandev-isolated-e2e/,
  );
  assert.match(completeBundle, /--source pr_head[\s\S]{0,500}--pr-number/);
  assert.match(completeBundle, /--pr-base-sha <40-char-sha>/);
  assert.match(
    completeBundle,
    /pr_head[^\n]{0,160}(?:checked-out HEAD|selected head SHA)[^\n]{0,160}(?:same|equal|bind|match)/i,
  );
  assert.match(
    completeBundle,
    /current_main[^\n]{0,160}(?:freshly fetched )?origin\/main/i,
  );
  assert.match(completeBundle, /--landing-root <landing-repo>/);
  assert.match(
    completeBundle,
    /(?:new|unique|automatic)[^\n]{0,100}run ID[^\n]{0,160}--run-id/i,
  );
});

test("documents zero-write planning and the exact recoverable external tree", () => {
  assert.match(
    completeBundle,
    /--dry-run[^\n]{0,160}(?:zero writes|writes nothing|does not create)/i,
  );
  for (const pathPart of [
    "runtime-builds/<run-id>",
    "runtime-host/<run-id>",
    "<id>/runs/<run-id>/evidence",
    "<id>/runs/<run-id>/capture",
    "<id>/runs/<run-id>/render",
    "<id>/runs/<run-id>/qa",
    "<id>/stages/<manifest-digest>/review.json",
  ]) {
    assert.match(
      completeBundle,
      new RegExp(pathPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(
    completeBundle,
    /content-addressed[^\n]{0,120}<id>\/stages\/<manifest-digest>\/review\.json/i,
  );
});

test("documents resumable phase recovery without overwriting an attempt", () => {
  for (const phase of ["render", "qa", "stage"]) {
    assert.match(
      completeBundle,
      new RegExp(
        `highlights\\.mjs ${phase} \\.\\/my-highlight\\.scenario\\.json[^\\n]+--run-id <run-id>`,
      ),
    );
  }
  assert.match(completeBundle, /multiple[^\n]{0,80}runs[^\n]{0,120}--run-id/i);
  assert.match(
    completeBundle,
    /failed (?:run|attempt)[^\n]{0,160}(?:preserve|recover|diagnos)/i,
  );
  assert.match(
    completeBundle,
    /(?:capture retry|retry capture)[^\n]{0,160}(?:new|fresh)[^\n]{0,60}run ID/i,
  );
});

test("documents review-stage-v2-only CLI promotion and immutable acceptance", () => {
  assert.match(completeBundle, /kandev-highlight-review-stage-v2/);
  assert.match(
    completeBundle,
    /(?:normal|public|CLI) promote[^\n]{0,140}(?:only accepts|requires)[^\n]{0,100}review-stage-v2/i,
  );
  assert.match(
    completeBundle,
    /legacy[^\n]{0,120}(?:no|not|never)[^\n]{0,100}(?:CLI|promot)/i,
  );
  assert.match(
    completeBundle,
    /technical_pass[^\n]{0,100}(?:never|not)[^\n]{0,80}promotable/i,
  );
});

test("states truthful sensitive-scan coverage and external evidence boundaries", () => {
  for (const [surface, value] of [
    ["metadata", "true"],
    ["visibleDomText", "true"],
    ["browserConsole", "true"],
    ["runtimeLogs", "false"],
    ["renderedPixelOcr", "false"],
  ]) {
    assert.match(
      completeBundle,
      new RegExp(`${surface}[^\\n]{0,40}${value}`, "i"),
    );
  }
  assert.match(
    completeBundle,
    /(?:raw )?(?:DOM|visible DOM)[^\n]{0,120}(?:console|logs)[^\n]{0,140}(?:outside|external)/i,
  );
  assert.match(
    completeBundle,
    /(?:OCR|renderedPixelOcr)[^\n]{0,100}(?:false|not covered|not performed)/i,
  );
  assert.match(
    completeBundle,
    /human review[^\n]{0,120}(?:required|mandatory)/i,
  );
  assert.match(
    completeBundle,
    /compact provenance[^\n]{0,140}(?:digest|coverage|result)/i,
  );
});

test("covers operational failures and the canonical executable evaluation", () => {
  for (const failure of [
    "origin mismatch",
    "popup",
    "build mismatch",
    "source mismatch",
    "lock",
    "host failure",
    "capture retry",
    "run selection",
    "stage tamper",
    "scan finding",
    "mobile mismatch",
  ]) {
    assert.match(completeBundle, new RegExp(failure, "i"));
  }
  assert.match(
    completeBundle,
    /pnpm --dir apps\/web e2e:highlight-pipeline/,
  );
  assert.match(
    completeBundle,
    /e2e:highlight-capture[^\n]{0,120}(?:lower-level|fixture|runtime contract test)/i,
  );
  assert.match(completeBundle, /scripts\/highlights\/runtime-catalog\.mjs/);
});

test("routes a fresh agent through the complete declarative CLI", () => {
  for (const command of [
    "scaffold",
    "validate",
    "storyboard",
    "capture",
    "render",
    "qa",
    "run",
    "promote",
  ]) {
    assert.match(
      skill,
      new RegExp(`node scripts/highlights\\.mjs ${command}\\b`),
    );
  }
  assert.match(
    bundle,
    /run[\s\S]{0,240}validat(?:e|es)[\s\S]{0,80}storyboard[\s\S]{0,80}captur[\s\S]{0,80}render[\s\S]{0,80}QA[\s\S]{0,100}(?:content-addressed|manifest digest)/i,
  );
  assert.match(
    bundle,
    /storyboard[\s\S]{0,160}before[\s\S]{0,80}(?:capture|record)/i,
  );
});

test("documents checked-in schema v1 with semantic selectors and no arbitrary code", () => {
  assert.match(bundle, /scripts\/highlights\/scenario\.schema\.json/);
  assert.match(
    bundle,
    /scripts\/highlights\/examples\/quick-start\.scenario\.json/,
  );
  assert.match(bundle, /schemaVersion[^\n]{0,40}1/);
  assert.match(
    bundle,
    /(?:testId|data-testid)[\s\S]{0,140}(?:role|accessible name)/i,
  );
  assert.match(bundle, /exact[\s\S]{0,80}accessible name/i);
  assert.match(
    bundle,
    /(?:no|never|rejects?)[^\n]{0,100}(?:arbitrary|inline)[^\n]{0,100}(?:shell|JavaScript|JS)/i,
  );
  assert.match(bundle, /(?:setup|extension) primitives?[^\n]{0,120}allowlist/i);
});

test("defines deterministic seed, setup, digest, and source gates", () => {
  assert.match(bundle, /seed\.recipe|seed recipe/i);
  assert.match(bundle, /setup\.primitives|setup primitives/i);
  assert.match(bundle, /deterministic[^\n]{0,100}(?:seed|baseline)/i);
  assert.match(bundle, /scenario digest/i);
  assert.match(bundle, /capture digest/i);
  assert.match(bundle, /source (?:gate|digest|SHA)/i);
  assert.match(bundle, /origin\/main/i);
});

test("defines exact desktop and native-mobile profiles without cropping", () => {
  assert.match(
    bundle,
    /1920x1200[^\n]{0,60}(?:DPR ?2|deviceScaleFactor[^\n]{0,10}2)/i,
  );
  assert.match(bundle, /3840x2400[\s\S]{0,120}1920x1200[\s\S]{0,80}25 ?fps/i);
  assert.match(
    bundle,
    /430x932[^\n]{0,60}(?:DPR ?3|deviceScaleFactor[^\n]{0,10}3)/i,
  );
  assert.match(bundle, /1290x2796[^\n]{0,80}25 ?fps/i);
  assert.match(
    bundle,
    /never[^\n]{0,100}(?:crop|cropping)[^\n]{0,100}desktop/i,
  );
});

test("makes camera intent opt-in, bounded, settled, and cursor-independent", () => {
  assert.match(
    bundle,
    /(?:default|without camera directives?)[^\n]{0,100}(?:1x|identity|no zoom)/i,
  );
  for (const directive of [
    "cameraFocus",
    "cameraZoom",
    "cameraHold",
    "cameraReturn",
  ]) {
    assert.match(bundle, new RegExp(directive));
  }
  assert.match(
    bundle,
    /desktop[^\n]{0,100}(?:max(?:imum)? zoom|cap)[^\n]{0,30}1\.5x/i,
  );
  assert.match(
    bundle,
    /mobile[^\n]{0,100}(?:max(?:imum)? zoom|cap)[^\n]{0,30}1\.18x/i,
  );
  assert.match(bundle, /camera[^\n]{0,100}cursor[^\n]{0,100}independent/i);
  assert.match(
    bundle,
    /(?:opening|start)[^\n]{0,80}(?:ending|end)[^\n]{0,80}(?:400 ?ms|settle)/i,
  );
  assert.match(bundle, /camera move[^\n]{0,100}(?:1\.2 seconds|1,?200 ?ms)/i);
  assert.match(bundle, /camera hold[^\n]{0,80}(?:240 ?ms|minimum)/i);
  assert.match(bundle, /safe margin[^\n]{0,100}glyph containment/i);
});

test("keeps raw and QA in recoverable content-addressed external staging", () => {
  assert.match(bundle, /content-addressed[^\n]{0,100}(?:stage|staging)/i);
  assert.match(
    bundle,
    /(?:outside (?:the )?repo|external)[^\n]{0,120}(?:raw|master)[^\n]{0,100}QA/i,
  );
  assert.match(bundle, /scenario\.json/);
  assert.match(bundle, /provenance\.json/);
  assert.match(
    bundle,
    /only[^\n]{0,160}(?:WebM|MP4|WebP)[^\n]{0,160}(?:scenario|provenance)/i,
  );
});

test("requires automatic media, motion, safety, and browser QA", () => {
  for (const token of [
    "schema",
    "selector",
    "duration",
    "FPS",
    "dimensions",
    "audio",
    "codec",
    "faststart",
    "pointer",
    "camera jerk",
    "zoom-rate",
    "sensitive-data",
    "contact sheet",
    "browser playback",
    "SHA-256",
    "bytes",
  ]) {
    assert.match(bundle, new RegExp(token, "i"));
  }
  assert.match(
    bundle,
    /opening[^\n]{0,80}(?:and|\/)[^\n]{0,40}(?:end|ending)[^\n]{0,80}settle/i,
  );
});

test("keeps promotion explicit, immutable, and collision refusing", () => {
  assert.match(bundle, /promotion[^\n]{0,120}separate/i);
  assert.match(bundle, /technical(?:ly)?[^\n]{0,40}(?:pass|QA)/i);
  assert.match(bundle, /explicit[^\n]{0,80}(?:acceptance|reviewer)/i);
  assert.match(bundle, /immutable revision/i);
  assert.match(bundle, /(?:refuse|reject)[^\n]{0,100}(?:overwrite|collision)/i);
  assert.match(bundle, /promote[^\n]{0,100}--dry-run/i);
});

test("documents technical review acceptance and exact native-mobile pairing", () => {
  assert.match(bundle, /review\.json/);
  assert.match(
    bundle,
    /technical_pass[^\n]{0,100}(?:not|never)[^\n]{0,40}(?:approval|accepted|promot)/i,
  );
  assert.match(bundle, /--accept-reviewed-by/);
  assert.match(bundle, /mobileRequired/);
  assert.match(bundle, /--mobile-review/);
  assert.match(bundle, /scenario\.mobile\.json/);
});

test("maps bespoke capture archaeology into shared scenario and landing contracts", () => {
  for (const oldArtifact of [
    "hand-written Playwright",
    "camera JSON",
    "encoder scripts",
    "contact sheets",
    "manual asset promotion",
  ]) {
    assert.match(bundle, new RegExp(oldArtifact, "i"));
  }
  assert.match(bundle, /scripts\/product-loop-highlight\.mjs/);
  assert.match(
    bundle,
    /do not recapture[^\n]{0,120}(?:merely|only)[^\n]{0,80}migrat/i,
  );
  assert.match(
    bundle,
    /reuse[^\n]{0,100}clean raw[^\n]{0,120}(?:framing|poster|pacing)/i,
  );
  assert.match(bundle, /source digest/i);
});

test("offers actionable troubleshooting and updates implementation status", () => {
  for (const failure of [
    "selector",
    "timing",
    "camera",
    "FFmpeg",
    "browser",
    "source gate",
  ]) {
    assert.match(bundle, new RegExp(failure, "i"));
  }
  assert.doesNotMatch(
    spec,
    /does not implement[^\n]{0,160}(?:Playwright execution|camera rendering|ffmpeg QA)/i,
  );
  assert.match(spec, /declarative[^\n]{0,100}(?:capture|scenario)/i);
  assert.match(mediaReadme, /node scripts\/highlights\.mjs run/);
  assert.match(mediaReadme, /node scripts\/highlights\.mjs qa/);
});

test("includes a fresh-agent authoring and render evaluation", () => {
  assert.match(evals, /fresh agent/i);
  assert.match(evals, /scaffold/i);
  assert.match(evals, /storyboard/i);
  assert.match(evals, /render/i);
  assert.match(evals, /promot/i);
  assert.match(evals, /default no zoom|no zoom by default/i);
});

test("grades the fresh agent on the trusted runtime and review-v2 workflow", () => {
  assert.match(evals, /--template quick-start/);
  assert.match(
    evals,
    /canonical[^\n]{0,120}(?:cannot|does not)[^\n]{0,100}override/i,
  );
  assert.match(evals, /--runtime kandev-isolated-e2e/);
  assert.match(evals, /--source pr_head/);
  assert.match(evals, /--pr-number/);
  assert.match(evals, /--pr-base-sha/);
  assert.match(evals, /--run-id/);
  assert.match(evals, /kandev-highlight-review-stage-v2/);
  assert.match(evals, /runtimeLogs[^\n]{0,40}false/);
  assert.match(evals, /renderedPixelOcr[^\n]{0,40}false/);
  assert.match(evals, /pnpm --dir apps\/web e2e:highlight-pipeline/);
});
