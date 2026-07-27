import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as evidence from "./immutable-evidence.mjs";

test("immutable JSON publication never exposes a partial final file", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-immutable-evidence-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "evidence", "capture.json");
  await assert.rejects(
    evidence.publishImmutableJson(
      destination,
      { complete: true },
      {
        beforePublish: async (temporary) => {
          assert.deepEqual(JSON.parse(await fs.readFile(temporary, "utf8")), {
            complete: true,
          });
          throw new Error("hard-stop-equivalent");
        },
      },
    ),
    /hard-stop-equivalent/,
  );
  await assert.rejects(fs.access(destination), /ENOENT/);
  assert.deepEqual(await fs.readdir(path.dirname(destination)), []);

  await evidence.publishImmutableJson(destination, { complete: true });
  assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), {
    complete: true,
  });
  await assert.rejects(
    evidence.publishImmutableJson(destination, { replacement: true }),
    /refusing to overwrite immutable evidence/i,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(destination, "utf8")), {
    complete: true,
  });
});
