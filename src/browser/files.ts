import { emitRendererEvent, isRecord } from "./shim";

type CodexFetchMessage = {
  body?: string;
  headers?: Record<string, string>;
  hostId?: string;
  method: string;
  requestId: string;
  type: "fetch";
  url: string;
};

type PickFilesRequest = {
  imagesOnly?: boolean;
};

type UploadedFile = {
  label: string;
  path: string;
  fsPath: string;
};

const BROWSER_ATTACHMENT_CREATE = "SAVE_TAB_CONTEXT_ASSET_CREATE";
const BROWSER_ATTACHMENT_APPEND_CHUNK = "SAVE_TAB_CONTEXT_ASSET_APPEND_CHUNK";
const BROWSER_ATTACHMENT_FINISH = "SAVE_TAB_CONTEXT_ASSET_FINISH";
const BROWSER_ATTACHMENT_ABORT = "SAVE_TAB_CONTEXT_ASSET_ABORT";
const BROWSER_ATTACHMENT_REMOVE = "SAVE_TAB_CONTEXT_ASSET_REMOVE";

type BrowserAttachmentMessage =
  | { type: typeof BROWSER_ATTACHMENT_CREATE; fileName: string }
  | {
      type: typeof BROWSER_ATTACHMENT_APPEND_CHUNK;
      assetId: string;
      dataBase64: string;
    }
  | { type: typeof BROWSER_ATTACHMENT_FINISH; assetId: string }
  | { type: typeof BROWSER_ATTACHMENT_ABORT; assetId: string }
  | { type: typeof BROWSER_ATTACHMENT_REMOVE; assetId: string };

function openBrowserFilePicker({
  allowMultiple,
  imagesOnly,
}: {
  allowMultiple: boolean;
  imagesOnly?: boolean;
}): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    let settled = false;

    function cleanup(): void {
      input.removeEventListener("cancel", handleCancel);
      input.removeEventListener("change", handleChange);
      input.remove();
    }

    function finish(files: File[]): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(files);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function handleCancel(): void {
      finish([]);
    }

    function handleChange(): void {
      finish(Array.from(input.files ?? []));
    }

    input.type = "file";
    input.multiple = allowMultiple;
    if (imagesOnly) {
      input.accept = "image/*";
    }
    Object.assign(input.style, {
      height: "1px",
      left: "-9999px",
      opacity: "0",
      position: "fixed",
      top: "0",
      width: "1px",
    });
    input.addEventListener("cancel", handleCancel);
    input.addEventListener("change", handleChange);
    document.body.append(input);

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  if (files.length === 0) {
    return [];
  }

  const uploadUrl = new URL("/__backend/upload", window.location.href);
  const formData = new FormData();

  for (const file of files) {
    formData.append("files", file, file.name || "upload");
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  const { files: uploadedFiles } = (await response.json()) as {
    files: UploadedFile[];
  };
  return uploadedFiles;
}

export async function handleLocalFilePickerMessage(message: CodexFetchMessage) {
  try {
    const response = await handleLocalFilePickerMessageInner(message);

    sendFetchResponse(message, {
      responseType: "success",
      body: response,
    });
  } catch (error) {
    console.error(error);

    sendFetchResponse(message, {
      responseType: "error",
      status: 432,
      error: errorMessage(error),
    });
  }
}

export async function handleBrowserRuntimeMessage(
  value: unknown,
): Promise<unknown> {
  try {
    const message = parseBrowserAttachmentMessage(value);

    switch (message.type) {
      case BROWSER_ATTACHMENT_CREATE:
        return postBackendJson("/__backend/staged-upload/create", {
          fileName: message.fileName,
        });

      case BROWSER_ATTACHMENT_APPEND_CHUNK:
        return postBackendJson("/__backend/staged-upload/append", {
          assetId: message.assetId,
          dataBase64: message.dataBase64,
        });

      case BROWSER_ATTACHMENT_FINISH:
        return postBackendJson("/__backend/staged-upload/finish", {
          assetId: message.assetId,
        });

      case BROWSER_ATTACHMENT_ABORT:
      case BROWSER_ATTACHMENT_REMOVE:
        return postBackendJson("/__backend/staged-upload/remove", {
          assetId: message.assetId,
        });
    }
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}

async function handleLocalFilePickerMessageInner(message: CodexFetchMessage) {
  const request = parsePickFilesRequest(message);
  const allowMultiple = message.url === "vscode://codex/pick-files";

  const selectedFiles = await openBrowserFilePicker({
    allowMultiple,
    imagesOnly: request.imagesOnly,
  });

  const uploadedFiles = await uploadFiles(selectedFiles);

  return allowMultiple
    ? { files: uploadedFiles }
    : { file: uploadedFiles[0] ?? null };
}

function isCodexFetchMessage(value: unknown): value is CodexFetchMessage {
  return isRecord(value) && value.type === "fetch";
}

export function isLocalFilePickerMessage(
  value: unknown,
): value is CodexFetchMessage {
  return (
    isCodexFetchMessage(value) &&
    value.method.toUpperCase() === "POST" &&
    (value.url === "vscode://codex/pick-files" ||
      value.url === "vscode://codex/pick-file")
  );
}

function parseBrowserAttachmentMessage(
  value: unknown,
): BrowserAttachmentMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Unsupported browser runtime message");
  }

  switch (value.type) {
    case BROWSER_ATTACHMENT_CREATE:
      if (typeof value.fileName === "string") {
        return { type: value.type, fileName: value.fileName };
      }
      break;

    case BROWSER_ATTACHMENT_APPEND_CHUNK:
      if (
        typeof value.assetId === "string" &&
        typeof value.dataBase64 === "string"
      ) {
        return {
          type: value.type,
          assetId: value.assetId,
          dataBase64: value.dataBase64,
        };
      }
      break;

    case BROWSER_ATTACHMENT_FINISH:
    case BROWSER_ATTACHMENT_ABORT:
    case BROWSER_ATTACHMENT_REMOVE:
      if (typeof value.assetId === "string") {
        return { type: value.type, assetId: value.assetId };
      }
      break;
  }

  throw new Error("Unsupported browser runtime message");
}

function parsePickFilesRequest(message: CodexFetchMessage): PickFilesRequest {
  if (!message.body) {
    return {};
  }

  try {
    const parsed = JSON.parse(message.body) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      imagesOnly:
        typeof parsed.imagesOnly === "boolean" ? parsed.imagesOnly : undefined,
    };
  } catch {
    return {};
  }
}

function sendFetchResponse(
  message: CodexFetchMessage,
  response:
    | {
        responseType: "success";
        body: unknown;
        status?: number;
      }
    | {
        responseType: "error";
        error: string;
        status?: number;
      },
): void {
  const payload =
    response.responseType === "success"
      ? {
          type: "fetch-response",
          responseType: "success",
          requestId: message.requestId,
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
          bodyJsonString: JSON.stringify(response.body),
        }
      : {
          type: "fetch-response",
          responseType: "error",
          requestId: message.requestId,
          status: response.status ?? 432,
          error: response.error,
        };

  emitRendererEvent("codex_desktop:message-for-view", [payload]);
}

async function postBackendJson(
  pathname: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(pathname, window.location.href), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
