import { execSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const extensionRoot = join(__dirname, "..", "extension");
const extDist = join(__dirname, "dist-extension");

export default function globalSetup(): void {
  execSync("pnpm build", { cwd: extensionRoot, stdio: "inherit" });
  rmSync(extDist, { recursive: true, force: true });
  cpSync(join(extensionRoot, "dist"), extDist, { recursive: true });
  // The tests grant tabs through explicit runtime messages rather than a real
  // toolbar click, so activeTab never fires; give the test build the host
  // permission that user gesture would otherwise provide.
  const manifestPath = join(extDist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  manifest["host_permissions"] = ["http://127.0.0.1/*"];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
