import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersonioConfig, SourceTest } from "@backup/shared/api/sources";
import { folderName, stagingDir } from "./google-drive";
import { sourceSecret, type SourceRow } from "./service";

/*
 * Personio: people with every attribute the API credential may read
 * (Personnel Data API v1, GET /v1/company/employees), and each person's
 * documents (Document Management API v2, in beta: one list per person,
 * then a download per document). The export is written into the source's
 * local copy; restic backs it up. Documents already copied are not
 * downloaded again.
 *
 * Layout of the copy:
 *   export.json                 when, what, counts
 *   attributes.json             the attributes the credential may read
 *   employees.json              every person as Personio sends it
 *   employees.csv               one row per person, one column per attribute
 *   document-categories.json
 *   documents/<id> <last>, <first>/documents.json   the person's document list
 *   documents/<id> <last>, <first>/<document id> <name>
 */

const APP_ID = "PT_BACKUP";
const PAGE_SIZE = 100;
/** Personio allows 30 requests per second on v2 and 300 per minute on v1 employees; stay well below. */
const MIN_INTERVAL_MS = 150;

export class PersonioError extends Error {
  override name = "PersonioError";
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

type Attribute = { key: string; label: string; type?: string; universal_id?: string | null };
type Employee = { id: string; attributes: Record<string, unknown> };
type DocumentItem = {
  id: string;
  name: string;
  size: number | null;
  document_type?: string;
  category?: { id?: unknown };
  created_at?: string;
  date?: string;
  comment?: string | null;
};

/** A small client: one request at a time, a pause between requests, retries on 429 and 5xx. */
export class PersonioClient {
  private tokens: { v2?: string; v1?: string } = {};
  private last = 0;

