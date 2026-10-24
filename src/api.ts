// A small client for The Archivist's API. The transport is injected: Obsidian's `requestUrl`
// in the plugin (it works on mobile and isn't bound by CORS), a fake in tests.

export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

export type Transport = (req: TransportRequest) => Promise<{ status: number; text: string }>;

/** A failed call, with the API's error code (`invalid_token`, `archive_full`…) when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The network couldn't be reached at all. */
export class OfflineError extends Error {}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: ArrayBuffer): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

export function createApi(baseUrl: string, token: string | null, transport: Transport): Api {
  const base = baseUrl.replace(/\/+$/, "");
  async function request<T>(method: string, path: string, body?: string | ArrayBuffer, type?: string) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let res: { status: number; text: string };
    try {
      res = await transport({ url: base + path, method, headers, body, contentType: type });
    } catch (err) {
      throw new OfflineError(err instanceof Error ? err.message : String(err));
    }
    let data: unknown = null;
    try {
      data = res.text ? JSON.parse(res.text) : null;
    } catch {
      // not JSON
    }
    if (res.status >= 400) {
      const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        res.status,
        error?.code ?? "http_error",
        error?.message ?? `The archive answered ${res.status}.`,
      );
    }
    return data as T;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, JSON.stringify(body), "application/json"),
    put: (path, body) => request("PUT", path, body, "application/octet-stream"),
    delete: (path) => request("DELETE", path),
  };
}
