import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config";
import { encryptSecret } from "../core/crypto";
import { employeesCsv, exportPersonio, personFolder, plainValue } from "./personio";
import type { SourceRow } from "./service";

/** A stand-in for Personio's API: v2 token, v1 attributes and employees, v2 documents. */
function fakePersonio(options: {
  documents: Record<string, { id: number; name: string; body: string }[]>;
  refuseDocs?: boolean;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v2/auth/token") {
      const form = new URLSearchParams(String(init?.body));
      return form.get("client_secret") === "secret"
        ? json({ access_token: "papi-token" })
        : json({ error: "invalid_client" }, 401);
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer papi-token");
    expect(new Headers(init?.headers).get("x-personio-app-id")).toBe("PT_BACKUP");
    if (url.pathname === "/v1/company/employees/attributes") {
      return json({
        data: [
          { key: "first_name", label: "First name" },
          { key: "last_name", label: "Last name" },
          { key: "department", label: "Department" },
        ],
      });
    }
    if (url.pathname === "/v1/company/employees") {
      const offset = Number(url.searchParams.get("offset"));
      const people = [
        {
          id: { value: 7 },
          first_name: { value: "Ada" },
          last_name: { value: "Lovelace" },
          department: { value: { type: "Department", attributes: { name: "Research" } } },
        },
        {
          id: { value: 9 },
          first_name: { value: "Grace" },
          last_name: { value: "Hopper" },
          department: { value: null },
        },
      ];
      return json({
        data: offset === 0 ? people.map((attributes) => ({ type: "Employee", attributes })) : [],
        metadata: { total_elements: 2 },
      });
    }
    if (url.pathname === "/v1/company/document-categories")
      return json({ data: [{ id: 1, attributes: { name: "Contracts" } }] });
    if (url.pathname === "/v2/document-management/documents") {
      if (options.refuseDocs) return json({}, 403);
      const owner = url.searchParams.get("owner_id")!;
      const list = options.documents[owner] ?? [];
      // Page by page: the next link leaves out owner_id, as Personio's examples do.
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      return json({
        _data: list
          .slice(cursor, cursor + 1)
          .map((item) => ({ id: item.id, name: item.name, size: item.body.length })),
        _meta: {
          links:
            cursor + 1 < list.length
              ? { next: { href: `/v2/document-management/documents?cursor=${cursor + 1}` } }
              : {},
        },
      });
    }
    const download = /^\/v2\/document-management\/documents\/(\d+)\/download$/.exec(url.pathname);
    if (download) {
      expect(new Headers(init?.headers).get("accept")).toBe("*/*");
      const item = Object.values(options.documents)
        .flat()
        .find((entry) => String(entry.id) === download[1]);
      return item ? new Response(item.body) : json({}, 404);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let dataDir: string;
const source = (documents = true) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    config: { baseUrl: "https://api.personio.test", clientId: "client", documents },
    secrets: { clientSecret: encryptSecret("secret") },
  }) as unknown as SourceRow;

describe("the Personio export", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "backups-personio-"));
    process.env.DATA_DIR = dataDir;
    resetConfigForTests();
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("writes people, attributes and documents, and downloads each document once", async () => {
    const documents = {
      "7": [
        { id: 101, name: "Contract.pdf", body: "contract" },
        { id: 102, name: "Payslip 2026/10.pdf", body: "payslip" },
      ],
    };
    const fake = fakePersonio({ documents });
    const log: string[] = [];
    const options = {
      signal: new AbortController().signal,
      log: async (line: string) => void log.push(line),
      fetchImpl: fake.fetchImpl,
    };
    const result = await exportPersonio(source(), options);
    expect(result).toMatchObject({ people: 2, documents: 2, warnings: [], errors: [] });

    const root = path.join(dataDir, "staging", source().id);
    expect((await readdir(root)).sort()).toEqual(
      [
        "attributes.json",
        "document-categories.json",
        "documents",
        "employees.csv",
        "employees.json",
        "export.json",
      ].sort(),
    );
    const csv = await readFile(path.join(root, "employees.csv"), "utf8");
    expect(csv).toBe("﻿ID,First name,Last name,Department\r\n7,Ada,Lovelace,Research\r\n9,Grace,Hopper,\r\n");
    const ada = path.join(root, "documents", "7 Lovelace, Ada");
    expect((await readdir(ada)).sort()).toEqual([
      "101 Contract.pdf",
      "102 Payslip 2026 10.pdf",
      "documents.json",
    ]);
    expect(await readFile(path.join(ada, "101 Contract.pdf"), "utf8")).toBe("contract");

    // The second run downloads nothing again; a document gone in Personio leaves the copy.
    fake.calls.length = 0;
    documents["7"].pop();
    await exportPersonio(source(), options);
    expect(fake.calls.filter((call) => call.includes("/download"))).toEqual([]);
    expect((await readdir(ada)).sort()).toEqual(["101 Contract.pdf", "documents.json"]);
  });

  it("goes on without documents when Personio refuses them, with a warning", async () => {
    const fake = fakePersonio({ documents: {}, refuseDocs: true });
    const result = await exportPersonio(source(), {
      signal: new AbortController().signal,
      log: async () => undefined,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.people).toBe(2);
    expect(result.warnings.join(" ")).toMatch(/could not be read/);
  });

  it("never empties a person's copy when Personio answers without the list", async () => {
    const documents = { "7": [{ id: 101, name: "Contract.pdf", body: "contract" }] };
    const fake = fakePersonio({ documents });
    const options = {
      signal: new AbortController().signal,
      log: async () => undefined,
      fetchImpl: fake.fetchImpl,
    };
    await exportPersonio(source(), options);
    const broken = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/v2/document-management/documents?")
        ? new Response(JSON.stringify({ unexpected: true }), {
            headers: { "content-type": "application/json" },
          })
        : fake.fetchImpl(input, init)) as typeof fetch;
    const result = await exportPersonio(source(), { ...options, fetchImpl: broken });
    expect(result.warnings.join(" ")).toMatch(/could not be read/);
    const ada = path.join(dataDir, "staging", source().id, "documents", "7 Lovelace, Ada");
    expect(await readdir(ada)).toContain("101 Contract.pdf");
  });

  it("fails when the credential is wrong", async () => {
    const fake = fakePersonio({ documents: {} });
    const wrong = source();
    wrong.secrets = { clientSecret: encryptSecret("wrong") };
    await expect(
      exportPersonio(wrong, {
        signal: new AbortController().signal,
        log: async () => undefined,
        fetchImpl: fake.fetchImpl,
      }),
    ).rejects.toThrow(/refused the client ID or secret/);
  });

  it("reads Personio's value shapes", () => {
    expect(plainValue({ value: "Ada" })).toBe("Ada");
    expect(plainValue({ value: { type: "Department", attributes: { name: "Research" } } })).toBe("Research");
    expect(plainValue({ value: [{ attributes: { name: "A" } }, { attributes: { name: "B" } }] })).toBe(
      "A; B",
    );
    expect(plainValue({ value: null })).toBe("");
    expect(
      employeesCsv(
        [{ key: "note", label: "Note" }],
        [{ id: "1", attributes: { note: { value: 'Says "hi", twice' } } }],
      ),
    ).toContain('"Says ""hi"", twice"');
    expect(
      personFolder({ id: "3", attributes: { first_name: { value: "A/B" }, last_name: { value: "C" } } }),
    ).toBe("3 C, A B");
  });
});
