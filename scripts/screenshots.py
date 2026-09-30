"""Screenshot every view in light, dark and phone width (desktop: full page;
phone: the first screen a visitor sees), and report console
errors, CSP violations and horizontal overflow.

    pip install playwright   # uses your installed Chrome, no browser download
    python scripts/screenshots.py http://127.0.0.1:7860 docs/screenshots
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7860"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots")
VIEWS = ["overview", "segments", "customers", "model"]
MODES = [("desktop", {"width": 1280, "height": 900}, 1), ("phone", {"width": 390, "height": 844}, 2)]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        for mode, vp, scale in MODES:
            for scheme in ("light", "dark"):
                ctx = browser.new_context(viewport=vp, device_scale_factor=scale, color_scheme=scheme,
                                          is_mobile=mode == "phone", has_touch=mode == "phone")
                page = ctx.new_page()
                page.on("console", lambda m: m.type in ("error", "warning") and problems.append(f"{mode}/{scheme} console {m.type}: {m.text}"))
                page.on("pageerror", lambda e: problems.append(f"{mode}/{scheme} page error: {e}"))
                for view in VIEWS:
                    page.goto(f"{BASE}/#/{view}")
                    page.wait_for_load_state("networkidle")
                    if view == "customers":
                        page.locator(".cust-head").first.click()
                        page.wait_for_selector(".cust-body .big-prob")
                    page.wait_for_timeout(2000)  # let count-ups and chart draw-ins finish
                    overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                    if overflow > 0:
                        problems.append(f"{mode}/{scheme}/{view}: horizontal overflow {overflow}px")
                    path = OUT / f"{view}-{mode}-{scheme}.png"
                    page.screenshot(path=str(path), full_page=mode == "desktop")
                    print("saved", path)
                ctx.close()
        browser.close()
    print("\n".join(problems) or "no console errors, CSP violations or horizontal overflow")


if __name__ == "__main__":
    main()
