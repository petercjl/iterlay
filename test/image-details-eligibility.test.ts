import { describe, expect, it } from "vitest";
import { canViewImageDetails, type GeneratedImage } from "../src/components/canvas/image-node-model";

const image: GeneratedImage = { id: "image", path: "/image.png", dataUrl: "", jobId: "job-1", source: "generated" };

describe("canvas generation details eligibility", () => {
  it("allows completed generated images and legacy generated nodes", () => {
    expect(canViewImageDetails(image)).toBe(true);
    expect(canViewImageDetails({ ...image, source: undefined })).toBe(true);
  });
  it("excludes uploads and slices even when they carry an import job ID", () => {
    expect(canViewImageDetails({ ...image, source: "upload", jobId: "upload-1" })).toBe(false);
    expect(canViewImageDetails({ ...image, source: "slice" })).toBe(false);
  });
  it("excludes incomplete generation nodes", () => {
    expect(canViewImageDetails({ ...image, pending: true })).toBe(false);
    expect(canViewImageDetails({ ...image, jobId: "" })).toBe(false);
  });
});
