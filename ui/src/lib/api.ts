/*
 * Same-origin API client. Authentication stays in the HttpOnly session cookie;
 * mutations add the CSRF token returned by `/api/state`. A 401 permanently
 * marks the client unpaired so callers request a fresh QR instead of retrying.
 */

import type {
  AgentDto,
  MessagesPageDto,
  PermissionReply,
  PromptRequest,
  ProvidersDto,
  SessionInfoDto,
} from "./protocol";

/** `GET /api/state` payload. */
export type StateDto = {
  /** CSRF token echoed back in `X-Entangle-CSRF` on every mutation. */
  csrf: string;
  session: SessionInfoDto;
  /** Agent preselected for the next prompt. */
  agent?: string;
  /** Model preselected for the next prompt. */
  model?: { providerID: string; modelID: string };
  /** Newest event id the server has produced, so a fresh client can skip replay. */
  lastEventId?: number;
};

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Thrown for every 401. Callers must transition to `unpaired`, never retry. */
export class UnauthorizedError extends ApiError {
  constructor(message = "Session ended or restarted. Scan a fresh entangle QR code.") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ApiClientOptions {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Prefix for every path. Empty string keeps requests same-origin. */
  baseUrl?: string;
  /** Invoked exactly once per 401 before the error is thrown. */
  onUnauthorized?: () => void;
  /**
   * Observes every successful `getMessages()` page with the cursor it was
   * requested with (`undefined` = newest page). Read-only: the returned page is
   * unaffected by it.
   */
  onPage?: (page: MessagesPageDto, cursor?: string) => void;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function globalFetch(): FetchLike {
  const impl = (globalThis as { fetch?: FetchLike }).fetch;
  if (!impl) throw new Error("fetch is unavailable in this environment");
  return (input, init) => impl(input, init);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const detail = body?.error ?? body?.message;
    if (typeof detail === "string" && detail.length > 0) return detail;
  } catch {
    /* non-JSON error bodies are expected; fall through to the status text */
  }
  return `Request failed (${response.status})`;
}

export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly onUnauthorized: () => void;
  private readonly onPage: (page: MessagesPageDto, cursor?: string) => void;
  private csrf = "";
  private sessionID = "";
  private csrfPending: Promise<string> | null = null;
  /** Latches once a 401 is seen so a burst of in-flight calls cannot loop. */
  private unpaired = false;

  constructor(options: ApiClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalFetch();
    this.baseUrl = options.baseUrl ?? "";
    this.onUnauthorized = options.onUnauthorized ?? (() => {});
    this.onPage = options.onPage ?? (() => {});
  }

  async getState(): Promise<StateDto> {
    const state = await this.request<StateDto>("GET", "/api/state");
    if (typeof state?.csrf === "string") this.csrf = state.csrf;
    if (typeof state?.session?.id === "string") {
      if (this.sessionID && state.session.id !== this.sessionID) {
        this.markUnpaired();
        throw new UnauthorizedError("This browser was paired to another chat. Reload before continuing.");
      }
      this.sessionID = state.session.id;
    }
    return state;
  }

  async getMessages(cursor?: string): Promise<MessagesPageDto> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await this.request<MessagesPageDto>("GET", `/api/messages${query}`);
    if (!this.sessionID || page.sessionID !== this.sessionID) {
      this.markUnpaired();
      throw new UnauthorizedError("Session changed while loading history. Reload before continuing.");
    }
    this.onPage(page, cursor);
    return page;
  }

  async sendPrompt(request: PromptRequest): Promise<void> {
    await this.request<unknown>("POST", "/api/prompt", request);
  }

  async abort(): Promise<void> {
    await this.request<unknown>("POST", "/api/abort", {});
  }

  async respondPermission(id: string, reply: PermissionReply): Promise<void> {
    await this.request<unknown>("POST", `/api/permissions/${encodeURIComponent(id)}`, reply);
  }

  async getAgents(): Promise<AgentDto[]> {
    return this.request<AgentDto[]>("GET", "/api/agents");
  }

  async getProviders(): Promise<ProvidersDto> {
    return this.request<ProvidersDto>("GET", "/api/providers");
  }

  /**
   * Cheap liveness probe used by the SSE staleness watchdog. Resolves `true`
   * while the session is still valid, `false` on 401. Network failures resolve
   * `true` so a flaky Wi-Fi hop never looks like an expired pairing.
   */
  async probe(): Promise<boolean> {
    if (this.unpaired) return false;
    try {
      // Keep this as GET: the small /api/state payload is cheap, and the server
      // does not need a separate HEAD route solely for the staleness watchdog.
      await this.getState();
      return true;
    } catch (error) {
      return !(error instanceof UnauthorizedError);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (this.unpaired) throw new UnauthorizedError();

    const headers: Record<string, string> = {};
    if (body !== undefined) Object.assign(headers, JSON_HEADERS);
    if (method === "POST") {
      const token = await this.ensureCsrf();
      if (token) headers["X-Entangle-CSRF"] = token;
      if (this.sessionID) headers["X-Entangle-Session"] = this.sessionID;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 410) {
      const message = response.status === 410 ? await errorMessage(response) : undefined;
      this.markUnpaired();
      throw new UnauthorizedError(message);
    }
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * Fetches the CSRF token on demand — a single attempt, shared between
   * concurrent callers. Never retries: a 401 here propagates as `unpaired`.
   */
  private async ensureCsrf(): Promise<string> {
    if (this.csrf) return this.csrf;
    if (!this.csrfPending) {
      this.csrfPending = this.getState()
        .then((state) => state.csrf ?? "")
        .finally(() => {
          this.csrfPending = null;
        });
    }
    return this.csrfPending;
  }

  private markUnpaired(): void {
    this.csrf = "";
    this.sessionID = "";
    if (this.unpaired) return;
    this.unpaired = true;
    this.onUnauthorized();
  }
}
