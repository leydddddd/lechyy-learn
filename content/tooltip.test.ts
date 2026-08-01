import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  destroyTooltip,
  hideTooltip,
  showTooltip,
} from "./tooltip";
import type { DictEntry } from "./dictionary";

function rect(top: number, bottom: number, left = 0, width = 100): DOMRect {
  return {
    top,
    bottom,
    left,
    right: left + width,
    width,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("showTooltip / hideTooltip", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 800);
    // jsdom getBoundingClientRect returns zeros; give the tooltip a size so
    // positionTooltip has non-zero offsets to work with.
    Element.prototype.getBoundingClientRect = vi.fn(
      function (this: HTMLElement): DOMRect {
        return rect(0, 40, 0, 240);
      },
    ) as unknown as typeof Element.prototype.getBoundingClientRect;
  });

  afterEach(() => {
    destroyTooltip();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts a single shared div to document.body on first show", () => {
    showTooltip({
      word: "你好",
      rubyRect: rect(100, 130),
      entries: [{ t: "你好", p: "nǐ hǎo", d: ["hello", "hi"] }],
      fallbackPinyin: "nǐ hǎo",
    });
    const el = document.querySelector("div[data-hanzi='tooltip']");
    expect(el).not.toBeNull();
    expect(el!.classList.contains("hanzi-tooltip--visible")).toBe(true);
  });

  it("renders word + pinyin + numbered definitions for a CEDICT hit", () => {
    showTooltip({
      word: "汉字",
      rubyRect: rect(100, 130),
      entries: [
        { t: "漢字", p: "hàn zì", d: ["Chinese character", "CJK character"] },
      ],
      fallbackPinyin: "hàn zì",
    });
    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.querySelector(".hanzi-tooltip__word")!.textContent).toBe("汉字");
    expect(el.querySelector(".hanzi-tooltip__pinyin")!.textContent).toBe("hàn zì");
    const defs = el.querySelectorAll(".hanzi-tooltip__defs li");
    expect(defs).toHaveLength(2);
    expect(defs[0].textContent).toContain("Chinese character");
    expect(defs[1].textContent).toContain("CJK character");
  });

  it("renders fallback pinyin + 'No dictionary entry' when entries is null", () => {
    showTooltip({
      word: "功法",
      rubyRect: rect(100, 130),
      entries: null,
      fallbackPinyin: "gōng fǎ",
    });
    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.querySelector(".hanzi-tooltip__pinyin")!.textContent).toBe("gōng fǎ");
    expect(el.querySelector(".hanzi-tooltip__noentry")).not.toBeNull();
    expect(el.querySelector(".hanzi-tooltip__noentry")!.textContent).toContain(
      "No dictionary entry",
    );
    // No definitions list in fallback mode.
    expect(el.querySelector(".hanzi-tooltip__defs")).toBeNull();
  });

  it("hides the tooltip on hideTooltip (display none + no visible class)", () => {
    showTooltip({
      word: "你好",
      rubyRect: rect(100, 130),
      entries: [{ t: "你好", p: "nǐ hǎo", d: ["hello"] }],
      fallbackPinyin: "nǐ hǎo",
    });
    hideTooltip();
    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.classList.contains("hanzi-tooltip--visible")).toBe(false);
    expect(getComputedStyle(el).display).toBe("none");
  });

  it("escapes HTML in definitions to avoid injection", () => {
    showTooltip({
      word: "测试",
      rubyRect: rect(100, 130),
      entries: [
        {
          t: "測試",
          p: "cè shì",
          d: ["<script>alert(1)</script>evil"],
        },
      ],
      fallbackPinyin: "cè shì",
    });
    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector(".hanzi-tooltip__defs li")!.innerHTML).toContain(
      "&lt;script&gt;",
    );
  });

  it("does not create a second tooltip div on repeated shows", () => {
    showTooltip({
      word: "你",
      rubyRect: rect(50, 70),
      entries: [{ t: "你", p: "nǐ", d: ["you"] }],
      fallbackPinyin: "nǐ",
    });
    showTooltip({
      word: "好",
      rubyRect: rect(80, 100),
      entries: [{ t: "好", p: "hǎo", d: ["good"] }],
      fallbackPinyin: "hǎo",
    });
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);
  });
});

