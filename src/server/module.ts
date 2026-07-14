import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import electronModule from "./electron/index";

const electronModuleExports = { ...electronModule, default: electronModule };

function resolveBetterSqlite3Override(): string | null {
  const vendorNodeModulesDir = process.env.CODEX_VENDOR_NODE_MODULES_DIR;
  if (vendorNodeModulesDir) {
    return path.join(vendorNodeModulesDir, "better-sqlite3");
  }

  const projectPackageJson = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(projectPackageJson)) {
    return null;
  }

  try {
    return createRequire(projectPackageJson).resolve("better-sqlite3");
  } catch {
    return null;
  }
}

export function installModuleAliasHook(): void {
  const moduleWithLoad = Module as typeof Module & {
    _load: (
      request: string,
      parent: NodeModule | undefined,
      isMain: boolean,
    ) => unknown;
  };
  const originalLoad = moduleWithLoad._load;

  moduleWithLoad._load = function moduleAliasLoad(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ): unknown {
    if (request === "electron") {
      return electronModuleExports;
    }

    if (request === "better-sqlite3") {
      const override = resolveBetterSqlite3Override();
      if (override) {
        return originalLoad.call(this, override, parent, isMain);
      }
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}
