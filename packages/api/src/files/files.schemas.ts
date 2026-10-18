import { posix } from "node:path";
import { z } from "zod";
import { FilesError } from "./files-error.js";

export function cleanFilesPath(rawPath: unknown, allowRoot = false): string {
  if (typeof rawPath !== "string") {
    throw new FilesError("INVALID_PATH", "Path must be a string");
  }
  if (rawPath.length === 0 || Buffer.byteLength(rawPath, "utf8") > 4096) {
    throw new FilesError("INVALID_PATH", "Path exceeds maximum length of 4096 bytes");
  }
  if (!rawPath.startsWith("/") || rawPath.includes("\0")) {
    throw new FilesError("INVALID_PATH", "Path must be an absolute POSIX path without null bytes");
  }
  const normalized = posix.normalize(rawPath);
  if (!normalized.startsWith("/")) {
    throw new FilesError("INVALID_PATH", "Path must be absolute");
  }
  if (normalized === "/" && !allowRoot) {
    throw new FilesError("INVALID_PATH", "Root path cannot be modified or downloaded");
  }
  return normalized;
}

export const directoryBodySchema = z.object({
  path: z.string().transform((val) => cleanFilesPath(val, false)),
});

export const renameBodySchema = z
  .object({
    path: z.string().transform((val) => cleanFilesPath(val, false)),
    newPath: z.string().transform((val) => cleanFilesPath(val, false)),
  })
  .refine(
    (data) => {
      if (data.newPath.startsWith(data.path + "/")) {
        return false;
      }
      return true;
    },
    {
      message: "Cannot move directory into itself",
      path: ["newPath"],
    },
  );
