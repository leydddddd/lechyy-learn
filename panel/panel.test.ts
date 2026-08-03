import { describe, expect, it } from "vitest";
import { hidePanel, isPanelActive } from "./index";

describe("panel lifecycle", () => {
  it("starts inactive", () => {
    hidePanel(); // cleanup any residual state
    expect(isPanelActive()).toBe(false);
  });

  it("hidePanel returns false and leaves inactive state", () => {
    expect(hidePanel()).toBe(false);
    expect(isPanelActive()).toBe(false);
  });

  it("multiple hidePanel calls are safe", () => {
    hidePanel();
    hidePanel();
    hidePanel();
    expect(isPanelActive()).toBe(false);
  });
});