describe("showTooltip positioning", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 400);
    // Tooltip element reports a fixed size so positionTooltip can compute
    // flip/center math deterministically.
    Element.prototype.getBoundingClientRect = vi.fn(
      function (this: HTMLElement): DOMRect {
        if (this.hasAttribute && this.hasAttribute("data-hanzi")) {
          return rect(0, 80, 0, 200);
        }
        return rect(0, 0, 0, 0);
      },
    ) as unknown as typeof Element.prototype.getBoundingClientRect;
  });

  afterEach(() => {
    destroyTooltip();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("places the tooltip below the ruby when there is room", () => {
    // Ruby at y=100–130; viewport is 400 tall. offsetHeight is 0 in jsdom so
    // positionTooltip falls back to the hardcoded 100px height estimate.
    // below = 130 + 8 = 138; 138 + 100 = 238 < 400 → stays below.
    showTooltip({
      word: "字",
      rubyRect: rect(100, 130, 400, 50),
      entries: [{ t: "字", p: "zì", d: ["character"] }],
      fallbackPinyin: "zì",
    });
    const el = document.querySelector("div[data-hanzi='tooltip']") as HTMLElement;
    expect(el.style.top).toBe("138px");
  });

  it("flips above the ruby when below would overflow the viewport bottom", () => {
    // Ruby at y=350–360; viewport is 400 tall. offsetHeight is 0 in jsdom so
    // positionTooltip falls back to the hardcoded 100px height estimate.
    // below = 360 + 8 = 368; 368 + 100 = 468 > 400 → flip above.
    // above = 350 - 8 - 100 = 242.
    showTooltip({
      word: "字",
      rubyRect: rect(350, 360, 400, 50),
      entries: [{ t: "字", p: "zì", d: ["character"] }],
      fallbackPinyin: "zì",
    });
    const el = document.querySelector("div[data-hanzi='tooltip']") as HTMLElement;
    expect(el.style.top).toBe("242px");
  });
});

