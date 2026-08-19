// UI bundle via Bun.build — fast enough to run at every server boot, so dist/ is
// never stale relative to the sources the server is actually serving.
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export async function buildUi(minify = false): Promise<void> {
  const res = await Bun.build({
    entrypoints: [join(ROOT, "ui/boot.ts")],
    outdir: join(ROOT, "dist"),
    target: "browser",
    format: "esm",
    minify,
    sourcemap: "linked",
  });
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    throw new Error("UI build failed");
  }
}
