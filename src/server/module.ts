import Module from "node:module";
import electronModule from "./electron/index";

const electronModuleExports = { ...electronModule, default: electronModule };

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

    return originalLoad.call(this, request, parent, isMain);
  };
}
