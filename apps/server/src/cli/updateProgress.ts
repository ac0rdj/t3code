import type { PinnedRuntimeProgress } from "../cloud/pinnedRuntime.ts";

/** One download line on stderr; redirected output keeps only the phase changes. */
export function createUpdateProgress(
  output: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr,
) {
  const interactive = output.isTTY && process.env.TERM !== "dumb";
  let stage: PinnedRuntimeProgress["stage"] | undefined;
  let lastDraw = -Infinity;
  let lineOpen = false;
  const finish = () => {
    if (lineOpen) output.write("\n");
    lineOpen = false;
  };
  return {
    finish,
    report(progress: PinnedRuntimeProgress) {
      if (progress.stage !== stage) {
        finish();
        stage = progress.stage;
        const labels = {
          download: "[1/4] Downloading T3 Code...",
          verify: "[2/4] Verifying the download...",
          extract: "[3/4] Extracting T3 Code...",
          validate: "[4/4] Checking the new executable...",
          cached: "Checking the previously downloaded T3 Code...",
        };
        output.write(`${labels[stage]}\n`);
      }
      if (progress.stage !== "download" || !interactive) return;
      const now = performance.now();
      if (now - lastDraw < 100 && progress.received !== progress.total) return;
      lastDraw = now;
      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
      const { received, total } = progress;
      let line = `  ${mb(received)} MB downloaded`;
      if (total !== undefined) {
        const percent = Math.min(100, Math.floor((received / total) * 100));
        const filled = Math.floor(percent / 5);
        line = `  [${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${percent}%  ${mb(received)} / ${mb(total)} MB`;
      }
      // Leave the last column free so a narrow terminal never wraps the bar.
      output.write(`\r\x1b[2K${line.slice(0, Math.max(0, (output.columns || 80) - 1))}`);
      lineOpen = true;
    },
  };
}