  constructor(
    private readonly settings: { baseUrl: string; clientId: string; clientSecret: string },
    private readonly signal?: AbortSignal,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async pace() {
    const wait = this.last + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.last = Date.now();
  }

  private url(pathOrUrl: string) {
    return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.settings.baseUrl}${pathOrUrl}`;
  }

  private async send(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      this.signal?.throwIfAborted();
      await this.pace();
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(pathOrUrl), {
          ...init,
          headers: { "X-Personio-App-ID": APP_ID, accept: "application/json", ...init.headers },
          redirect: "follow",
          signal: this.signal
            ? AbortSignal.any([this.signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000),
        });
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (attempt >= 4) throw new PersonioError("Personio is not reachable");
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after"));
        const seconds =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) : 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }
      return response;
    }
  }

  /** The v2 token (client credentials); it also opens the v1 personnel endpoints. */
  private async v2Token(): Promise<string> {
    if (this.tokens.v2) return this.tokens.v2;
    const response = await this.send("/v2/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      access_token?: string;
      error_description?: string;
    } | null;
    if (!response.ok || !body?.access_token) {
      throw new PersonioError(
        response.status === 400 || response.status === 401
          ? "Personio refused the client ID or secret"
          : `Personio's sign-in answered HTTP ${response.status}`,
        response.status,
      );
    }
    this.tokens.v2 = body.access_token;
    return body.access_token;
  }

  /** The v1 token, for when a v1 endpoint does not take the v2 token. */
  private async v1Token(): Promise<string> {
    if (this.tokens.v1) return this.tokens.v1;
    const response = await this.send("/v1/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.settings.clientId, client_secret: this.settings.clientSecret }),
    });
    const body = (await response.json().catch(() => null)) as { data?: { token?: string } } | null;
    if (!response.ok || !body?.data?.token) {
      throw new PersonioError(`Personio's v1 sign-in answered HTTP ${response.status}`, response.status);
    }
    this.tokens.v1 = body.data.token;
    return body.data.token;
  }

  /** GET with the bearer token; v1 paths fall back to the v1 token once. */
  async get(pathOrUrl: string, accept = "application/json"): Promise<Response> {
    const v1 = /\/v1\//.test(pathOrUrl);
    let response = await this.send(pathOrUrl, {
      headers: { authorization: `Bearer ${await this.v2Token()}`, accept },
    });
    if (v1 && (response.status === 401 || response.status === 403)) {
      await response.body?.cancel();
      response = await this.send(pathOrUrl, {
        headers: { authorization: `Bearer ${await this.v1Token()}`, accept },
      });
    }
    return response;
  }

  async json<T>(pathOrUrl: string, what: string): Promise<T> {
    const response = await this.get(pathOrUrl);
    if (!response.ok) {
      await response.body?.cancel();
      throw new PersonioError(
        response.status === 403
          ? `Personio refused to ${what}: the API credential lacks the permission`
          : `Personio answered HTTP ${response.status} to ${what}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /** A list's items; an answer without the list is an error, never an empty list (which would empty the copy). */
  private list<T>(body: Record<string, unknown> | null, field: string, what: string): T[] {
    const items = body?.[field];
    if (!Array.isArray(items)) throw new PersonioError(`Personio sent an unexpected answer to ${what}`);
    return items as T[];
  }

  async attributes(): Promise<Attribute[]> {
    const what = "list the attributes";
    const body = await this.json<Record<string, unknown>>("/v1/company/employees/attributes", what);
    return this.list<Attribute>(body, "data", what).filter((attribute) => typeof attribute.key === "string");
  }

  /** Every person (v1), with the given attributes; page by page, without duplicates. */
  async employees(attributeKeys: string[]): Promise<Employee[]> {
    const found = new Map<string, Employee>();
    for (let offset = 0, page = 0; page < 10_000; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      for (const key of attributeKeys) query.append("attributes[]", key);
      const body = await this.json<{
        data?: { attributes?: Record<string, unknown> }[];
        metadata?: { total_elements?: number; total_pages?: number };
      }>(`/v1/company/employees?${query}`, "list the employees");
      const items = this.list<{ attributes?: Record<string, unknown> }>(body, "data", "list the employees");
      for (const item of items) {
        const attributes = item.attributes ?? {};
        const id = plainValue(attributes.id);
        if (id !== "") found.set(String(id), { id: String(id), attributes });
      }
      offset += PAGE_SIZE;
      const total = body.metadata?.total_elements;
      if (items.length < PAGE_SIZE || (typeof total === "number" && offset >= total)) break;
    }
    return [...found.values()];
  }

  async documentCategories(): Promise<unknown> {
    return this.json<unknown>("/v1/company/document-categories", "list the document categories");
  }

  /** A person's documents (v2, beta), all pages. */
  async documents(ownerId: string): Promise<DocumentItem[]> {
    const items: DocumentItem[] = [];
    let next: string | null =
      `/v2/document-management/documents?owner_id=${encodeURIComponent(ownerId)}&limit=200`;
    for (let page = 0; next && page < 1000; page += 1) {
      const body: { _data?: Record<string, unknown>[]; _meta?: { links?: { next?: { href?: string } } } } =
        await this.json(next, "list documents");
      for (const raw of this.list<Record<string, unknown>>(body, "_data", "list documents")) {
        items.push({
          ...(raw as object),
          id: String(raw.id),
          name: String(raw.name ?? raw.id),
          size: typeof raw.size === "number" ? raw.size : null,
        } as DocumentItem);
      }
      const href: string | undefined = body._meta?.links?.next?.href;
      if (!href) next = null;
      else {
        const url = new URL(href, this.settings.baseUrl);
        if (!url.searchParams.has("owner_id")) url.searchParams.set("owner_id", ownerId);
        next = url.toString();
      }
    }
    return items;
  }

  async download(documentId: string): Promise<Response> {
    return this.get(`/v2/document-management/documents/${encodeURIComponent(documentId)}/download`, "*/*");
  }
}

/** An attribute's plain value: Personio wraps values in {value}, and references in {attributes: {name}}. */
export function plainValue(value: unknown): string | number | boolean | "" {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value
      .map((item) => String(plainValue(item)))
      .filter(Boolean)
      .join("; ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) return plainValue(record.value);
    const attributes = record.attributes;
    if (attributes && typeof attributes === "object") {
      const named = attributes as Record<string, unknown>;
      for (const key of ["name", "label", "title", "value"])
        if (named[key] !== undefined) return plainValue(named[key]);
    }
    for (const key of ["name", "label", "title"])
      if (record[key] !== undefined) return plainValue(record[key]);
    return JSON.stringify(value);
  }
  return String(value);
}

const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per person, one column per attribute (by its label), plain values. */
export function employeesCsv(attributes: Attribute[], employees: Employee[]): string {
  const keys = new Set(attributes.map((attribute) => attribute.key));
  for (const employee of employees) for (const key of Object.keys(employee.attributes)) keys.add(key);
  const labels = new Map(attributes.map((attribute) => [attribute.key, attribute.label || attribute.key]));
  const columns = ["id", ...[...keys].filter((key) => key !== "id")];
  const header = columns.map((key) => csvCell(key === "id" ? "ID" : (labels.get(key) ?? key)));
  const rows = employees.map((employee) =>
    columns.map((key) => csvCell(key === "id" ? employee.id : plainValue(employee.attributes[key]))),
  );
  // A byte order mark lets spreadsheet programs read the file as UTF-8.
  return `\uFEFF${[header, ...rows].map((row) => row.join(",")).join("\r\n")}\r\n`;
}

/** The folder of a person's documents: "<id> <last name>, <first name>". */
export function personFolder(employee: Employee): string {
  const first = String(plainValue(employee.attributes.first_name) || "");
  const last = String(plainValue(employee.attributes.last_name) || "");
  const name = [last, first].filter(Boolean).join(", ");
  return folderName(name ? `${employee.id} ${name}` : employee.id);
}

function clientOf(source: SourceRow, signal?: AbortSignal, fetchImpl?: typeof fetch) {
  const settings = source.config as PersonioConfig;
  return new PersonioClient(
    {
      baseUrl: settings.baseUrl.replace(/\/+$/, ""),
      clientId: settings.clientId,
      clientSecret: sourceSecret(source, "clientSecret"),
    },
    signal,
    fetchImpl,
  );
}

export async function testPersonio(source: SourceRow, fetchImpl?: typeof fetch): Promise<SourceTest> {
  try {
    const client = clientOf(source, AbortSignal.timeout(120_000), fetchImpl);
    const attributes = await client.attributes();
    const employees = await client.employees(["first_name"]);
    let message = `Personio answers: ${employees.length} people, ${attributes.length} readable attributes.`;
    if ((source.config as PersonioConfig).documents && employees[0]) {
      try {
        await client.documents(employees[0].id);
        message += " Documents can be listed.";
      } catch (error) {
        message += ` Documents: ${error instanceof Error ? error.message : "not readable"}.`;
      }
    }
    return { ok: true, message, items: employees.length, bytes: null, freeBytes: null };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Personio could not be reached",
      items: null,
      bytes: null,
      freeBytes: null,
    };
  }
}

export type ExportResult = { warnings: string[]; errors: string[]; people: number; documents: number };

/** Writes the export into the source's local copy. Throws when the people cannot be read. */
export async function exportPersonio(
  source: SourceRow,
  options: { signal: AbortSignal; log: (line: string) => Promise<void>; fetchImpl?: typeof fetch },
): Promise<ExportResult> {
  const settings = source.config as PersonioConfig;
  const client = clientOf(source, options.signal, options.fetchImpl);
  const root = stagingDir(source.id);
  await mkdir(root, { recursive: true });
  const warnings: string[] = [];
  const errors: string[] = [];

  const attributes = await client.attributes();
  const employees = await client.employees(attributes.map((attribute) => attribute.key));
  await options.log(`${employees.length} people, ${attributes.length} attributes`);
  await writeFile(path.join(root, "attributes.json"), JSON.stringify(attributes, null, 2));
  await writeFile(path.join(root, "employees.json"), JSON.stringify(employees, null, 2));
  await writeFile(path.join(root, "employees.csv"), employeesCsv(attributes, employees));

  let documents = 0;
  const documentsRoot = path.join(root, "documents");
  if (settings.documents) {
    try {
      await writeFile(
        path.join(root, "document-categories.json"),
        JSON.stringify(await client.documentCategories(), null, 2),
      );
    } catch (error) {
      warnings.push(`Document categories: ${error instanceof Error ? error.message : "not readable"}`);
    }
    await mkdir(documentsRoot, { recursive: true });
    const folders = new Set<string>();
    let refused = 0;
    for (const employee of employees) {
      options.signal.throwIfAborted();
      const folder = personFolder(employee);
      folders.add(folder);
      const directory = path.join(documentsRoot, folder);
      let list: DocumentItem[];
      try {
        list = await client.documents(employee.id);
      } catch (error) {
        if (error instanceof PersonioError && (error.status === 401 || error.status === 403)) refused += 1;
        errors.push(`${employee.id}: ${error instanceof Error ? error.message : "documents not listed"}`);
        if (refused >= 3 && refused === errors.length) {
          warnings.push(
            "Personio refused to list documents: give the API credential read access to documents",
          );
          break;
        }
        continue;
      }
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "documents.json"), JSON.stringify(list, null, 2));
      const files = new Set(["documents.json"]);
      for (const item of list) {
        const file = folderName(`${item.id} ${item.name}`) || item.id;
        files.add(file);
        const target = path.join(directory, file);
        const existing = await stat(target).catch(() => null);
        if (existing && (item.size === null || existing.size === item.size)) {
          documents += 1;
          continue;
        }
        const response = await client.download(item.id);
        if (!response.ok) {
          await response.body?.cancel();
          errors.push(
            `${employee.id}/${item.id}: ${response.status === 409 ? "Personio marked the file unsafe" : `HTTP ${response.status}`}`,
          );
          continue;
        }
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        documents += 1;
      }
      for (const entry of await readdir(directory)) {
        if (!files.has(entry)) await rm(path.join(directory, entry), { force: true });
      }
    }
    // People who are no longer in Personio leave the copy (earlier snapshots keep them).
    if (errors.length === 0) {
      for (const entry of await readdir(documentsRoot)) {
        if (!folders.has(entry)) await rm(path.join(documentsRoot, entry), { recursive: true, force: true });
      }
    }
    if (errors.length > 0) warnings.push(`${errors.length} document(s) or lists could not be read`);
    await options.log(`${documents} documents`);
  } else {
    await rm(documentsRoot, { recursive: true, force: true });
  }
  await writeFile(
    path.join(root, "export.json"),
    JSON.stringify(
      {
        format: 1,
        exportedAt: new Date().toISOString(),
        baseUrl: settings.baseUrl,
        people: employees.length,
        attributes: attributes.length,
        documents: settings.documents ? documents : null,
        problems: errors.length,
      },
      null,
      2,
    ),
  );
  return { warnings, errors, people: employees.length, documents };
}
