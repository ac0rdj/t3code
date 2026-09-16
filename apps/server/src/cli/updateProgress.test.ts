import { afterEach, expect, it, vi } from "vite-plus/test";

import { createUpdateProgress } from "./updateProgress.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function terminal(isTTY = true, columns = 80) {
  vi.stubEnv("TERM", "xterm");
  let text = "";
  const progress = createUpdateProgress({
    isTTY,
    columns,
    write(chunk: string | Uint8Array) {
      text += chunk;
      return true;
    },
  });
  return { ...progress, text: () => text };
}

it("keeps redirected output readable without per-chunk updates or escapes", () => {
  const output = terminal(false);
  for (let received = 0; received <= 100; received++) {
    output.report({ stage: "download", received, total: 100 });
  }
  output.report({ stage: "verify" });
  output.report({ stage: "extract" });
  output.report({ stage: "validate" });
  output.finish();
  expect(output.text()).toBe(
    "[1/4] Downloading T3 Code...\n[2/4] Verifying the download...\n[3/4] Extracting T3 Code...\n[4/4] Checking the new executable...\n",
  );
});

it("throttles redraws, shows the final byte count, and closes the line once", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const output = terminal();
  output.report({ stage: "download", received: 0, total: 1024 ** 2 });
  for (let received = 1; received < 100; received++) {
    output.report({ stage: "download", received, total: 1024 ** 2 });
  }
  expect(output.text().match(/\r/g)).toHaveLength(1);
  now.mockReturnValue(100);
  output.report({ stage: "download", received: 524288, total: 1024 ** 2 });
  output.report({ stage: "download", received: 1024 ** 2, total: 1024 ** 2 });
  output.finish();
  output.finish();
  expect(output.text().match(/\r/g)).toHaveLength(3);
  expect(output.text()).toContain("50%  0.5 / 1.0 MB");
  expect(output.text()).toMatch(/100%  1.0 \/ 1.0 MB\n$/);
});

it("shows bytes for an unknown size and leaves a clean line on interruption", () => {
  const output = terminal();
  output.report({ stage: "download", received: 524288, total: undefined });
  output.finish();
  expect(output.text()).toMatch(/0.5 MB downloaded\n$/);
  expect(output.text()).not.toContain("%");
});

it("fits a narrow terminal without wrapping", () => {
  const output = terminal(true, 30);
  output.report({ stage: "download", received: 50, total: 100 });
  const line = output.text().split("\x1b[2K").at(-1)!;
  expect(line.length).toBeLessThan(30);
});
