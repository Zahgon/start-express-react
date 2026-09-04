/*
  Purpose:
  Provide reusable multipart file upload preHandler factory for Fastify modules.

  Related docs:
  - https://github.com/fastify/fastify-multipart
*/

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { preHandlerAsyncHookHandler } from "fastify";

export interface UploaderOptions {
  subfolder: string;
  maxSizeBytes?: number;
  allowedMimeTypes?: string[];
}

/*
  Shape of the file attached to the request once it has been persisted.
  Mirrors the subset of the uploaded-file object the app relies on.
*/
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  filename: string;
  path: string;
}

/*
  Extend FastifyRequest to carry the persisted file.

  NOTE:
  `request.file` is already owned by @fastify/multipart (it is the async
  accessor returning the next multipart part), so the persisted file is exposed
  under `request.uploadedFile`.
*/
declare module "fastify" {
  interface FastifyRequest {
    uploadedFile?: UploadedFile;
  }
}

const MIME_TO_EXTENSION = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

const DEFAULT_OPTIONS: Required<Omit<UploaderOptions, "subfolder">> = {
  maxSizeBytes: 2 * 1024 * 1024, // 2MB
  allowedMimeTypes: Array.from(MIME_TO_EXTENSION.keys()),
};

export const createUploader = (options: UploaderOptions) => {
  const { subfolder, allowedMimeTypes, maxSizeBytes } = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const destDir = path.join(
    import.meta.dirname,
    "../../../data/uploads",
    subfolder,
  );

  fs.mkdirSync(destDir, { recursive: true });

  return {
    /*
      single(fieldName)

      Returns a preHandler hook streaming the first file of `fieldName` to disk.

      Behavior:
      - Non-multipart requests are left untouched (request.uploadedFile stays
        undefined)
      - Rejected mime types raise a 400 error, drained first so the connection
        is not left half-read
      - Oversized files are discarded and raise a 400 error
    */
    single:
      (fieldName: string): preHandlerAsyncHookHandler =>
      async (request) => {
        if (!request.isMultipart()) {
          return;
        }

        const part = await request.file({
          limits: { fileSize: maxSizeBytes, files: 1 },
        });

        if (part == null || part.fieldname !== fieldName) {
          return;
        }

        if (!allowedMimeTypes.includes(part.mimetype)) {
          // Drain the discarded part so busboy can finish parsing.
          await new Promise((resolve) => {
            part.file.on("end", resolve);
            part.file.resume();
          });

          const error: Error & { status?: number } = new Error(
            `Invalid file type: ${part.mimetype}. Allowed types: ${allowedMimeTypes.join(", ")}`,
          );

          // Attach status code for the application error handler
          error.status = 400;

          throw error;
        }

        const ext =
          MIME_TO_EXTENSION.get(part.mimetype) ??
          path.extname(part.filename).toLowerCase();

        const filename = `${crypto.randomUUID()}${ext}`;
        const filePath = path.join(destDir, filename);

        try {
          await pipeline(part.file, fs.createWriteStream(filePath));
        } catch (error) {
          // Remove the partially written file before bubbling the error up.
          fs.rmSync(filePath, { force: true });

          throw error;
        }

        /*
          busboy silently truncates a file once `limits.fileSize` is reached,
          so the flag has to be checked explicitly to reproduce multer's
          LIMIT_FILE_SIZE behavior.
        */
        if (part.file.truncated) {
          fs.rmSync(filePath, { force: true });

          const error: Error & { status?: number } = new Error(
            `File too large. Maximum allowed size: ${maxSizeBytes} bytes`,
          );

          error.status = 400;

          throw error;
        }

        request.uploadedFile = {
          fieldname: part.fieldname,
          originalname: part.filename,
          mimetype: part.mimetype,
          filename,
          path: filePath,
        };
      },
  };
};

export const deleteUploadedFile = (relativeUrl?: string | null): void => {
  if (!relativeUrl?.startsWith("/uploads/")) return;

  const filePath = path.join(import.meta.dirname, "../../../data", relativeUrl);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};
