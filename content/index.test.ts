import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAnnotator } from "./annotator";
import { runLensMode } from "./index";

// Cheapest possible IntersectionObserver mock: callback fires with the
// observed targets reported as either intersecting or not, per the test's
// choice. Each target we observe gets recorded so tests can drive scroll later.
class MockIntersectionObserver {
  static lastOptions: IntersectionObserverInit | undefined;
  static observed: HTMLElement[] = [];
  static intersectFn: (target: HTMLElement) => boolean = () => true;
  static notifyAll(): void {
    for (const target of MockIntersectionObserver.observed) {
      const isIntersecting = MockIntersectionObserver.intersectFn(target);
      MockIntersectionObserver.callback?.(
        [
          {
            target,
            isIntersecting,
            intersectionRect: {} as DOMRectReadOnly,
            rootBounds: null,
            time: 0,
            boundingClientRect: {} as DOMRectReadOnly,
            intersectionRatio: isIntersecting ? 1 : 0,
          },
        ],
        instanceRef as unknown as IntersectionObserver,
      );
    }
  }
  static callback: ((entries: unknown[], obs: unknown) => void) | null = null;
  static reset(): void {
    MockIntersectionObserver.observed = [];
    MockIntersectionObserver.callback = null;
    MockIntersectionObserver.intersectFn = () => true;
    MockIntersectionObserver.lastOptions = undefined;
  }
  unobserve(t: HTMLElement): void {
    MockIntersectionObserver.observed = MockIntersectionObserver.observed.filter(
      (x) => x !== t,
    );
  }
  disconnect(): void {
    MockIntersectionObserver.observed = [];
  }
  observe(t: HTMLElement): void {
    MockIntersectionObserver.observed.push(t);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  get root(): Document | Element | null {
    return null;
  }
  get rootMargin(): string {
    return "";
  }
  get thresholds(): number[] {
    return [];
  }
}

let instanceRef: { unobserve(t: HTMLElement): void } | null = null;

function installObserverMock(): void {
  vi.stubGlobal(
    "IntersectionObserver",
    class extends MockIntersectionObserver {
      constructor(
        cb: (entries: unknown[], obs: unknown) => void,
        options?: IntersectionObserverInit,
      ) {
        super();
        MockIntersectionObserver.callback = cb;
        MockIntersectionObserver.lastOptions = options;
        instanceRef = this;
      }
    },
  );
}

// jsdom getBoundingClientRect returns zeros; we want to control in/out of view
// per visible element by text content (the leaf blocks carry their textContent).
function stubContentAwareRect(this: HTMLElement): DOMRect {
  const text = (this?.textContent ?? "") as string;
  if (text.includes("视口内")) return rect(100, 150);
  if (text.includes("折叠区") || text.includes("下方")) {
    return rect(2000, 2100);
  }
  return rect(0, 0);
}

function rect(top: number, bottom: number): DOMRect {
  const r = { top, bottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  return r as DOMRect;
}

function installContentAwareRect(): void {
  Element.prototype.getBoundingClientRect = vi.fn(
    stubContentAwareRect as unknown as typeof Element.prototype.getBoundingClientRect,
  );
}

function installAlwaysInViewRect(): void {
  Element.prototype.getBoundingClientRect = vi.fn(function (this: HTMLElement): DOMRect {
    return rect(0, 50);
  } as unknown as typeof Element.prototype.getBoundingClientRect);
}

describe("runLensMode (full content-script entry, M4.1 element-level)", () => {
  beforeEach(async () => {
    document.body.remove();
    const body = document.createElement("body");
    document.documentElement.appendChild(body);
    MockIntersectionObserver.reset();
    instanceRef = null;
    await ensureAnnotator();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("annotates in-view block elements immediately and leaves out-of-view blocks pending", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p id="inView">汉字在视口内。</p>
      <p id="below">折叠区下方的汉字。</p>
    `;
    vi.stubGlobal("innerHeight", 800);
    installContentAwareRect();

    const candidateCount = await runLensMode();

    // Returns block count, not text node count.
    expect(candidateCount).toBe(2);
    // idle() defers in-view annotation via requestIdleCallback/setTimeout(1),
    // so flush timers to let the idle callback fire, then flush microtasks.
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    // In-view block got annotated after idle flush.
    expect(
      document
        .querySelector("#inView")
        ?.querySelector("ruby[data-word]"),
    ).not.toBeNull();
    // Out-of-view block should NOT yet be annotated (it's pending in IO).
    const below = document.querySelector("#below");
    expect(below?.querySelector("ruby[data-word]")).toBeNull();
    // The below block should be observed by IO (no wrapper needed).
    expect(MockIntersectionObserver.observed.length).toBeGreaterThanOrEqual(1);
  });

  it("annotates out-of-view blocks once IntersectionObserver reports intersecting", async () => {
    installObserverMock();
    document.body.innerHTML = `<p id="below">下方汉字等注音。</p>`;
    vi.stubGlobal("innerHeight", 600);
    installContentAwareRect();

    await runLensMode();
    // The <p> itself is observed directly, not a wrapper span.
    expect(MockIntersectionObserver.observed.length).toBeGreaterThanOrEqual(1);

    // Now simulate scroll-in: report the block as intersecting.
    // idle() falls back to setTimeout(0/1); flush the fake timer, then
    // flush any pending microtasks (the async annotation chain).
    MockIntersectionObserver.notifyAll();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    const ruby = document.querySelector("ruby[data-word]");
    expect(ruby).not.toBeNull();
  });

  it("exits early on a page with no CJK (no observer attached)", async () => {
    installObserverMock();
    document.body.innerHTML = `<p>Hello world only latin text</p>`;
    const out = await runLensMode();
    expect(out).toBe(0);
    expect(MockIntersectionObserver.observed).toHaveLength(0);
    expect(document.querySelectorAll("ruby[data-word]")).toHaveLength(0);
  });

  it("does NOT annotate text inside <pre>/<code>/<script>/<style>", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p id="plain">普通汉字应注音。</p>
      <pre id="pre">代码块里的汉字。</pre>
      <code id="code">内联code汉字</code>
      <script>var x = "脚本里汉字"</script>
      <style>.x::after{content:"样式里汉字"}</style>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();

    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(document.querySelector("#plain ruby[data-word]")).not.toBeNull();
    expect(document.querySelector("#pre ruby[data-word]")).toBeNull();
    expect(document.querySelector("#code ruby[data-word]")).toBeNull();
  });

  it("tone classes on rendered rt match each token's pinyin", async () => {
    installObserverMock();
    document.body.innerHTML = `<p id="p">汉字两个字</p>`;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();
    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    const rts = Array.from(document.querySelectorAll("#p rt"));
    expect(rts.length).toBeGreaterThan(0);
    for (const rt of rts) {
      expect(rt.className).toMatch(/^tone-[1-4]$/);
    }
  });

  it("does NOT annotate text inside contenteditable", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p id="normal">普通文本汉字。</p>
      <div contenteditable="true">编辑区汉字。</div>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();

    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(document.querySelector("#normal ruby[data-word]")).not.toBeNull();
    expect(
      document.querySelector("div[contenteditable] ruby[data-word]") ||
      document.querySelectorAll("div[contenteditable] ruby[data-word]").length,
    ).toBe(0);
  });

  it("does NOT annotate text inside aria-hidden elements", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p id="showing">可见汉字文本。</p>
      <div aria-hidden="true">隐藏汉字文本。</div>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();

    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(document.querySelector("#showing ruby[data-word]")).not.toBeNull();
    expect(document.querySelectorAll("div[aria-hidden] ruby[data-word]").length).toBe(0);
  });

  it("does NOT annotate text inside inert elements", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p id="active">活跃汉字文本。</p>
      <div inert>惰性汉字文本。</div>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();

    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    expect(document.querySelector("#active ruby[data-word]")).not.toBeNull();
    expect(document.querySelectorAll("div[inert] ruby[data-word]").length).toBe(0);
  });

  it("IO targets are the leaf block elements themselves, not wrapper spans", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p id="para">汉字段落。</p>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();

    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    // The observed target should be the <p> element or a leaf descendant,
    // NOT a <span data-hanzi-pending>.
    const observedTargets = MockIntersectionObserver.observed;
    for (const target of observedTargets) {
      expect(target.getAttribute("data-hanzi-pending")).toBeNull();
    }
  });

  it("nested blocks are reduced to leaf blocks only", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <div id="outer">
        <p id="inner">汉字在嵌套块中。</p>
      </div>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installContentAwareRect(); // inner is in-view (100, 150), outer has same text

    await runLensMode();
    vi.advanceTimersByTime(50);
    await Promise.resolve();

    // The <p> is a leaf block, so the outer <div> should NOT be in the IO.
    // Since installContentAwareRect treats "汉字在嵌套块中" as in-view,
    // the <p> gets annotated immediately and is NOT added to the observer.
    // Only check that the <p> was annotated (ruby created inside it).
    expect(document.querySelector("#inner ruby[data-word]")).not.toBeNull();
    // Ensure the DIV was not directly annotated (no ruby as a direct child of #outer).
    expect([...document.querySelector("#outer")!.children].some(
      (c) => c.tagName === "RUBY" && c.hasAttribute("data-word"),
    )).toBe(false);
  });

  it("returns block count, not text node count", async () => {
    installObserverMock();
    document.body.innerHTML = `
      <p>第一行汉字。</p>
      <p>第二行汉字。</p>
      <p>第三行汉字。</p>
    `;
    vi.stubGlobal("innerHeight", 2000);
    installAlwaysInViewRect();

    const count = await runLensMode();
    expect(count).toBe(3);
  });
});
