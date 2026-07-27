import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishImmutableJson(
  filePath,
  value,
  { beforePublish, collisionLabel = "immutable evidence" } = {},
) {
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let published = false;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforePublish?.(temporary);
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `refusing to overwrite ${collisionLabel}: ${destination}`,
          { cause: error },
        );
      }
      throw error;
    }
    published = true;
    await syncDirectory(directory);
    return destination;
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (published) await syncDirectory(directory);
  }
}
