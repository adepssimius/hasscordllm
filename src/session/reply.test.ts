import { describe, expect, it } from "vitest";
import { replyText } from "./manager.js";

describe("replyText", () => {
  it("keeps the answer when the turn ends with housekeeping", () => {
    // The first real thread: the answer, then a house-notes edit, then a
    // sign-off. The SDK's `result` is only the sign-off.
    const blocks = [
      "**The car is at 49%**, about 133 miles of range.",
      "Noted the naming in the house notes so next time I don't have to hunt for it.",
    ];
    const out = replyText(blocks, blocks[1]!);
    expect(out).toContain("49%");
    expect(out.indexOf("49%")).toBeLessThan(out.indexOf("Noted"));
  });

  it("separates blocks as paragraphs and skips empty ones", () => {
    expect(replyText(["One.", "  ", "Two."], "Two.")).toBe("One.\n\nTwo.");
  });

  it("falls back to the result when no text blocks were seen", () => {
    expect(replyText([], "only the result")).toBe("only the result");
  });
});
