import { describe, it, expect } from "vitest";
import { countWords } from "$lib/utils/wordcount";

describe("countWords", () => {
  // Empty / whitespace
  it("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("returns 0 for whitespace only", () => {
    expect(countWords("   \n\t  ")).toBe(0);
  });

  // Latin text
  it("counts single word", () => {
    expect(countWords("hello")).toBe(1);
  });

  it("counts multiple words", () => {
    expect(countWords("hello world foo bar")).toBe(4);
  });

  it("handles extra whitespace between words", () => {
    expect(countWords("  hello   world  ")).toBe(2);
  });

  it("handles newlines as word separators", () => {
    expect(countWords("hello\nworld\nfoo")).toBe(3);
  });

  it("handles tabs as word separators", () => {
    expect(countWords("hello\tworld")).toBe(2);
  });

  // CJK text
  it("counts each CJK character as 1 word", () => {
    expect(countWords("你好世界")).toBe(4);
  });

  it("counts Japanese characters", () => {
    expect(countWords("東京都")).toBe(3);
  });

  it("counts fullwidth punctuation as CJK", () => {
    // Fullwidth chars are in the CJK regex range
    expect(countWords("，。！")).toBe(3);
  });

  // Mixed content
  it("counts mixed CJK and Latin", () => {
    expect(countWords("Hello 你好 World 世界")).toBe(6);
    // "Hello" (1) + "你好" (2) + "World" (1) + "世界" (2) = 6
  });

  it("counts CJK adjacent to Latin", () => {
    // CJK chars (你好 = 2) removed, remaining "hello world" split by space = 2 latin words
    // Total = 2 CJK + 2 latin = 4
    expect(countWords("hello你好world")).toBe(4);
  });

  // Markdown content
  it("counts words in markdown heading", () => {
    expect(countWords("# Chapter One")).toBe(3);
  });

  it("counts words in markdown paragraph", () => {
    expect(countWords("The quick brown fox **jumps** over the lazy dog.")).toBe(9);
  });

  it("counts words across multiple markdown lines", () => {
    const md = `# Title

First paragraph here.

Second paragraph here.`;
    // "#" (1) + "Title" (1) + "First" (1) + "paragraph" (1) + "here." (1) +
    // "Second" (1) + "paragraph" (1) + "here." (1) = 8
    expect(countWords(md)).toBe(8);
  });

  // CJK novel content
  it("counts typical Chinese novel paragraph", () => {
    const text = "落霞与孤鹜齐飞，秋水共长天一色。";
    // 14 CJK chars + 2 punctuation (，。) = 16
    expect(countWords(text)).toBe(16);
  });

  // Edge cases
  it("handles single character", () => {
    expect(countWords("a")).toBe(1);
  });

  it("handles single CJK character", () => {
    expect(countWords("字")).toBe(1);
  });

  it("handles numbers as words", () => {
    expect(countWords("chapter 1 section 2")).toBe(4);
  });

  it("handles hyphenated words as one", () => {
    expect(countWords("well-known")).toBe(1);
  });
});
