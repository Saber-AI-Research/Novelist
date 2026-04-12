import { describe, it, expect } from "vitest";
import { classifyFileSize, FileSize } from "$lib/editor/large-file";

describe("classifyFileSize", () => {
  it("classifies small files as Normal", () => {
    expect(classifyFileSize(0)).toBe(FileSize.Normal);
    expect(classifyFileSize(100)).toBe(FileSize.Normal);
    expect(classifyFileSize(512 * 1024)).toBe(FileSize.Normal);
    expect(classifyFileSize(1024 * 1024 - 1)).toBe(FileSize.Normal);
  });

  it("classifies 1MB boundary as Normal", () => {
    expect(classifyFileSize(1024 * 1024)).toBe(FileSize.Normal);
  });

  it("classifies 1-10MB as Large", () => {
    expect(classifyFileSize(1024 * 1024 + 1)).toBe(FileSize.Large);
    expect(classifyFileSize(5 * 1024 * 1024)).toBe(FileSize.Large);
    expect(classifyFileSize(10 * 1024 * 1024)).toBe(FileSize.Large);
  });

  it("classifies >10MB as Huge", () => {
    expect(classifyFileSize(10 * 1024 * 1024 + 1)).toBe(FileSize.Huge);
    expect(classifyFileSize(100 * 1024 * 1024)).toBe(FileSize.Huge);
  });
});
