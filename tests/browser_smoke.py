#!/usr/bin/env python3
"""Run browser integration checks: python tests/browser_smoke.py

Requires Python Playwright and Chromium (CHROMIUM_PATH or /usr/bin/chromium).
Starts its own localhost static server unless --base-url is supplied. Writes a JSON
report and viewport screenshots outside the checkout, by default under
/workspace/.japanstudy-onboarding/browser. Browser contexts contain test data only.
No remote services, real speech playback, or real iOS hardware are exercised.
"""

import argparse
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
import traceback

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
KEY = "hiyori-study-v1"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@contextmanager
def local_server(base_url):
    if base_url:
        yield base_url.rstrip("/")
        return
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def get_state(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", KEY)


def question(page):
    state = get_state(page)
    return state["session"]["questions"][state["session"]["index"]]


def action(page, name):
    return page.locator(f'[data-action="{name}"]:visible').first


def navigate(page, route):
    page.evaluate("route => location.hash = route", route)
    expect(page.locator("#main")).to_be_visible()
    page.wait_for_function("route => location.hash === '#' + route", arg=route)
    # The hash changes synchronously; wait for its rendering event as well.
    labels = {"home": ".hero", "practice": ".practice-grid", "exam": ".exam-card",
              "mistakes": ".wrong-list", "records": ".page-head", "settings": "#goal-select"}
    expect(page.locator(labels[route]).first).to_be_visible()


def answer(page, correct=True):
    q = question(page)
    if q["kind"] == "input":
        value = q.get("accepted", [q["answer"]])[-1] if correct else "まちがいのこたえ"
        page.locator("#answer-input").fill(value)
        action(page, "answer-input").click()
    else:
        index = q["options"].index(q["answer"]) if correct else next(i for i, value in enumerate(q["options"]) if value != q["answer"])
        page.locator(f'[data-action="answer-choice"][data-index="{index}"]').click()
    return q


def finish_practice(page, correct=True):
    while get_state(page).get("session"):
        q = question(page)
        if q["id"] not in get_state(page)["session"]["answers"]:
            answer(page, correct)
        expect(page.locator(".feedback")).to_be_visible()
        action(page, "next-question").click()
    expect(page.locator(".result-card")).to_be_visible()


def setup_practice(page, kind, **selects):
    navigate(page, "practice")
    action(page, "setup-" + kind).click()
    expect(page.locator("#modal[open]")).to_be_visible()
    page.locator("#practice-count").select_option("5")
    for selector, value in selects.items():
        page.locator("#" + selector.replace("_", "-")).select_option(value)
    action(page, "begin-practice").click()
    expect(page.locator(".question-card")).to_be_visible()


def check_width(page):
    dims = page.evaluate("({viewport: innerWidth, width: document.documentElement.scrollWidth})")
    assert dims["width"] <= dims["viewport"] + 1, f"Horizontal overflow: {dims}"


def exercise_daily(page, artifacts, viewport_name):
    action(page, "daily").click()
    expect(page.locator(".question-card")).to_be_visible()
    initial = get_state(page)["session"]
    assert len(initial["questions"]) == 10
    assert {q["subject"] for q in initial["questions"]} == {"vocab", "kanji", "grammar", "verb"}
    seen = {"choice": 0, "input": 0}
    wrong_ids = []
    star_id = question(page)["id"]
    action(page, "star-current").click()
    expect(action(page, "star-current")).to_have_attribute("aria-pressed", "true")
    draft_checked = False
    for i in range(10):
        q = question(page)
        if q["kind"] == "input" and not draft_checked:
            page.locator("#answer-input").fill("まだとちゅう")
            page.reload()
            expect(page.locator("#answer-input")).to_have_value("まだとちゅう")
            draft_checked = True
        correct = seen[q["kind"]] > 0
        seen[q["kind"]] += 1
        answer(page, correct)
        expect(page.locator(".feedback.good" if correct else ".feedback.bad")).to_be_visible()
        expect(page.locator(".feedback .teaching")).to_contain_text(q["explanation"])
        if not correct:
            wrong_ids.append(q["id"])
            expect(page.locator(".feedback .correct-answer")).to_contain_text(q["answer"])
        if i == 0:
            page.screenshot(path=str(artifacts / f"{viewport_name}-daily-feedback.png"), full_page=True)
            page.reload()
            expect(page.locator(".feedback.bad")).to_be_visible()
            assert len(get_state(page)["attempts"]) == 1, "Reload recorded an attempt twice"
            assert get_state(page)["mistakes"][star_id]["starred"]
        check_width(page)
        action(page, "next-question").click()
    expect(page.locator(".result-card")).to_be_visible()
    state = get_state(page)
    assert seen["choice"] >= 2 and seen["input"] >= 2
    assert len(state["attempts"]) == 10
    assert len(wrong_ids) == 2
    assert state["history"][-1]["correct"] == 8
    assert state["history"][-1]["total"] == 10
    page.reload()
    expect(page.locator(".result-score")).to_contain_text("8")

    # Correct the same real mistake in two distinct review sessions.
    target = wrong_ids[0]
    for streak in (1, 2):
        navigate(page, "mistakes")
        page.locator(f'[data-action="inspect-mistake"][data-id="{target}"]').click()
        expect(page.locator("#modal[open] .teaching")).to_be_visible()
        action(page, "review-one").click()
        answer(page, True)
        expect(page.locator(".feedback.good")).to_be_visible()
        action(page, "next-question").click()
        expect(page.locator(".result-card")).to_be_visible()
        assert get_state(page)["mistakes"][target]["correctStreak"] == streak
    navigate(page, "mistakes")
    assert page.locator(f'[data-action="inspect-mistake"][data-id="{target}"]').count() == 0
    page.locator('[data-action="mistake-filter"][data-filter="mastered"]').click()
    expect(page.locator(f'[data-action="inspect-mistake"][data-id="{target}"]')).to_be_visible()
    page.locator('[data-action="mistake-filter"][data-filter="starred"]').click()
    expect(page.locator(f'[data-action="star-item"][data-id="{star_id}"]')).to_have_attribute("aria-pressed", "true")


def exercise_specialties(page):
    setup_practice(page, "grammar")
    q = answer(page, False)
    expect(page.locator(".feedback.bad .chosen-reason")).to_be_visible()
    expect(page.locator(".feedback .teaching")).to_contain_text(q["explanation"])
    expect(page.locator(".feedback .example")).to_be_visible()
    finish_practice(page)
    setup_practice(page, "verbs", verb_form="potential")
    q = answer(page, True)
    assert q["subject"] == "verb" and q["kind"] == "input"
    expect(page.locator(".feedback.good")).to_be_visible()
    expect(page.locator(".feedback .teaching")).to_contain_text("可能")
    finish_practice(page)


def exercise_exam(page):
    navigate(page, "exam")
    page.locator('[data-action="exam-start"][data-variant="quick"]').click()
    expect(page.locator("#modal[open]")).to_contain_text("各 5 分钟")
    action(page, "confirm-exam").click()
    expect(page.locator("#timer")).to_be_visible()
    s = get_state(page)["session"]
    assert [len(section["ids"]) for section in s["sections"]] == [5, 5]
    assert 290_000 < s["deadline"] - time.time() * 1000 <= 300_100
    q1 = answer(page, True)
    assert page.locator(".feedback").count() == 0
    assert page.locator(".option.correct, .option.wrong").count() == 0
    assert len(get_state(page)["attempts"]) == 0, "Exam answer recorded before submission"
    action(page, "flag-question").click()
    expect(action(page, "flag-question")).to_have_attribute("aria-pressed", "true")
    page.locator('[data-action="jump-question"]').nth(3).click()
    answer(page, False)
    page.locator('[data-action="jump-question"]').first.click()
    page.reload()
    expect(page.locator(".option.selected")).to_contain_text(q1["answer"])
    expect(action(page, "flag-question")).to_have_attribute("aria-pressed", "true")
    action(page, "ask-submit").click()
    expect(page.locator("#modal[open]")).to_contain_text("3 题未作答")
    action(page, "submit-section").click()
    expect(page.locator(".between-card")).to_be_visible()
    assert get_state(page)["session"]["completedSections"] == [0]
    assert page.locator(".teaching").count() == 0
    action(page, "next-section").click()
    expect(page.locator(".question-card")).to_be_visible()
    assert get_state(page)["session"]["sectionIndex"] == 1
    # Change deadline before the next module loads; pagehide would overwrite an
    # immediate localStorage mutation with the current in-memory session.
    page.add_init_script(f"""(() => {{const raw=localStorage.getItem('{KEY}');
      if(!raw)return;const s=JSON.parse(raw);if(s.session?.mode==='exam'){{
      s.session.deadline=Date.now()-1000;localStorage.setItem('{KEY}',JSON.stringify(s));}}}})();""")
    page.reload()
    expect(page.locator(".result-card")).to_be_visible()
    expect(page.locator(".result-card")).to_contain_text("8 道未作答")
    state = get_state(page)
    assert state["session"] is None
    assert len(state["attempts"]) == 10
    assert len(state["mistakes"]) == 9
    assert state["history"][-1]["correct"] == 1
    assert state["history"][-1]["total"] == 10
    page.locator(".review-item summary").first.click()
    expect(page.locator(".review-item[open] .teaching")).to_be_visible()
    page.reload()
    expect(page.locator(".result-card")).to_be_visible()
    assert len(get_state(page)["attempts"]) == 10, "Timed exam was recorded twice after reload"


def fixture_bank():
    def item(id_, subject, prompt, answer_, options, audio=None):
        q = {"id": id_, "kind": "choice", "subject": subject, "level": "N3",
             "prompt": prompt, "answer": answer_, "options": options, "explanation": "测试题库：此题用于验证导入、来源保留与分段结构。"}
        if audio:
            q["audioText"] = audio
        return q
    return {"schemaVersion": 1, "title": "浏览器测试题库", "source": {"name": "测试专用原创示例"}, "sections": [
        {"questions": [item("test-v", "vocab", "「影響」の読み方は？", "えいきょう", ["えいきょう", "えいぎょう", "えきょう", "えんきょう"])]},
        {"questions": [item("test-g", "grammar", "毎日、勉強する（　）しています。", "ように", ["ように", "ためで", "そうを", "ばかりに"])]},
        {"questions": [item("test-l", "listening", "何時に会いますか。", "九時", ["八時", "九時", "十時", "十一時"], "明日は九時に駅で会いましょう。")]}]}


def exercise_files(page, artifacts):
    navigate(page, "exam")
    payload = json.dumps(fixture_bank(), ensure_ascii=False).encode()
    page.locator("#bank-file").set_input_files({"name": "test-bank.json", "mimeType": "application/json", "buffer": payload})
    expect(page.locator("#modal[open]")).to_contain_text("题库检查通过")
    action(page, "confirm-bank").click()
    expect(page.locator(".imported-bank")).to_contain_text("测试专用原创示例")
    assert len(get_state(page)["banks"]) == 1
    invalid = fixture_bank()
    invalid["sections"][0]["questions"][0]["answer"] = "not-in-options"
    page.locator("#bank-file").set_input_files({"name": "invalid.json", "mimeType": "application/json", "buffer": json.dumps(invalid).encode()})
    expect(page.locator("#toast")).to_contain_text("正确答案必须与一个选项完全一致")
    assert len(get_state(page)["banks"]) == 1
    assert page.locator("#modal[open]").count() == 0
    navigate(page, "settings")
    with page.expect_download() as download:
        action(page, "export-backup").click()
    destination = artifacts / "test-progress-backup.json"
    download.value.save_as(destination)
    exported = json.loads(destination.read_text())
    assert exported["type"] == "hiyori-backup"
    assert exported["state"]["session"] is None
    assert exported["state"]["attempts"]
    return destination, exported["state"]


def exercise_restore(page, backup, original):
    navigate(page, "settings")
    page.locator("#backup-file").set_input_files(backup)
    expect(page.locator("#modal[open]")).to_contain_text("恢复学习记录？")
    action(page, "confirm-backup").click()
    page.wait_for_url("**/#records")
    restored = get_state(page)
    assert restored["attempts"] == original["attempts"]
    assert restored["mistakes"] == original["mistakes"]
    assert restored["banks"][0]["total"] == 3
    assert restored["banks"][0]["source"] == original["banks"][0]["source"]
    page.reload()
    assert get_state(page)["attempts"] == original["attempts"]


def exercise_missing_audio(page):
    navigate(page, "exam")
    page.locator('.exam-card [data-action="exam-start"][data-variant="full"]').click()
    action(page, "confirm-exam").click()
    expect(page.locator("#toast")).to_contain_text("请先完成日语试音")
    assert (get_state(page) or {}).get("session") is None
    action(page, "audio-test").click()
    expect(page.locator("#toast")).to_contain_text("未检测到日语语音")
    assert page.locator("#modal[open]").count() == 1
    action(page, "close-modal").click()
    setup_practice(page, "listening")
    expect(page.locator(".audio-box")).to_contain_text("阅读听力稿 · 非听音测试")
    expect(page.locator(".audio-box .passage")).to_be_visible()
    assert get_state(page)["session"]["audioTextMode"] is True
    answer(page, False)
    expect(page.locator(".feedback.bad .audio-transcript")).to_be_visible()


def run(args):
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    report = {"browser": "Chromium", "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": [], "errors": [],
              "limitations": ["390/820 px Chromium emulation is not a real Safari/iPhone/iPad test.", "Japanese audio availability fallback and start gate tested; actual speech playback was not tested."]}
    with local_server(args.base_url) as base, sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox", "--disable-dev-shm-usage"])

        def new_page(width=390, height=844, no_audio=False):
            context = browser.new_context(viewport={"width": width, "height": height}, is_mobile=True, has_touch=True, reduced_motion="reduce", service_workers="block", accept_downloads=True)
            if no_audio:
                context.add_init_script("if('speechSynthesis' in window) speechSynthesis.getVoices = () => [];")
            page = context.new_page()
            page.set_default_timeout(7000)
            page.on("pageerror", lambda error: report["errors"].append(str(error)))
            page.on("console", lambda msg: report["errors"].append(msg.text) if msg.type == "error" and "favicon" not in msg.text else None)
            page.goto(base + "/", wait_until="networkidle")
            expect(page.locator(".hero")).to_be_visible()
            return context, page

        def check(name, callback):
            started = time.monotonic()
            try:
                callback()
                report["checks"].append({"name": name, "passed": True, "seconds": round(time.monotonic() - started, 2)})
                print(f"PASS {name}", flush=True)
            except Exception as exc:
                report["checks"].append({"name": name, "passed": False, "error": str(exc), "traceback": traceback.format_exc()})
                print(f"FAIL {name}: {exc}", flush=True)

        for name, width, height in [("iphone", 390, 844), ("ipad", 820, 1180)]:
            context, page = new_page(width, height)
            def viewport_flow():
                check_width(page)
                page.screenshot(path=str(artifacts / f"{name}-home.png"), full_page=True)
                # Click the actually visible navigation; no hidden desktop duplicates.
                for route in ("practice", "exam", "mistakes", "records", "home"):
                    page.locator(f'a.nav-link[href="#{route}"]:visible').first.click()
                    page.wait_for_url(f"**/#{route}")
                    expect(page.locator("#main")).to_be_visible()
                    check_width(page)
                exercise_daily(page, artifacts, name)
            check(f"{name}: navigation, mixed daily answers, persistence, stars, two-review mastery", viewport_flow)
            if name == "iphone":
                check("grammar explanations and canonical verb input", lambda: exercise_specialties(page))
                exported = []
                check("valid/invalid bank import and progress export", lambda: exported.append(exercise_files(page, artifacts)))
                if exported:
                    restore_context, restore_page = new_page()
                    check("progress restore into a separate fresh browser context", lambda: exercise_restore(restore_page, *exported[0]))
                    restore_context.close()
            context.close()

        context, page = new_page()
        check("short exam: no early feedback, flags/jumps, sections, expiry, unanswered scoring", lambda: exercise_exam(page))
        context.close()
        context, page = new_page(no_audio=True)
        check("missing Japanese voice: full-exam gate and labeled text fallback", lambda: exercise_missing_audio(page))
        context.close()

        def resources():
            context = browser.new_context()
            for path in ("index.html", "assets/app.js", "assets/core.js", "assets/word-data.js", "assets/grammar-data.js", "assets/exam-written.js", "assets/exam-listening.js", "assets/styles.css", "assets/icon.svg", "assets/icon-192.png", "assets/import-example.json", "manifest.webmanifest", "sw.js"):
                response = context.request.get(base + "/" + path)
                assert response.status == 200, f"{path}: HTTP {response.status}"
            context.close()
        check("HTTP availability of app modules and PWA/import resources", resources)
        browser.close()
    report["passed"] = all(check["passed"] for check in report["checks"]) and not report["errors"]
    (artifacts / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"passed": report["passed"], "checks": len(report["checks"]), "browserErrors": report["errors"], "report": str(artifacts / "report.json")}, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", help="Use an existing static server instead of starting one")
    parser.add_argument("--artifacts", default="/workspace/.japanstudy-onboarding/browser")
    raise SystemExit(run(parser.parse_args()))
