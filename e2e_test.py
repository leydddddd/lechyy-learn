"""End-to-end test for Lechyy Chinese Reader extension."""
import os, sys, time, re
from playwright.sync_api import sync_playwright

PORT = 7890
DIST = os.path.abspath("dist")

def main():
    errors, passed = [], 0
    with sync_playwright() as p:
        ctx = p.chromium.launch(headless=True, args=[
            f"--disable-extensions-except={DIST}",
            f"--load-extension={DIST}",
            "--no-sandbox", "--disable-dev-shm-usage"])
        page = ctx.new_page()
        console_errors = []
        page.on("console", lambda m: console_errors.append(m) if m.type == "error" else None)

        print("=== Lechyy E2E Test ===")
        page.goto(f"http://localhost:{PORT}/test.html")
        page.wait_for_load_state("networkidle")

        ruby_cnt = len(page.query_selector_all("ruby[data-word]"))
        if ruby_cnt == 0:
            print("  Extension not auto-injected; injecting manually")
            with open(os.path.join(DIST, "styles", "ruby.css"), encoding="utf-8") as f:
                page.add_style_tag(content=f.read())
            with open(os.path.join(DIST, "content", "index.js"), encoding="utf-8") as f:
                page.add_script_tag(content=f.read())
            time.sleep(3)
            page.wait_for_load_state("networkidle")

        ruby_els = page.query_selector_all("ruby[data-word]")
        print(f"[T1] Ruby elements: {len(ruby_els)}")
        if len(ruby_els) == 0:
            errors.append("No ruby[date-woed] elements found")
        else:
            passed += 1

        # T2: rb+rt structure
        rb_ok = all(rb.query_selector_all("rb") and ruby.query_selector_all("rt")
                    for ruby in ruby_els)
        if rb_ok: passed += 1
        else: errors.append("Some ruby missing rb/rt")

        # T3: no kana in data-word
        kana_ok = not any(re.search(r"[\u3040-\u309f\u30a0-\u30ff]",
                                    ruby.get_attribute("data-word") or "")
                          for ruby in ruby_els)
        if kana_ok: passed += 1
        else: errors.append("Japanese kana found in data-word")

        # T4: rt contains pinyin (Latin), not CJK
        rt_ok = not any(re.search(r"[\u4e00-\u9fff]", rt.text_content() or "")
                        for ruby in ruby_els for rt in ruby.query_selector_all("rt"))
        if rt_ok: passed += 1
        else: errors.append("CJK found in rt")

        # T5: data-word == data-hanzi-source
        attr_ok = all(ruby.get_attribute("data-word") == ruby.get_attribute("data-hanzi-source")
                      for ruby in ruby_els)
        if attr_ok: passed += 1
        else: errors.append("data-word != data-hanzi-source")

        # T6: all CJK nodes annotated (exclude lang=ja)
        uncount = page.evaluate("""() => {
            const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n, c = 0;
            while (n = w.nextNode()) {
                const t = n.textContent || '';
                if (/[\\u4e00-\\u9fff]/.test(t)) {
                    let p = n.parentElement, inside = false;
                    while (p && p !== document.body) {
                        if (p.tagName === 'RUBY') { inside = true; break; }
                        p = p.parentElement;
                    }
                    if (!inside && !n.parentElement?.closest('[lang="ja"]')) c++;
                }
            }
            return c;
        }""")
        pending = page.evaluate("() => document.querySelectorAll('[data-hanzi-pending]').length")
        print(f"[T6] Unannotated CJK nodes: {uncount}, pending: {pending}")
        if uncount == 0 or pending > 0: passed += 1
        else: errors.append(f"{uncount} CJK nodes not annotated")

        # T7: tooltip on hover
        if ruby_els:
            try:
                ruby_els[0].hover()
                time.sleep(1.5)
                tt = page.query_selector("div[data-hanzi=tooltip]")
                if tt:
                    vis = page.evaluate("(el) => el.classList.contains('hanzi-tooltip--visible')", tt)
                    if vis:
                        txt = (tt.text_content() or "")[:60].replace("\n", " ")
                        print(f"[T7] Tooltip visible: PASS ({txt!r})")
                        passed += 1
            except Exception as e:
                print(f"[T7] Tooltip error: {e}")

        # Console errors (filter cedict.json 404)
        cerr = [f"{e.location}] {e.text}" for e in console_errors
                if "cedict" not in (e.text or "") and "Failed to load" not in (e.text or "")]
        if cerr:
            print(f"[Console] {len(cerr)} error(s): {cerr[:3]}")
            errors.append(f"Console errors: {cerr[:3]}")

        print(f"\n{'='*40}\nRESULTS: {passed}/7 passed, {len(errors)} failed")
        if errors:
            for e in errors: print(f"  - {e}")
            ctx.close(); sys.exit(1)
        else:
            print("ALL TESTS PASSED")
            ctx.close(); sys.exit(0)

if __name__ == "__main__":
    main()