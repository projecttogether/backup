import { afterEach, describe, expect, it } from "vitest";
import { config, resetConfigForTests } from "./config";

const original = { ...process.env };

function configWith(values: Record<string, string>) {
  Object.assign(process.env, values);
  resetConfigForTests();
  return () => config();
}

describe("config", () => {
  afterEach(() => {
    process.env = { ...original };
    resetConfigForTests();
  });

  it("refuses the example secrets when the app is in use (https or production)", () => {
    const example = "development-secret-development-secret";
    const exampleKey = "ZGV2ZWxvcG1lbnQta2V5LWRldmVsb3BtZW50LWtleSE=";
    expect(
      configWith({ AUTH_SECRET: example, ENCRYPTION_KEY: exampleKey, NODE_ENV: "development" }),
    ).not.toThrow();
    expect(
      configWith({ AUTH_SECRET: example, NODE_ENV: "development", APP_URL: "https://backup.example.org" }),
    ).toThrow(/AUTH_SECRET: Replace the example value/);
    expect(
      configWith({ ENCRYPTION_KEY: exampleKey, NODE_ENV: "production", APP_URL: "http://localhost:3000" }),
    ).toThrow(/ENCRYPTION_KEY: Replace the example value/);
  });

  it("needs a 32-byte encryption key", () => {
    expect(configWith({ ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") })).toThrow(
      /ENCRYPTION_KEY: Must be 32 bytes/,
    );
  });

  it("reads the admins by address and by group", () => {
    const settings = configWith({
      ADMIN_EMAILS: " Ada@Example.org , grace@example.org",
      ADMIN_GROUPS: "/it, /backup-admins",
    })();
    expect(settings.adminEmails).toEqual(["ada@example.org", "grace@example.org"]);
    expect(settings.adminGroups).toEqual(["/it", "/backup-admins"]);
    expect(configWith({ ADMIN_EMAILS: "not-an-address" })).toThrow(/Not an email address/);
  });

  it("checks the time zone", () => {
    expect(configWith({ TZ: "Europe/Berlin" })().TZ).toBe("Europe/Berlin");
    expect(configWith({ TZ: "Mars/Olympus" })).toThrow(/Not a time zone/);
  });
});
