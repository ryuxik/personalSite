/**
 * Minimal Cloudflare Workers runtime types — only the surface this Worker
 * touches. Hand-written instead of @cloudflare/workers-types so the root
 * `astro check` (DOM lib) and the Worker typecheck never fight over globals.
 * wrangler bundles with esbuild and does not typecheck; `npm run
 * gallery:check` runs tsc against these.
 */

interface R2ObjectBody {
  readonly key: string;
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly httpEtag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface R2ObjectHead {
  readonly key: string;
  readonly size: number;
}

interface R2Objects {
  objects: R2ObjectHead[];
  truncated: boolean;
  cursor?: string;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2ObjectHead | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { last_row_id: number; changes: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

/** Workers-runtime global: the ONLY way a hand-rolled stream response gets an
 * honored Content-Length (a manual header on an unknown-length stream is
 * ignored or enforced-by-reset depending on runtime). */
declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/** Email Routing send_email binding — Cloudflare-native outbound email:
 * free, no vendor, no API key; destination must be a verified Email Routing
 * address on this zone (exactly our photographer-only model). */
interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
  }
}

interface Fetcher {
  fetch(request: Request | string): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  DB: D1Database;
  /** Secret — bearer for /api/admin/* and the ingest CLI. Unset = admin disabled. */
  SELECTS_ADMIN_TOKEN?: string;
  /** Email Routing send_email binding (preferred path). Absent until the
   * binding ships in wrangler.jsonc AND Email Routing is enabled on the zone. */
  NOTIFY?: SendEmailBinding;
  /** Secret — Resend API key: the FALLBACK email path. Unset = no fallback. */
  RESEND_API_KEY?: string;
  PHOTOGRAPHER_EMAIL?: string;
  /** Zero Trust team domain (e.g. lucky-star-0196.cloudflareaccess.com) and the
   * Access application's AUD tag — set both to let a verified Access JWT act
   * as an admin session (no token form for the browser). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  EMAIL_FROM?: string;
  PUBLIC_ORIGIN?: string;
}
