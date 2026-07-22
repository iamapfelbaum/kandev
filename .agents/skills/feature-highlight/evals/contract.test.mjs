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
const mediaReadme = readOrEmpty(
  path.join(repoRoot, "docs/public/media/highlights/README.md"),
);
const evals = readOrEmpty(path.join(evalDir, "evals.json"));

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
    assert.match(skill, new RegExp(`node scripts/highlights\\.mjs ${command}\\b`));
  }
  assert.match(
    bundle,
    /run[\s\S]{0,240}validat(?:e|es)[\s\S]{0,80}storyboard[\s\S]{0,80}captur[\s\S]{0,80}render[\s\S]{0,80}QA[\s\S]{0,100}(?:content-addressed|manifest digest)/i,
  );
  assert.match(bundle, /storyboard[\s\S]{0,160}before[\s\S]{0,80}(?:capture|record)/i);
});

test("documents checked-in schema v1 with semantic selectors and no arbitrary code", () => {
  assert.match(bundle, /scripts\/highlights\/scenario\.schema\.json/);
  assert.match(bundle, /scripts\/highlights\/examples\/quick-start\.scenario\.json/);
  assert.match(bundle, /schemaVersion[^\n]{0,40}1/);
  assert.match(bundle, /(?:testId|data-testid)[\s\S]{0,140}(?:role|accessible name)/i);
  assert.match(bundle, /exact[\s\S]{0,80}accessible name/i);
  assert.match(bundle, /(?:no|never|rejects?)[^\n]{0,100}(?:arbitrary|inline)[^\n]{0,100}(?:shell|JavaScript|JS)/i);
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
  assert.match(bundle, /1920x1200[^\n]{0,60}(?:DPR ?2|deviceScaleFactor[^\n]{0,10}2)/i);
  assert.match(bundle, /3840x2400[\s\S]{0,120}1920x1200[\s\S]{0,80}25 ?fps/i);
  assert.match(bundle, /430x932[^\n]{0,60}(?:DPR ?3|deviceScaleFactor[^\n]{0,10}3)/i);
  assert.match(bundle, /1290x2796[^\n]{0,80}25 ?fps/i);
  assert.match(bundle, /never[^\n]{0,100}(?:crop|cropping)[^\n]{0,100}desktop/i);
});

test("makes camera intent opt-in, bounded, settled, and cursor-independent", () => {
  assert.match(bundle, /(?:default|without camera directives?)[^\n]{0,100}(?:1x|identity|no zoom)/i);
  for (const directive of ["cameraFocus", "cameraZoom", "cameraHold", "cameraReturn"]) {
    assert.match(bundle, new RegExp(directive));
  }
  assert.match(bundle, /desktop[^\n]{0,100}(?:max(?:imum)? zoom|cap)[^\n]{0,30}1\.5x/i);
  assert.match(bundle, /mobile[^\n]{0,100}(?:max(?:imum)? zoom|cap)[^\n]{0,30}1\.18x/i);
  assert.match(bundle, /camera[^\n]{0,100}cursor[^\n]{0,100}independent/i);
  assert.match(bundle, /(?:opening|start)[^\n]{0,80}(?:ending|end)[^\n]{0,80}(?:400 ?ms|settle)/i);
  assert.match(bundle, /camera move[^\n]{0,100}(?:1\.2 seconds|1,?200 ?ms)/i);
  assert.match(bundle, /camera hold[^\n]{0,80}(?:240 ?ms|minimum)/i);
  assert.match(bundle, /safe margin[^\n]{0,100}glyph containment/i);
});

test("keeps raw and QA in recoverable content-addressed external staging", () => {
  assert.match(bundle, /content-addressed[^\n]{0,100}(?:stage|staging)/i);
  assert.match(bundle, /(?:outside (?:the )?repo|external)[^\n]{0,120}(?:raw|master)[^\n]{0,100}QA/i);
  assert.match(bundle, /scenario\.json/);
  assert.match(bundle, /provenance\.json/);
  assert.match(bundle, /only[^\n]{0,160}(?:WebM|MP4|WebP)[^\n]{0,160}(?:scenario|provenance)/i);
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
  assert.match(bundle, /opening[^\n]{0,80}(?:and|\/)[^\n]{0,40}(?:end|ending)[^\n]{0,80}settle/i);
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
  assert.match(bundle, /technical_pass[^\n]{0,100}(?:not|never)[^\n]{0,40}(?:approval|accepted|promot)/i);
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
  assert.match(bundle, /do not recapture[^\n]{0,120}(?:merely|only)[^\n]{0,80}migrat/i);
  assert.match(bundle, /reuse[^\n]{0,100}clean raw[^\n]{0,120}(?:framing|poster|pacing)/i);
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
