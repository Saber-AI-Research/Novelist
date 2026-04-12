import { describe, it, expect } from "vitest";

// Test the heading text extraction regex used in outline.ts
// The actual extractHeadings requires CM6 syntaxTree (browser-only),
// so we test the core regex logic independently.
const extractText = (line: string) => line.replace(/^#+\s*/, "").trim();
const matchHeading = (name: string) => name.match(/^ATXHeading(\d)$/);

describe("outline heading regex", () => {
  it("extracts text from H1", () => {
    expect(extractText("# Title")).toBe("Title");
  });

  it("extracts text from H2", () => {
    expect(extractText("## Section")).toBe("Section");
  });

  it("extracts text from H3-H6", () => {
    expect(extractText("### Sub")).toBe("Sub");
    expect(extractText("#### Deep")).toBe("Deep");
    expect(extractText("##### Deeper")).toBe("Deeper");
    expect(extractText("###### Deepest")).toBe("Deepest");
  });

  it("handles extra spaces after #", () => {
    expect(extractText("#   Title")).toBe("Title");
  });

  it("handles no space after # (not valid MD but robust)", () => {
    expect(extractText("#Title")).toBe("Title");
  });

  it("preserves inline formatting", () => {
    expect(extractText("# Hello **World**")).toBe("Hello **World**");
  });

  it("handles CJK headings", () => {
    expect(extractText("# 第一章 开始")).toBe("第一章 开始");
  });

  it("returns empty for marker-only line", () => {
    expect(extractText("###")).toBe("");
  });

  it("matches ATXHeading node names", () => {
    expect(matchHeading("ATXHeading1")).toEqual(expect.arrayContaining(["ATXHeading1", "1"]));
    expect(matchHeading("ATXHeading6")).toEqual(expect.arrayContaining(["ATXHeading6", "6"]));
    expect(matchHeading("Paragraph")).toBeNull();
    // ATXHeading7+ won't exist in practice (Lezer only emits 1-6)
    // but the regex itself matches any digit
    expect(matchHeading("ATXHeading7")).not.toBeNull();
  });

  it("parses level from ATXHeading match", () => {
    const m = matchHeading("ATXHeading3");
    expect(m).not.toBeNull();
    expect(parseInt(m![1])).toBe(3);
  });
});