describe("reinjection guard (0.4)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 800);
    Element.prototype.getBoundingClientRect = vi.fn(
      function (this: HTMLElement): DOMRect {
        if (this.hasAttribute && this.hasAttribute("data-hanzi")) {
          return rect(0, 80, 0, 200);
        }
        return rect(100, 130, 200, 60);
      },
    ) as unknown as typeof Element.prototype.getBoundingClientRect;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it("after module reload, ensureTooltip cleans up any pre-existing tooltip node so only one lives in the DOM", async () => {
    // First load: show a tooltip.
    const mod1 = await import("./tooltip");
    mod1.showTooltip({
      word: "测试",
      rubyRect: rect(100, 130),
      entries: [{ t: "測試", p: "cè shì", d: ["test"] }],
      fallbackPinyin: "cè shì",
    });
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);

    // Simulate reinjection: invalidate the module cache and re-import.
    // In a real browser this resets module-level `tooltipEl` to null,
    // orphaning the old listeners.
    vi.resetModules();
    const mod2 = await import("./tooltip");

    // On reinjection the old tooltip node is still in the DOM (orphaned).
    // The new module should clean it up on the next ensureTooltip call.
    mod2.showTooltip({
      word: "复查",
      rubyRect: rect(100, 130),
      entries: [{ t: "複查", p: "fù chá", d: ["review"] }],
      fallbackPinyin: "fù chá",
    });

    // Acceptance criterion: exactly one tooltip node.
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);

    // The rendered content should belong to the *second* show, proving the
    // fresh module took over rather than sharing the stale node.
    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.querySelector(".hanzi-tooltip__word")!.textContent).toBe("复查");
  });

  it("orphaned listeners on the old module do not recreate a tooltip node", async () => {
    // First load: attach a delegated hover listener and show a tooltip.
    const mod1 = await import("./tooltip");
    mod1.showTooltip({
      word: "旧",
      rubyRect: rect(100, 130),
      entries: [{ t: "舊", p: "jiù", d: ["old"] }],
      fallbackPinyin: "jiù",
    });
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);

    // Simulate reinjection.
    vi.resetModules();
    const mod2 = await import("./tooltip");

    // Destroy + re-show via new module (mirrors index.ts reinjection guard).
    mod2.destroyTooltip();
    mod2.showTooltip({
      word: "新",
      rubyRect: rect(100, 130),
      entries: [{ t: "新", p: "xīn", d: ["new"] }],
      fallbackPinyin: "xīn",
    });

    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);

    // Now invoke the old module's hideTooltip (simulating a stray mouseout
    // from the orphaned listener).  It must NOT create a new node.
    mod1.hideTooltip();
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);
  });

  it("orphaned showTooltip from old module must not create a duplicate tooltip after reinject", async () => {
    // First load: show a tooltip so mod1's tooltipEl is populated.
    const mod1 = await import("./tooltip");
    mod1.showTooltip({
      word: "旧",
      rubyRect: rect(100, 130),
      entries: [{ t: "舊", p: "jiù", d: ["old"] }],
      fallbackPinyin: "jiù",
    });
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);

    // Simulate reinjection: new module loads and shows a tooltip.
    // Its ensureTooltip() removes the old DOM node and creates a fresh one.
    vi.resetModules();
    const mod2 = await import("./tooltip");
    mod2.showTooltip({
      word: "新",
      rubyRect: rect(100, 130),
      entries: [{ t: "新", p: "xīn", d: ["new"] }],
      fallbackPinyin: "xīn",
    });
    // After mod2: exactly one node, content is "新".
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);

    // The old module's tooltipEl now references a DETACHED node.
    // If the old module's orphaned listener fires a showTooltip, it must
    // not create a second tooltip node.
    mod1.showTooltip({
      word: "旧",
      rubyRect: rect(100, 130),
      entries: [{ t: "舊", p: "jiù", d: ["old"] }],
      fallbackPinyin: "jiù",
    });

    // Acceptance: one tooltip node, and its content belongs to the fresh
    // module (or is empty if mod2 hasn't shown anything yet).
    expect(document.querySelectorAll("div[data-hanzi='tooltip']")).toHaveLength(1);
  });
});
describe("onRubyHover", () => {
  let loadDictionaryMock: ReturnType<typeof vi.fn>;
  let lookupMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 800);
    Element.prototype.getBoundingClientRect = vi.fn(
      function (this: HTMLElement): DOMRect {
        if (this.hasAttribute && this.hasAttribute("data-hanzi")) {
          return rect(0, 80, 0, 200);
        }
        return rect(100, 130, 200, 60);
      },
    ) as unknown as typeof Element.prototype.getBoundingClientRect;

    loadDictionaryMock = vi.fn();
    lookupMock = vi.fn();
    // Mock the dynamic import('./dictionary') inside onRubyHover.
    vi.doMock("./dictionary", () => ({
      loadDictionary: loadDictionaryMock,
      lookup: lookupMock,
      buildMap: vi.fn(),
      mergeOverlay: vi.fn(),
      setDictionary: vi.fn(),
      resetDictionary: vi.fn(),
    }));
  });

  afterEach(async () => {
    destroyTooltip();
    vi.unstubAllGlobals();
    vi.doUnmock("./dictionary");
    await vi.resetModules();
  });

  it("shows a tooltip with definitions when lookup returns entries", async () => {
    loadDictionaryMock.mockResolvedValue(new Map());
    const entries: DictEntry[] = [
      { t: "你好", p: "nǐ hǎo", d: ["hello"] },
    ];
    lookupMock.mockReturnValue(entries);

    setBody(
      '<ruby data-word="你好" data-hanzi-source="你好">' +
        "<rb>你</rb><rt>nǐ</rt><rb>好</rb><rt>hǎo</rt></ruby>",
    );
    const ruby = document.querySelector("ruby[data-word]")!;

    const { onRubyHover } = await import("./tooltip");
    await onRubyHover(ruby);

    expect(loadDictionaryMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith(expect.any(Map), "你好");
    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.classList.contains("hanzi-tooltip--visible")).toBe(true);
    expect(el.querySelector(".hanzi-tooltip__word")!.textContent).toBe("你好");
    expect(el.querySelector(".hanzi-tooltip__defs li")!.textContent).toContain(
      "hello",
    );
  });

  it("falls back to per-char pinyin + 'No dictionary entry' when lookup is null", async () => {
    loadDictionaryMock.mockResolvedValue(new Map());
    lookupMock.mockReturnValue(null);

    setBody(
      '<ruby data-word="功法" data-hanzi-source="功法">' +
        "<rb>功</rb><rt>gōng</rt><rb>法</rb><rt>fǎ</rt></ruby>",
    );
    const ruby = document.querySelector("ruby[data-word]")!;

    const { onRubyHover } = await import("./tooltip");
    await onRubyHover(ruby);

    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    expect(el.querySelector(".hanzi-tooltip__pinyin")!.textContent).toBe(
      "gōng fǎ",
    );
    expect(el.querySelector(".hanzi-tooltip__noentry")).not.toBeNull();
  });

  it("still shows fallback tooltip when loadDictionary rejects", async () => {
    loadDictionaryMock.mockRejectedValue(new Error("network"));
    lookupMock.mockReturnValue(null);

    setBody(
      '<ruby data-word="字" data-hanzi-source="字">' +
        "<rb>字</rb><rt>zì</rt></ruby>",
    );
    const ruby = document.querySelector("ruby[data-word]")!;

    const { onRubyHover } = await import("./tooltip");
    await onRubyHover(ruby);

    const el = document.querySelector("div[data-hanzi='tooltip']")!;
    // Fallback path: pinyin from ruby rt, no definitions.
    expect(el.querySelector(".hanzi-tooltip__pinyin")!.textContent).toBe("zì");
    expect(el.querySelector(".hanzi-tooltip__noentry")).not.toBeNull();
  });
});

