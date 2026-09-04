/*
  Purpose:
  Unit tests for the helpers exposed by upload.ts.

  Strategy:
  - Spy on node:fs to control existsSync / unlinkSync behaviour
  - Test all branches: early return, file missing, file present
  - Drive the uploader preHandler with a failing multipart stream to cover the
    partial-file cleanup path
*/

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createUploader,
  deleteUploadedFile,
} from "../../../src/fastify/helpers/upload";

describe("deleteUploadedFile", () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let unlinkSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    unlinkSyncSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when relativeUrl is undefined", () => {
    deleteUploadedFile(undefined);

    expect(existsSyncSpy).not.toHaveBeenCalled();
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });

  it("does nothing when relativeUrl is null", () => {
    deleteUploadedFile(null);

    expect(existsSyncSpy).not.toHaveBeenCalled();
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });

  it("does nothing when relativeUrl does not start with /uploads/", () => {
    deleteUploadedFile("/other/path/file.png");

    expect(existsSyncSpy).not.toHaveBeenCalled();
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });

  it("does not call unlinkSync when the file does not exist", () => {
    existsSyncSpy.mockReturnValue(false);

    deleteUploadedFile("/uploads/avatars/some-uuid.webp");

    expect(existsSyncSpy).toHaveBeenCalledOnce();
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });

  it("calls unlinkSync when the file exists", () => {
    existsSyncSpy.mockReturnValue(true);

    deleteUploadedFile("/uploads/avatars/some-uuid.webp");

    expect(existsSyncSpy).toHaveBeenCalledOnce();
    expect(unlinkSyncSpy).toHaveBeenCalledOnce();
    expect(unlinkSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining("/uploads/avatars/some-uuid.webp"),
    );
  });
});

describe("createUploader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the partially written file when the upload stream fails", async () => {
    const uploader = createUploader({ subfolder: "avatars" });

    const part = {
      fieldname: "avatar",
      filename: "avatar.webp",
      mimetype: "image/webp",
      file: new Readable({
        read() {
          this.destroy(new Error("stream failure"));
        },
      }),
    };

    const request = {
      isMultipart: () => true,
      file: async () => part,
    };

    const rmSyncSpy = vi.spyOn(fs, "rmSync");

    const convert = uploader.single("avatar");

    await expect(
      convert.call(undefined as never, request as never, undefined as never),
    ).rejects.toThrow("stream failure");

    expect(rmSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.join("uploads", "avatars")),
      { force: true },
    );
  });

  it("ignores requests that are not multipart", async () => {
    const uploader = createUploader({ subfolder: "avatars" });

    const request = { isMultipart: () => false };

    const convert = uploader.single("avatar");

    await expect(
      convert.call(undefined as never, request as never, undefined as never),
    ).resolves.toBeUndefined();
  });
});
