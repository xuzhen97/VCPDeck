import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { copyInstallerAsset } from "./release-installer-assets.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("copyInstallerAsset", () => {
  it("将 CRLF 和孤立 CR 的 Shell 资产规范化为 LF", () => {
    const directory = mkdtempSync(join(tmpdir(), "vcpdeck-assets-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source.sh");
    const target = join(directory, "target.sh");
    writeFileSync(source, "#!/usr/bin/env bash\r\nset -euo pipefail\r\necho ok\r");

    copyInstallerAsset(source, target);

    assert.equal(
      readFileSync(target, "utf8"),
      "#!/usr/bin/env bash\nset -euo pipefail\necho ok\n",
    );
  });

  it("PowerShell 和 CJS 资产保持原始字节", () => {
    const directory = mkdtempSync(join(tmpdir(), "vcpdeck-assets-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source.ps1");
    const target = join(directory, "target.ps1");
    const bytes = Buffer.from([0x61, 0x0d, 0x0a, 0x62]);
    writeFileSync(source, bytes);

    copyInstallerAsset(source, target);

    assert.deepEqual(readFileSync(target), bytes);
  });
});
