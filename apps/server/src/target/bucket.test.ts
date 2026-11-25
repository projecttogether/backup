import { describe, expect, it } from "vitest";
import { parseLifecycle, parseObjectLock, parseVersioning } from "./bucket";

describe("bucket settings", () => {
  it("reads versioning", () => {
    expect(
      parseVersioning("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>"),
    ).toBe("enabled");
    expect(parseVersioning("<VersioningConfiguration/>")).toBe("off");
  });

  it("reads Object Lock with its default retention in days or years", () => {
    const xml = (retention: string) =>
      `<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode>${retention}</DefaultRetention></Rule></ObjectLockConfiguration>`;
    expect(parseObjectLock(xml("<Days>30</Days>"))).toEqual({ enabled: true, mode: "COMPLIANCE", days: 30 });
    expect(parseObjectLock(xml("<Years>1</Years>"))).toEqual({
      enabled: true,
      mode: "COMPLIANCE",
      days: 365,
    });
  });

  it("reads the lifecycle rules for the whole bucket (Hetzner: NoncurrentDays only)", () => {
    const xml = `<LifecycleConfiguration>
      <Rule><ID>a</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter>
        <NoncurrentVersionExpiration><NoncurrentDays>31</NoncurrentDays></NoncurrentVersionExpiration>
        <AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule>
      <Rule><ID>b</ID><Status>Enabled</Status><Prefix></Prefix><Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration></Rule>
      <Rule><ID>c</ID><Status>Disabled</Status><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionExpiration></Rule>
      <Rule><ID>d</ID><Status>Enabled</Status><Filter><Prefix>logs/</Prefix></Filter><NoncurrentVersionExpiration><NoncurrentDays>2</NoncurrentDays></NoncurrentVersionExpiration></Rule>
    </LifecycleConfiguration>`;
    expect(parseLifecycle(xml)).toEqual({
      noncurrentDays: 31,
      expiredDeleteMarkers: true,
      abortMultipartDays: 7,
    });
    expect(parseLifecycle("<LifecycleConfiguration/>")).toEqual({
      noncurrentDays: null,
      expiredDeleteMarkers: false,
      abortMultipartDays: null,
    });
  });
});
