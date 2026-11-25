import { describe, expect, it } from "vitest";
import { remoteOf } from "./s3-bucket";

const config = {
  endpoint: "https://fsn1.your-objectstorage.com",
  region: "fsn1",
  bucket: "acme-media",
  prefix: "originals",
  accessKeyId: "MEDIAREAD",
};

describe("S3 bucket", () => {
  it("defines the remote only in rclone's environment, with the bucket and folder as its path", () => {
    const remote = remoteOf({ config }, "media-secret");
    expect(remote.env).toEqual({
      RCLONE_CONFIG_S3SOURCE_TYPE: "s3",
      RCLONE_CONFIG_S3SOURCE_PROVIDER: "Other",
      RCLONE_CONFIG_S3SOURCE_ENDPOINT: "https://fsn1.your-objectstorage.com",
      RCLONE_CONFIG_S3SOURCE_REGION: "fsn1",
      RCLONE_CONFIG_S3SOURCE_ACCESS_KEY_ID: "MEDIAREAD",
      RCLONE_CONFIG_S3SOURCE_SECRET_ACCESS_KEY: "media-secret",
    });
    expect(remote.path).toBe("s3source:acme-media/originals/");
    expect(remoteOf({ config: { ...config, region: "", prefix: "" } }, "x")).toMatchObject({
      path: "s3source:acme-media",
      env: expect.not.objectContaining({ RCLONE_CONFIG_S3SOURCE_REGION: expect.anything() }),
    });
  });
});