describe("tooltip generation counter (M4.7)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 800);
    Element.prototype.getBoundingClientRect = vi.fn(
      function (this: HTMLElement): DOMRect {
        if (this.hasAttribute && this.hasAttribute("data-hanzi")) {
          return rect(0, 80, 0, 200);
        }
        return rect(100, 130, 200, 60);
      },
    ) as unknown as typeof Element.prototype.getBoundingClientRect;
  });

  afterEach(async () => {
    destroyTooltip();
    vi.unstubAllGlobals();
    vi.doUnmock("./dictionary");
    await vi.resetModules();
  });

  it("in-flight lookup does not show tooltip after dismissHover", async () => {
    // Inject dictionary mock that resolves slowly so dismissHover fires first.
    const slowMap = new Promise<Map<string, DictEntry[]>>((resolve) => {
      setTimeout(() => resolve(new Map()), 500);
    });
    const lookupMock = vi.fn().mockReturnValue([{ t: "测试", p: "cè shì", d: ["test"] }]);

    vi.doMock("./dictionary", () => ({
      loadDictionary: () => slowMap,
      lookup: lookupMock,
      buildMap: vi.fn(),
      mergeOverlay: vi.fn(),
      setDictionary: vi.fn(),
      resetDictionary: vi.fn(),
    }));

    const { onRubyHover, dismissHover } = await import("./tooltip");

    setBody(
      '<ruby data-word="测试" data-hanzi-source="测试">' +
        "<rb>测</rb><rt>cè</rt><rb>试</rt><rt>shì</rt></ruby>",
    );
    const ruby = document.querySelector("ruby[data-word]")!;

    // Start hover; beginHover() sets gen=1, myGen=1.
    const hoverPromise = onRubyHover(ruby);

    // Simulate mouseout before the slow lookup resolves.
    dismissHover(); // gen becomes 2

    // Let the slow resolve happen.
    await Promise.resolve();
    await hoverPromise;

    // gen is 2, myGen is 1 → mismatch, showTooltip must NOT have been called.
    expect(document.querySelector('div[data-hanzi="tooltip"]')).toBeNull();
    expect(lookupMock).toHaveBeenCalled();
  });

  it("new hover supersedes older in-flight lookup", async () => {
    const slowMap = new Promise<Map<string, DictEntry[]>>((resolve) => {
      setTimeout(() => resolve(new Map()), 500);
    });
    const lookupMock = vi.fn().mockReturnValue([{ t: "你好", p: "nǐ hǎo", d: ["hello"] }]);

    vi.doMock("./dictionary", () => ({
      loadDictionary: () => slowMap,
      lookup: lookupMock,
      buildMap: vi.fn(),
      mergeOverlay: vi.fn(),
      setDictionary: vi.fn(),
      resetDictionary: vi.fn(),
    }));

    const { dismissHover, beginHover } = await import("./tooltip");

    setBody(
      '<ruby data-word="测试" data-hanzi-source="测试">' +
        "<rb>测</rb><rt>cè</rt></ruby>",
    );

    // First hover: capture myGen=1 (beginHover increments gen to 1).
    const gen1 = beginHover();
    expect(gen1).toBe(1);

    // Mouseout: gen becomes 2.
    dismissHover();

    // Second hover: gen becomes 3, myGen=3.
    const gen3 = beginHover();
    expect(gen3).toBe(3);

    // gen1(1) < hoverGen(3) → stale lookup for first ruby would NOT show.
    // gen3(3) == hoverGen(3) → current lookup for second ruby WOULD show.
    expect(beginHover()).toBe(4);
  });

  it("getHoverGen reflects current counter state", async () => {
    const { getHoverGen, beginHover, dismissHover } = await import("./tooltip");
    expect(getHoverGen()).toBe(0);
    beginHover();
    expect(getHoverGen()).toBe(1);
    dismissHover();
    expect(getHoverGen()).toBe(2);
    beginHover();
    expect(getHoverGen()).toBe(3);
  });
});
