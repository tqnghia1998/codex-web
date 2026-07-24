import {
  dispatchNavigateToRoute,
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleBrowserRuntimeMessage,
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
  uploadFiles,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

declare global {
  interface Window {
    chrome?: {
      runtime?: {
        sendMessage?: (message: unknown) => Promise<unknown>;
      };
    };
  }
}

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      clientId: string;
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      clientId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      clientId: string;
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

const RECONNECT_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UI_STATE_STORAGE_KEY_PREFIX = "codex-web:ui-state:v2:";
const UI_STATE_LEGACY_STORAGE_KEY = "codex-web:ui-state:v1";
const UI_STATE_RESTORE_TIMEOUT_MS = 5_000;
const UI_STATE_RESTORE_POLL_MS = 100;
const clientId = crypto.randomUUID();

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronFileAttachments = {
  persistImageFileToTemp?: (file: File) => Promise<string | null>;
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  folderFilterProjectId?: string;
  closeSidebar?: () => void;
  services?: {
    appInfo?: {
      get: () => Promise<ElectronAppInfo>;
    };
    workspaceFiles?: ElectronWorkspaceFiles;
    fileAttachments?: ElectronFileAttachments;
    requestUserInputAutoResolution?: {
      recordConversationActivity?: (args: {
        conversationId: string;
        hostId: string;
      }) => void;
      setConversationPresented?: (args: {
        conversationId: string;
        hostId: string;
        presented: boolean;
      }) => void;
      snooze?: (args: {
        conversationId: string;
        hostId: string;
        requestId: string;
      }) => void;
    };
  };
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

type ReviewDiffLayout = "split" | "unified";

type ReviewSourceKind = "Unstaged" | "Staged" | "Commit" | "Branch" | "Last Turn";

type PersistedReviewState = {
  sourceKind: ReviewSourceKind | null;
  refLabel: string | null;
  fileAbsolutePath: string | null;
  fileTreePath: string | null;
  fileExpanded: boolean | null;
  fileFilterQuery: string | null;
  fileTreeScrollTop: number | null;
  filesVisible: boolean;
  diffLayout: ReviewDiffLayout | null;
  reviewScrollTop: number | null;
};

type PersistedUiState = {
  pageKey: string;
  sidebarOpen: boolean;
  sidePanelActiveTab: string | null;
  sidePanelOpen: boolean;
  bottomPanelActiveTab: string | null;
  bottomPanelOpen: boolean;
  review: PersistedReviewState | null;
};

const REVIEW_DIFF_LAYOUT_LABELS: Record<ReviewDiffLayout, string> = {
  split: "Switch to unified diff",
  unified: "Switch to split diff",
};
const uiStateScrollTargets = new WeakSet<EventTarget>();

let requestCounter = 0;
let persistUiStateTimeoutId: number | null = null;
let lastPersistedUiStateJson: string | null = null;
let uiStateRestoreInProgress = false;
let reviewDefaultSourceAttemptedPageKey: string | null = null;
let reviewDefaultSourceInFlightPageKey: string | null = null;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
    timeoutId: number;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function timeoutError(kind: string): Error {
  return new Error(`[electron-stub] timed out waiting for ${kind}`);
}


function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    window.clearTimeout(pending.timeoutId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket.addEventListener("open", () => {
    flushOutboundQueue();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  socket.addEventListener("close", () => {
    for (const port of messagePorts.values()) {
      port.close();
    }
    messagePorts.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (!pendingInvokes.delete(requestId)) {
        return;
      }
      reject(timeoutError(`ipc invoke response for ${channel}`));
    }, REQUEST_TIMEOUT_MS);

    pendingInvokes.set(requestId, {
      resolve: (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (reason) => {
        window.clearTimeout(timeoutId);
        reject(reason);
      },
    });

    enqueueMessage({
      type: "ipc-renderer-invoke",
      clientId,
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

function updateBrowserPath(nextPath: string, action: "POP" | "PUSH" | "REPLACE"): void {
  const currentPath = `${window.location.pathname}${window.location.search}`;
  if (currentPath === nextPath) {
    window.history.replaceState(undefined, "", nextPath);
    return;
  }

  if (action === "REPLACE") {
    window.history.replaceState(undefined, "", nextPath);
    return;
  }

  window.history.pushState(undefined, "", nextPath);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type WebNotificationPayload = {
  body?: string;
  id?: string;
  kind: string;
  title: string;
};

async function showWebNotification(
  notification: WebNotificationPayload,
): Promise<void> {
  if (typeof Notification === "undefined") {
    console.warn("[codex-web] Web Notifications API unavailable");
    return;
  }

  try {
    const permission = Notification.permission;
    if (permission !== "granted") {
      console.warn("[codex-web] notification permission", permission);
      return;
    }

    const webNotification = new Notification(notification.title, {
      body: notification.body,
      tag: notification.id,
    });
    webNotification.onclick = () => {
      window.focus();
      webNotification.close();
    };
    console.log("[codex-web] notification shown", notification);
  } catch (error) {
    console.error("[codex-web] failed to show notification", error);
  }
}

function handleNotificationShowMessage(value: unknown): void {
  if (typeof value !== "string") {
    return;
  }

  try {
    const message = JSON.parse(value) as unknown;
    if (
      !Array.isArray(message) ||
      message[0] !== "push" ||
      !Array.isArray(message[1])
    ) {
      return;
    }

    const pipeline = message[1];
    const method = pipeline[2];
    const args = pipeline[3];
    const notification = Array.isArray(args) ? args[0] : null;
    if (
      pipeline[0] === "pipeline" &&
      Array.isArray(method) &&
      method[0] === "show" &&
      isRecord(notification) &&
      typeof notification.kind === "string" &&
      typeof notification.title === "string" &&
      (notification.body === undefined ||
        typeof notification.body === "string") &&
      (notification.id === undefined || typeof notification.id === "string")
    ) {
      void showWebNotification({
        body: notification.body,
        id: notification.id,
        kind: notification.kind,
        title: notification.title,
      });
    }
  } catch {
    // Ignore non-JSON MessagePort traffic.
  }
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function isElectronWindowFocusRequestMessage(value: unknown): value is {
  type: "electron-window-focus-request";
} {
  return isRecord(value) && value.type === "electron-window-focus-request";
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      if (!pendingDirectoryEntries.delete(requestId)) {
        return;
      }
      reject(timeoutError("workspace directory entries"));
    }, REQUEST_TIMEOUT_MS);

    pendingDirectoryEntries.set(requestId, { resolve, reject, timeoutId });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      clientId,
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

function getCurrentPageKey(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function getUiStateStorageKey(pageKey: string): string {
  return `${UI_STATE_STORAGE_KEY_PREFIX}${encodeURIComponent(pageKey)}`;
}

function isReviewSourceKind(value: string | null): value is ReviewSourceKind {
  switch (value) {
    case "Unstaged":
    case "Staged":
    case "Commit":
    case "Branch":
    case "Last Turn":
      return true;
    default:
      return false;
  }
}

function parsePersistedReviewState(value: unknown): PersistedReviewState | null {
  if (!isRecord(value) || typeof value.filesVisible !== "boolean") {
    return null;
  }

  const sourceKind =
    typeof value.sourceKind === "string" && isReviewSourceKind(value.sourceKind)
      ? value.sourceKind
      : null;
  const diffLayout =
    value.diffLayout === "split" || value.diffLayout === "unified"
      ? value.diffLayout
      : null;

  return {
    sourceKind,
    refLabel: typeof value.refLabel === "string" ? value.refLabel : null,
    fileAbsolutePath:
      typeof value.fileAbsolutePath === "string" ? value.fileAbsolutePath : null,
    fileTreePath: typeof value.fileTreePath === "string" ? value.fileTreePath : null,
    fileExpanded: typeof value.fileExpanded === "boolean" ? value.fileExpanded : null,
    fileFilterQuery:
      typeof value.fileFilterQuery === "string" ? value.fileFilterQuery : null,
    fileTreeScrollTop:
      typeof value.fileTreeScrollTop === "number" ? value.fileTreeScrollTop : null,
    filesVisible: value.filesVisible,
    diffLayout,
    reviewScrollTop: typeof value.reviewScrollTop === "number" ? value.reviewScrollTop : null,
  };
}

function parsePersistedUiState(raw: string | null): PersistedUiState | null {
  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.pageKey !== "string" ||
      typeof value.sidebarOpen !== "boolean" ||
      typeof value.sidePanelOpen !== "boolean" ||
      typeof value.bottomPanelOpen !== "boolean"
    ) {
      return null;
    }

    return {
      pageKey: value.pageKey,
      sidebarOpen: value.sidebarOpen,
      sidePanelActiveTab:
        typeof value.sidePanelActiveTab === "string" ? value.sidePanelActiveTab : null,
      sidePanelOpen: value.sidePanelOpen,
      bottomPanelActiveTab:
        typeof value.bottomPanelActiveTab === "string" ? value.bottomPanelActiveTab : null,
      bottomPanelOpen: value.bottomPanelOpen,
      review: parsePersistedReviewState(value.review),
    };
  } catch {
    return null;
  }
}

function getStoredUiStateItem(key: string): string | null {
  return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
}

function clearStoredUiStateItem(key: string): void {
  window.localStorage.removeItem(key);
  window.sessionStorage.removeItem(key);
}

function loadPersistedUiState(pageKey = getCurrentPageKey()): PersistedUiState | null {
  const storageKey = getUiStateStorageKey(pageKey);
  const localStateRaw = window.localStorage.getItem(storageKey);
  const persistedState = parsePersistedUiState(localStateRaw ?? window.sessionStorage.getItem(storageKey));
  if (persistedState) {
    if (localStateRaw === null) {
      savePersistedUiState(persistedState);
    }
    return persistedState;
  }

  const legacyState = parsePersistedUiState(getStoredUiStateItem(UI_STATE_LEGACY_STORAGE_KEY));
  if (legacyState?.pageKey !== pageKey) {
    return null;
  }

  savePersistedUiState(legacyState);
  return legacyState;
}

function savePersistedUiState(state: PersistedUiState, serializedState?: string): void {
  const nextSerializedState = serializedState ?? JSON.stringify(state);
  const storageKey = getUiStateStorageKey(state.pageKey);
  // Shared across tabs on purpose so the UI survives a full browser restart.
  window.localStorage.setItem(storageKey, nextSerializedState);
  clearStoredUiStateItem(UI_STATE_LEGACY_STORAGE_KEY);
  window.sessionStorage.removeItem(storageKey);
}

function hasStoredReviewSourcePreference(pageKey = getCurrentPageKey()): boolean {
  return loadPersistedUiState(pageKey)?.review?.sourceKind !== null;
}

function normalizeUiLabel(value: string | null | undefined): string | null {
  const normalized = value
    ?.replace(/\s*[⌘⌥⌃⇧].*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized : null;
}

function isVisibleElement<T extends Element>(element: T | null): element is T {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function getNormalizedElementLabel(element: Element | null): string | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  return normalizeUiLabel(
    element.getAttribute("aria-label") ?? element.textContent ?? element.title,
  );
}

function hasUiLabel(element: Element | null, label: string, exact = true): boolean {
  const actualLabel = getNormalizedElementLabel(element);
  const expectedLabel = normalizeUiLabel(label);
  if (!actualLabel || !expectedLabel) {
    return false;
  }

  return exact ? actualLabel === expectedLabel : actualLabel.includes(expectedLabel);
}

function getVisibleButtons(root: ParentNode = document): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter(isVisibleElement);
}

function findVisibleButton(
  label: string,
  root: ParentNode = document,
  exact = true,
): HTMLButtonElement | null {
  const buttons = getVisibleButtons(root);
  for (let index = buttons.length - 1; index >= 0; index -= 1) {
    const button = buttons[index];
    if (hasUiLabel(button, label, exact)) {
      return button;
    }
  }

  return null;
}

function findVisibleMenuItem(label: string, exact = true): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .filter(isVisibleElement)
      .find((item) => hasUiLabel(item, label, exact)) ?? null
  );
}

function getVisibleMenuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    isVisibleElement,
  );
}

function findVisibleTextControl(
  label: string,
  root: ParentNode = document,
): HTMLInputElement | HTMLTextAreaElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
      .filter(isVisibleElement)
      .find((element) => hasUiLabel(element, label)) ?? null
  );
}

function setTextControlValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function triggerUserClick(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }

  element.focus?.();
  const pointerEventCtor = window.PointerEvent ?? window.MouseEvent;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    element.dispatchEvent(
      new pointerEventCtor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      }),
    );
  }
  element.click();

  return true;
}

function getSidebarToggleButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-app-shell-sidebar-trigger]"))
    .filter(isVisibleElement)
    .at(-1) ?? null;
}

function isSidebarOpen(): boolean {
  const button = getSidebarToggleButton();
  if (!button) {
    return false;
  }

  return normalizeUiLabel(button.getAttribute("aria-label") ?? button.textContent) !== "Show sidebar";
}

function getPanelToggleButtons(panel: "right" | "bottom"): HTMLButtonElement[] {
  const label = panel === "right" ? "Toggle side panel" : "Toggle bottom panel";
  const normalizedLabel = normalizeUiLabel(label);
  if (!normalizedLabel) {
    return [];
  }

  return getVisibleButtons().filter((button) => {
    const buttonLabel = normalizeUiLabel(
      button.getAttribute("aria-label") ?? button.textContent ?? button.title,
    );
    return buttonLabel === normalizedLabel;
  });
}

function getPanelToggleButton(panel: "right" | "bottom"): HTMLButtonElement | null {
  const buttons = getPanelToggleButtons(panel);
  return (
    buttons.find((button) => button.getAttribute("aria-pressed") === "true") ??
    buttons.at(-1) ??
    null
  );
}

function isPanelOpen(panel: "right" | "bottom"): boolean {
  return getPanelToggleButtons(panel).some(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
}

function getPanelTabController(panel: "right" | "bottom"): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-app-shell-tab-controller="${panel}"]`);
}

function getActivePanelTab(panel: "right" | "bottom"): string | null {
  return normalizeUiLabel(
    getPanelTabController(panel)?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.textContent,
  );
}

function getReviewPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-app-shell-tab-panel-controller="right"][role="tabpanel"][aria-label="Review"]',
  );
}

function getReviewSourceButton(): HTMLButtonElement | null {
  const panel = getReviewPanel();
  if (!panel) {
    return null;
  }

  return (
    getVisibleButtons(panel).find((button) =>
      isReviewSourceKind(getNormalizedElementLabel(button)),
    ) ?? null
  );
}

function getReviewSourceKind(): ReviewSourceKind | null {
  const label = getNormalizedElementLabel(getReviewSourceButton());
  return isReviewSourceKind(label) ? label : null;
}

function getReviewCurrentFileContainer(): HTMLElement | null {
  return getReviewPanel()?.querySelector<HTMLElement>("[data-review-path]") ?? null;
}

function getReviewCurrentFileButton(): HTMLButtonElement | null {
  return getReviewCurrentFileContainer()?.querySelector<HTMLButtonElement>("button") ?? null;
}

function getReviewAbsoluteFilePath(): string | null {
  return getReviewCurrentFileContainer()?.getAttribute("data-review-path") ?? null;
}

function getReviewHeader(): HTMLElement | null {
  return getReviewPanel()?.querySelector<HTMLElement>("div.border-b") ?? null;
}

function getReviewHeaderPrimaryRow(): HTMLElement | null {
  return getReviewSourceButton()?.parentElement ?? null;
}

function getReviewRefButton(): HTMLButtonElement | null {
  const header = getReviewHeader();
  const sourceButton = getReviewSourceButton();
  if (!header || !sourceButton) {
    return null;
  }

  return (
    getVisibleButtons(header).find((button) => {
      const label = getNormalizedElementLabel(button);
      return (
        button !== sourceButton &&
        label !== null &&
        label !== "Create PR" &&
        button.getAttribute("aria-label") === null &&
        !isReviewSourceKind(label)
      );
    }) ?? null
  );
}

function getReviewCommitRefLabel(): string | null {
  if (getReviewSourceKind() !== "Commit") {
    return null;
  }

  const row = getReviewHeaderPrimaryRow();
  const sourceButton = getReviewSourceButton();
  if (!row || !sourceButton) {
    return null;
  }

  const rowLabel = normalizeUiLabel(row.textContent);
  const sourceLabel = getNormalizedElementLabel(sourceButton);
  if (rowLabel && sourceLabel && rowLabel.startsWith(sourceLabel)) {
    const commitLabel = normalizeUiLabel(rowLabel.slice(sourceLabel.length));
    if (commitLabel) {
      return commitLabel;
    }
  }

  const commitLabel = normalizeUiLabel(
    Array.from(row.querySelectorAll<HTMLElement>("span"))
      .filter(isVisibleElement)
      .filter((element) => !sourceButton.contains(element))
      .filter((element) => element.closest('[data-thread-find-skip="true"]') === null)
      .map((element) => getNormalizedElementLabel(element))
      .filter((label): label is string => label !== null)
      .join(" "),
  );
  return commitLabel;
}

function getReviewRefLabel(): string | null {
  return getReviewCommitRefLabel() ?? getNormalizedElementLabel(getReviewRefButton());
}

function getReviewToggleFilesButton(): HTMLButtonElement | null {
  const panel = getReviewPanel();
  if (!panel) {
    return null;
  }

  return (
    getVisibleButtons(panel).find((button) => {
      const label = getNormalizedElementLabel(button);
      return label === "Hide files" || label === "Show files";
    }) ?? null
  );
}

function areReviewFilesVisible(): boolean {
  const toggleButton = getReviewToggleFilesButton();
  const label = getNormalizedElementLabel(toggleButton);
  if (label === "Hide files") {
    return true;
  }
  if (label === "Show files") {
    return false;
  }

  return isVisibleElement(getReviewFileTreeHost());
}

function getReviewDiffLayoutButton(): HTMLButtonElement | null {
  const panel = getReviewPanel();
  if (!panel) {
    return null;
  }

  return (
    getVisibleButtons(panel).find((button) => {
      const label = getNormalizedElementLabel(button);
      return label === REVIEW_DIFF_LAYOUT_LABELS.split || label === REVIEW_DIFF_LAYOUT_LABELS.unified;
    }) ?? null
  );
}

function getReviewDiffLayout(): ReviewDiffLayout | null {
  const label = getNormalizedElementLabel(getReviewDiffLayoutButton());
  if (label === REVIEW_DIFF_LAYOUT_LABELS.unified) {
    return "unified";
  }
  if (label === REVIEW_DIFF_LAYOUT_LABELS.split) {
    return "split";
  }

  return null;
}

function getReviewFileExpandedToggle(): HTMLButtonElement | null {
  return getReviewPanel()?.querySelector<HTMLButtonElement>("[data-app-action-review-file-toggle]") ?? null;
}

function isReviewFileExpanded(): boolean | null {
  const value = getReviewFileExpandedToggle()?.getAttribute("data-app-action-review-file-expanded");
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  return null;
}

function getReviewScrollContainer(): HTMLElement | null {
  return getReviewPanel()?.querySelector<HTMLElement>("[data-app-action-review-scroll]") ?? null;
}

function getReviewFileFilterInput(): HTMLInputElement | HTMLTextAreaElement | null {
  const panel = getReviewPanel();
  return panel ? findVisibleTextControl("Filter files", panel) : null;
}

function getReviewFileTreeHost(): HTMLElement | null {
  return getReviewPanel()?.querySelector<HTMLElement>("file-tree-container,[data-file-tree-virtualized]") ?? null;
}

function getReviewFileTreeRoot(): ShadowRoot | null {
  return getReviewFileTreeHost()?.shadowRoot ?? null;
}

function getReviewFileTreeScrollContainer(): HTMLElement | null {
  return getReviewFileTreeRoot()?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll='true']") ?? null;
}

function getReviewFileTreeItemByPath(path: string): HTMLButtonElement | null {
  const item = getReviewFileTreeRoot()?.querySelector<HTMLButtonElement>(
    `[role="treeitem"][data-item-path="${CSS.escape(path)}"]`,
  ) ?? null;
  return isVisibleElement(item) ? item : null;
}

function getSelectedReviewFileTreePath(): string | null {
  return (
    getReviewFileTreeRoot()
      ?.querySelector<HTMLElement>('[role="treeitem"][data-item-selected="true"][data-item-path]')
      ?.getAttribute("data-item-path") ?? null
  );
}

function getReviewFileFilterQuery(): string | null {
  return getReviewFileFilterInput()?.value ?? null;
}

function captureReviewState(): PersistedReviewState | null {
  if (getActivePanelTab("right") !== "Review") {
    return null;
  }

  return {
    sourceKind: getReviewSourceKind(),
    refLabel: getReviewRefLabel(),
    fileAbsolutePath: getReviewAbsoluteFilePath(),
    fileTreePath: getSelectedReviewFileTreePath(),
    fileExpanded: isReviewFileExpanded(),
    fileFilterQuery: getReviewFileFilterQuery(),
    fileTreeScrollTop: getReviewFileTreeScrollContainer()?.scrollTop ?? null,
    filesVisible: areReviewFilesVisible(),
    diffLayout: getReviewDiffLayout(),
    reviewScrollTop: getReviewScrollContainer()?.scrollTop ?? null,
  };
}

function captureUiState(): PersistedUiState {
  return {
    pageKey: getCurrentPageKey(),
    sidebarOpen: isSidebarOpen(),
    sidePanelActiveTab: getActivePanelTab("right"),
    sidePanelOpen: isPanelOpen("right"),
    bottomPanelActiveTab: getActivePanelTab("bottom"),
    bottomPanelOpen: isPanelOpen("bottom"),
    review: captureReviewState(),
  };
}

function persistUiState(): void {
  const nextState = captureUiState();
  const serializedState = JSON.stringify(nextState);
  if (serializedState === lastPersistedUiStateJson) {
    return;
  }

  lastPersistedUiStateJson = serializedState;
  savePersistedUiState(nextState, serializedState);
}

function schedulePersistUiState(): void {
  if (uiStateRestoreInProgress || persistUiStateTimeoutId !== null) {
    return;
  }

  persistUiStateTimeoutId = window.setTimeout(() => {
    persistUiStateTimeoutId = null;
    if (!uiStateRestoreInProgress) {
      persistUiState();
    }
  }, 50);
}

function onUiStateScroll(): void {
  schedulePersistUiState();
}

function addUiStateScrollListener(target: EventTarget | null | undefined): void {
  if (!target || uiStateScrollTargets.has(target)) {
    return;
  }

  uiStateScrollTargets.add(target);
  target.addEventListener("scroll", onUiStateScroll, { passive: true });
}

function ensureUiStateScrollListeners(): void {
  addUiStateScrollListener(window);
  addUiStateScrollListener(document);
  addUiStateScrollListener(getReviewScrollContainer());
  addUiStateScrollListener(getReviewFileTreeScrollContainer());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function waitForCondition(
  check: () => boolean,
  timeoutMs = UI_STATE_RESTORE_TIMEOUT_MS,
): Promise<boolean> {
  if (check()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const intervalId = window.setInterval(() => {
      const matched = check();
      if (matched || Date.now() >= deadline) {
        window.clearInterval(intervalId);
        resolve(matched);
      }
    }, UI_STATE_RESTORE_POLL_MS);
  });
}

async function restorePanelTab(
  panel: "right" | "bottom",
  label: string,
): Promise<boolean> {
  if (getActivePanelTab(panel) === label) {
    return true;
  }

  const controller = getPanelTabController(panel);
  const openTabLabel = panel === "right" ? "Open side panel tab" : "Open bottom panel tab";

  await waitForCondition(() => {
    if (getActivePanelTab(panel) === label) {
      return true;
    }

    return (
      findVisibleButton(label, controller ?? document) !== null ||
      findVisibleButton(openTabLabel, controller ?? document) !== null ||
      findVisibleButton(openTabLabel) !== null
    );
  });

  if (getActivePanelTab(panel) === label) {
    return true;
  }

  const directButton =
    findVisibleButton(label, controller ?? document) ?? findVisibleButton(label);
  if (directButton) {
    triggerUserClick(directButton);
    return waitForCondition(() => getActivePanelTab(panel) === label);
  }

  const openTabButton =
    findVisibleButton(openTabLabel, controller ?? document) ??
    findVisibleButton(openTabLabel);
  if (!openTabButton) {
    return false;
  }

  triggerUserClick(openTabButton);
  const menuOpened = await waitForCondition(() => {
    const candidate = findVisibleButton(label);
    return candidate !== null && candidate !== openTabButton;
  });
  if (!menuOpened) {
    return false;
  }

  const menuButton = findVisibleButton(label);
  if (!menuButton || menuButton === openTabButton) {
    return false;
  }

  triggerUserClick(menuButton);
  return waitForCondition(() => getActivePanelTab(panel) === label);
}

function getReviewPathSegments(state: PersistedReviewState): string[] {
  const sourcePath = state.fileTreePath ?? state.fileAbsolutePath ?? "";
  return sourcePath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getReviewPathBasename(state: PersistedReviewState): string | null {
  return getReviewPathSegments(state).at(-1) ?? null;
}

function scoreReviewPathCandidate(candidate: string, state: PersistedReviewState): number {
  const normalizedCandidate = candidate.toLowerCase();
  const segments = getReviewPathSegments(state).map((segment) => segment.toLowerCase());
  if (segments.length === 0) {
    return 0;
  }

  let score = 0;
  const basename = segments.at(-1);
  if (basename && normalizedCandidate.includes(basename)) {
    score += 100;
  }

  for (const segment of segments.slice(-4, -1)) {
    if (normalizedCandidate.includes(segment)) {
      score += 10;
    }
  }

  return score;
}

function getBestMatchingReviewTreeItem(state: PersistedReviewState): HTMLButtonElement | null {
  const root = getReviewFileTreeRoot();
  if (!root) {
    return null;
  }

  let bestItem: HTMLButtonElement | null = null;
  let bestScore = 0;

  for (const item of root.querySelectorAll<HTMLButtonElement>('[role="treeitem"][data-item-path]')) {
    if (!isVisibleElement(item)) {
      continue;
    }

    const score = scoreReviewPathCandidate(item.getAttribute("data-item-path") ?? "", state);
    if (score > bestScore) {
      bestItem = item;
      bestScore = score;
    }
  }

  return bestItem;
}

async function findReviewTreeItem(
  state: PersistedReviewState,
  filterInput: HTMLInputElement | HTMLTextAreaElement | null,
): Promise<HTMLButtonElement | null> {
  const getCandidate = () => {
    if (state.fileTreePath) {
      return getReviewFileTreeItemByPath(state.fileTreePath);
    }
    if (state.fileAbsolutePath) {
      return getBestMatchingReviewTreeItem(state);
    }
    return null;
  };

  let treeItem = getCandidate();
  if (treeItem || !filterInput) {
    return treeItem;
  }

  const query = getReviewPathBasename(state) ?? state.fileTreePath;
  if (!query) {
    return null;
  }

  setTextControlValue(filterInput, query);
  await waitForCondition(() => getCandidate() !== null, 1_500);
  treeItem = getCandidate();
  return treeItem;
}

async function selectVisibleMenuItem(
  label: string,
  options?: {
    exact?: boolean;
    searchTextboxLabel?: string;
  },
): Promise<boolean> {
  const exact = options?.exact ?? true;
  const searchTextboxLabel = options?.searchTextboxLabel;

  if (searchTextboxLabel) {
    const searchVisible = await waitForCondition(
      () => findVisibleTextControl(searchTextboxLabel) !== null,
      1_000,
    );
    if (searchVisible) {
      const searchControl = findVisibleTextControl(searchTextboxLabel);
      if (searchControl) {
        setTextControlValue(searchControl, label);
      }
    }
  }

  const menuItemVisible = await waitForCondition(
    () => findVisibleMenuItem(label, exact) !== null,
    1_000,
  );
  if (!menuItemVisible) {
    return false;
  }

  triggerUserClick(findVisibleMenuItem(label, exact));
  return true;
}

async function setReviewFilesVisible(visible: boolean): Promise<void> {
  if (areReviewFilesVisible() === visible) {
    return;
  }

  triggerUserClick(getReviewToggleFilesButton());
  await waitForCondition(() => areReviewFilesVisible() === visible, 2_000);
}

async function setReviewDiffLayout(layout: ReviewDiffLayout | null): Promise<void> {
  if (!layout || getReviewDiffLayout() === layout) {
    return;
  }

  triggerUserClick(getReviewDiffLayoutButton());
  await waitForCondition(() => getReviewDiffLayout() === layout, 2_000);
}

async function selectDefaultReviewSource(): Promise<void> {
  const pageKey = getCurrentPageKey();
  if (
    reviewDefaultSourceInFlightPageKey === pageKey ||
    hasStoredReviewSourcePreference(pageKey) ||
    getActivePanelTab("right") !== "Review"
  ) {
    return;
  }

  const sourceButton = getReviewSourceButton();
  const sourceKind = getReviewSourceKind();
  if (!sourceButton || !sourceKind || sourceKind === "Unstaged") {
    return;
  }

  reviewDefaultSourceInFlightPageKey = pageKey;
  try {
    triggerUserClick(sourceButton);
    if (await selectVisibleMenuItem("Unstaged")) {
      const applied = await waitForCondition(
        () => getCurrentPageKey() === pageKey && getReviewSourceKind() === "Unstaged",
        2_000,
      );
      if (applied) {
        schedulePersistUiState();
      }
    }
  } finally {
    if (reviewDefaultSourceInFlightPageKey === pageKey) {
      reviewDefaultSourceInFlightPageKey = null;
    }
  }
}

function maybeSelectDefaultReviewSource(): void {
  const pageKey = getCurrentPageKey();
  if (getActivePanelTab("right") !== "Review") {
    reviewDefaultSourceAttemptedPageKey = null;
    return;
  }

  if (!getReviewSourceButton() || !getReviewSourceKind()) {
    return;
  }

  if (reviewDefaultSourceAttemptedPageKey === pageKey) {
    return;
  }

  reviewDefaultSourceAttemptedPageKey = pageKey;
  void selectDefaultReviewSource();
}

async function restoreReviewSource(state: PersistedReviewState): Promise<void> {
  if (!state.sourceKind) {
    return;
  }

  const currentSourceKind = getReviewSourceKind();
  if (currentSourceKind !== state.sourceKind) {
    const sourceButton = getReviewSourceButton();
    if (!sourceButton) {
      return;
    }

    triggerUserClick(sourceButton);
    if (state.sourceKind === "Commit" && state.refLabel) {
      const commitMenuOpened = await selectVisibleMenuItem("Commit");
      if (commitMenuOpened) {
        await selectVisibleMenuItem(state.refLabel);
        await waitForCondition(
          () => getReviewSourceKind() === "Commit" || getReviewRefLabel() === state.refLabel,
          2_000,
        );
      }
    } else {
      const sourceSelected = await selectVisibleMenuItem(state.sourceKind);
      if (sourceSelected) {
        await waitForCondition(() => getReviewSourceKind() === state.sourceKind, 2_000);
      }
    }
  }

  if (!state.refLabel || getReviewRefLabel() === state.refLabel) {
    return;
  }

  const refButton = getReviewRefButton();
  if (refButton) {
    triggerUserClick(refButton);
    const searchLabel = state.sourceKind === "Branch" ? "Search branches" : undefined;
    const refSelected = await selectVisibleMenuItem(state.refLabel, {
      searchTextboxLabel: searchLabel,
    });
    if (refSelected) {
      await waitForCondition(() => getReviewRefLabel() === state.refLabel, 2_000);
      return;
    }
  }

  if (state.sourceKind === "Commit") {
    triggerUserClick(getReviewSourceButton());
    const commitMenuOpened = await selectVisibleMenuItem("Commit");
    if (!commitMenuOpened) {
      return;
    }

    const refSelected = await selectVisibleMenuItem(state.refLabel);
    if (refSelected) {
      await waitForCondition(
        () => getReviewRefLabel() === state.refLabel || getReviewSourceKind() === "Commit",
        2_000,
      );
    }
  }
}

async function restoreReviewFileSelectionFromJumpToFile(
  state: PersistedReviewState,
): Promise<boolean> {
  const jumpButton = findVisibleButton("Jump to file");
  const query = getReviewPathBasename(state);
  if (!jumpButton || !query) {
    return false;
  }

  triggerUserClick(jumpButton);
  const textboxVisible = await waitForCondition(
    () => findVisibleTextControl("Jump to file") !== null,
    1_000,
  );
  if (!textboxVisible) {
    return false;
  }

  const textbox = findVisibleTextControl("Jump to file");
  if (!textbox) {
    return false;
  }

  setTextControlValue(textbox, query);
  const menuItemsVisible = await waitForCondition(() => getVisibleMenuItems().length > 0, 1_000);
  if (!menuItemsVisible) {
    return false;
  }

  let bestMenuItem: HTMLElement | null = null;
  let bestScore = 0;

  for (const item of getVisibleMenuItems()) {
    const score = scoreReviewPathCandidate(getNormalizedElementLabel(item) ?? "", state);
    if (score > bestScore) {
      bestMenuItem = item;
      bestScore = score;
    }
  }

  if (!bestMenuItem) {
    return false;
  }

  triggerUserClick(bestMenuItem);
  return waitForCondition(() => {
    return (
      (state.fileTreePath !== null && getSelectedReviewFileTreePath() === state.fileTreePath) ||
      (state.fileAbsolutePath !== null && getReviewAbsoluteFilePath() === state.fileAbsolutePath)
    );
  }, 2_000);
}

async function restoreReviewFileSelection(state: PersistedReviewState): Promise<void> {
  await waitForCondition(
    () => getReviewFileTreeRoot() !== null || findVisibleButton("Jump to file") !== null,
    2_000,
  );

  const alreadySelected =
    state.fileAbsolutePath !== null
      ? getReviewAbsoluteFilePath() === state.fileAbsolutePath
      : state.fileTreePath !== null && getSelectedReviewFileTreePath() === state.fileTreePath;
  if (alreadySelected) {
    return;
  }

  if (!state.fileTreePath && !state.fileAbsolutePath) {
    return;
  }

  const filterInput = getReviewFileFilterInput();
  const savedFilterQuery = state.fileFilterQuery ?? "";
  if (filterInput && filterInput.value !== savedFilterQuery) {
    setTextControlValue(filterInput, savedFilterQuery);
    await delay(50);
  }

  const treeItem = await findReviewTreeItem(state, filterInput);
  if (treeItem) {
    triggerUserClick(treeItem);
    const selected = await waitForCondition(() => {
      const selectedTreePath = getSelectedReviewFileTreePath();
      const absolutePath = getReviewAbsoluteFilePath();
      return (
        absolutePath === state.fileAbsolutePath ||
        (state.fileTreePath !== null &&
          selectedTreePath === state.fileTreePath &&
          (state.fileAbsolutePath === null || absolutePath === state.fileAbsolutePath))
      );
    }, 3_000);
    if (filterInput && filterInput.value !== savedFilterQuery) {
      setTextControlValue(filterInput, savedFilterQuery);
    }
    if (selected) {
      return;
    }
  }

  if (filterInput && filterInput.value !== savedFilterQuery) {
    setTextControlValue(filterInput, savedFilterQuery);
  }

  await restoreReviewFileSelectionFromJumpToFile(state);
}

async function restoreElementScrollTop(
  getElement: () => HTMLElement | null,
  scrollTop: number | null,
): Promise<void> {
  if (scrollTop === null) {
    return;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const element = getElement();
    if (!element) {
      return;
    }

    element.scrollTop = scrollTop;
    await delay(50);
  }
}

function isScrollPositionRestored(
  getElement: () => HTMLElement | null,
  expectedScrollTop: number | null,
): boolean {
  if (expectedScrollTop === null) {
    return true;
  }

  const actualScrollTop = getElement()?.scrollTop;
  return typeof actualScrollTop === "number" && Math.abs(actualScrollTop - expectedScrollTop) <= 2;
}

function needsReviewRestore(state: PersistedReviewState): boolean {
  return (
    (state.sourceKind !== null && getReviewSourceKind() !== state.sourceKind) ||
    (state.refLabel !== null && getReviewRefLabel() !== state.refLabel) ||
    (state.fileAbsolutePath !== null && getReviewAbsoluteFilePath() !== state.fileAbsolutePath) ||
    (state.fileTreePath !== null &&
      state.fileAbsolutePath === null &&
      getSelectedReviewFileTreePath() !== state.fileTreePath) ||
    areReviewFilesVisible() !== state.filesVisible ||
    (state.diffLayout !== null && getReviewDiffLayout() !== state.diffLayout) ||
    (state.fileExpanded !== null && isReviewFileExpanded() !== state.fileExpanded) ||
    (state.filesVisible && (state.fileFilterQuery ?? "") !== (getReviewFileFilterQuery() ?? "")) ||
    (state.filesVisible &&
      !isScrollPositionRestored(getReviewFileTreeScrollContainer, state.fileTreeScrollTop)) ||
    !isScrollPositionRestored(getReviewScrollContainer, state.reviewScrollTop)
  );
}

async function restoreReviewStateOnce(state: PersistedReviewState): Promise<void> {
  await waitForCondition(() => getReviewPanel() !== null, 2_000);
  await restoreReviewSource(state);
  await setReviewDiffLayout(state.diffLayout);

  const needsTemporaryFilesPanel = !state.filesVisible && Boolean(state.fileTreePath || state.fileAbsolutePath);
  if (state.filesVisible || needsTemporaryFilesPanel) {
    await setReviewFilesVisible(true);
    await waitForCondition(
      () => getReviewFileTreeRoot() !== null || findVisibleButton("Jump to file") !== null,
      2_000,
    );
    await delay(100);
  }

  await restoreReviewFileSelection(state);

  if (state.fileExpanded !== null && isReviewFileExpanded() !== state.fileExpanded) {
    triggerUserClick(getReviewFileExpandedToggle());
    await waitForCondition(() => isReviewFileExpanded() === state.fileExpanded, 2_000);
  }

  if (state.filesVisible) {
    const filterInput = getReviewFileFilterInput();
    if (filterInput && filterInput.value !== (state.fileFilterQuery ?? "")) {
      setTextControlValue(filterInput, state.fileFilterQuery ?? "");
      await delay(50);
    }
    await restoreElementScrollTop(getReviewFileTreeScrollContainer, state.fileTreeScrollTop);
  }

  if (!state.filesVisible) {
    await setReviewFilesVisible(false);
  }

  await restoreElementScrollTop(getReviewScrollContainer, state.reviewScrollTop);
}

async function restoreReviewState(state: PersistedReviewState | null): Promise<void> {
  if (!state) {
    return;
  }

  const reviewReady = await waitForCondition(
    () => getActivePanelTab("right") === "Review" && getReviewPanel() !== null,
    3_000,
  );
  if (!reviewReady) {
    return;
  }

  await restoreReviewStateOnce(state);
  if (needsReviewRestore(state)) {
    await delay(150);
    await restoreReviewStateOnce(state);
  }

  await restoreElementScrollTop(getReviewScrollContainer, state.reviewScrollTop);
}

async function syncSidebarOpen(desiredOpen: boolean): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isSidebarOpen() === desiredOpen) {
      return;
    }

    await waitForCondition(() => getSidebarToggleButton() !== null);
    triggerUserClick(getSidebarToggleButton());
    const synced = await waitForCondition(() => isSidebarOpen() === desiredOpen, 1_000);
    if (synced) {
      return;
    }

    await delay(100);
  }
}

async function syncPanelOpen(panel: "right" | "bottom", desiredOpen: boolean): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isPanelOpen(panel) === desiredOpen) {
      return;
    }

    await waitForCondition(() => getPanelToggleButton(panel) !== null);
    triggerUserClick(getPanelToggleButton(panel));
    const synced = await waitForCondition(() => isPanelOpen(panel) === desiredOpen, 1_000);
    if (synced) {
      return;
    }

    await delay(100);
  }
}

function needsUiRestore(state: PersistedUiState | null): boolean {
  if (!state || state.pageKey !== getCurrentPageKey()) {
    return false;
  }

  return (
    isSidebarOpen() !== state.sidebarOpen ||
    isPanelOpen("right") !== state.sidePanelOpen ||
    (state.sidePanelOpen &&
      state.sidePanelActiveTab !== null &&
      getActivePanelTab("right") !== state.sidePanelActiveTab) ||
    (state.sidePanelOpen &&
      state.sidePanelActiveTab === "Review" &&
      state.review !== null &&
      needsReviewRestore(state.review)) ||
    isPanelOpen("bottom") !== state.bottomPanelOpen ||
    (state.bottomPanelOpen &&
      state.bottomPanelActiveTab !== null &&
      getActivePanelTab("bottom") !== state.bottomPanelActiveTab)
  );
}

async function restoreUiState(state: PersistedUiState | null): Promise<void> {
  if (!state || state.pageKey !== getCurrentPageKey()) {
    return;
  }

  uiStateRestoreInProgress = true;
  try {
    if (isSidebarOpen() !== state.sidebarOpen) {
      await syncSidebarOpen(state.sidebarOpen);
    }

    await syncPanelOpen("right", state.sidePanelOpen);
    if (state.sidePanelOpen) {
      if (state.sidePanelActiveTab) {
        await restorePanelTab("right", state.sidePanelActiveTab);
      }

      await restoreReviewState(state.review);
    }

    await syncPanelOpen("bottom", state.bottomPanelOpen);
    if (state.bottomPanelOpen && state.bottomPanelActiveTab) {
      await restorePanelTab("bottom", state.bottomPanelActiveTab);
    }

    if (isSidebarOpen() !== state.sidebarOpen) {
      await syncSidebarOpen(state.sidebarOpen);
    }
  } finally {
    uiStateRestoreInProgress = false;
  }

  schedulePersistUiState();
}

function initializeUiStatePersistence(state: PersistedUiState | null): void {
  const start = async () => {
    let userInteracted = false;

    const markUserInteraction = (event: Event) => {
      if (event.isTrusted) {
        userInteracted = true;
      }
    };

    window.addEventListener("pointerdown", markUserInteraction, { capture: true });
    window.addEventListener("keydown", markUserInteraction, { capture: true });
    window.addEventListener("click", schedulePersistUiState, { capture: true });
    window.addEventListener("keyup", schedulePersistUiState, { capture: true });
    window.addEventListener("input", schedulePersistUiState, { capture: true });

    await restoreUiState(state);
    window.setTimeout(() => {
      if (!userInteracted && needsUiRestore(state)) {
        void restoreUiState(state);
      }
    }, 500);
    ensureUiStateScrollListeners();

    const observer = new MutationObserver(() => {
      ensureUiStateScrollListeners();
      maybeSelectDefaultReviewSource();
      if (!uiStateRestoreInProgress) {
        schedulePersistUiState();
      }
    });

    if (document.body) {
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-label", "aria-pressed", "aria-selected", "data-state"],
      });
    }

    schedulePersistUiState();
    maybeSelectDefaultReviewSource();
  };

  if (document.body) {
    void start();
    return;
  }

  window.addEventListener("DOMContentLoaded", () => {
    void start();
  }, { once: true });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

window.chrome ??= {};
window.chrome.runtime ??= {};
window.chrome.runtime.sendMessage ??= handleBrowserRuntimeMessage;

electronShim.services = {
  ...electronShim.services,
  appInfo: {
    get: async () => ({
      appBrand: "codex",
      appIconMedium: null,
      appName: "Codex",
      buildFlavor,
      buildNumber: null,
      dockIconPreviews: null,
      osName: "macOS",
      systemVersion: null,
      version: __CODEX_APP_VERSION__,
    }),
  },
  workspaceFiles: electronShim.services?.workspaceFiles ?? {},
  fileAttachments: {
    ...electronShim.services?.fileAttachments,
    persistImageFileToTemp: async (file: File) =>
      (await uploadFiles([file]))[0]?.fsPath ?? null,
  },
  requestUserInputAutoResolution: {
    ...electronShim.services?.requestUserInputAutoResolution,
    recordConversationActivity: () => undefined,
    setConversationPresented: () => undefined,
    snooze: () => undefined,
  },
};

const folderToAdd = new URLSearchParams(window.location.search).get("folder")?.trim();
const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;
electronShim.folderFilterProjectId = folderToAdd || undefined;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

const persistedUiState = loadPersistedUiState();
electronShim.initialSidebarState = persistedUiState?.sidebarOpen ?? false;
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (path === "/" && folderToAdd && navigation.action !== "POP") {
    updateBrowserPath(
      `/?${new URLSearchParams({ folder: folderToAdd }).toString()}`,
      navigation.action,
    );
    dispatchNavigateToRoute(
      `/projects?${new URLSearchParams({ projectId: folderToAdd })}`,
    );
    return;
  }

  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  updateBrowserPath(browserPath.path, navigation.action);
};

initializeUiStatePersistence(persistedUiState);

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isElectronWindowFocusRequestMessage(args[0])) {
        const isFocused = getBrowserWindowFocusState();
        lastBrowserWindowFocusState = isFocused;
        emitRendererEvent("codex_desktop:message-for-view", [
          {
            type: "electron-window-focus-changed",
            isFocused,
          },
        ]);
        return Promise.resolve(undefined);
      }

      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      clientId,
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          if (channel === "codex_desktop:connect-app-host") {
            handleNotificationShowMessage(event.data);
          }
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      clientId,
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    // Browser mode has no desktop startup snapshot or native file-drag bridge.
    if (channel === "codex_desktop:get-initial-sidebar-bootstrap") {
      return null;
    }

    if (channel === "codex_desktop:start-file-drag") {
      return false;
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

if (folderToAdd) {
  void ipcRenderer.invoke("codex_desktop:message-from-view", {
    type: "electron-add-new-workspace-root-option",
    root: folderToAdd,
  });
}

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return null;
  },
};
