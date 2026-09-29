import type { RunStorage } from "@exploratory-agent/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function fsStorage(runDir: string): RunStorage {
  return {
    async write(relativePath, data) {
      const file = path.join(runDir, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
    },
  };
}
