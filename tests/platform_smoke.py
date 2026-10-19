#!/usr/bin/env python3
"""Independent Chromium platform smoke tests: python tests/platform_smoke.py.

Serves the parent checkout directory to exercise /Japanstudy/ deployment. Uses
real Chromium service workers/cache/offline controls, but explicitly mocked
Japanese speech and vibration adapters. No real audio, Safari, iPhone, iPad,
HTTPS hosting, or physical haptics are claimed. Requires Python Playwright and
Chromium at CHROMIUM_PATH (default /usr/bin/chromium).
"""

import argparse
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import time
import traceback
from urllib.parse import urljoin

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
KEY = "hiyori-study-v1"
EXPIRE_FLAG = "platform-test-expire-section"

# All side effects are local to an isolated test browser context. The speech
# queue advances only when the test explicitly fires onend/onerror.
ADAPTERS = r"""
(() => {
  const mock = window.__platformMock = {speech: [], pending: null, vibrations: [], cancellations: 0};
  const voice = {lang: 'ja-JP', name: 'TEST ONLY Japanese voice', localService: true};
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {configurable: true, value: class {
    constructor(text) {this.text = text;}
  }});
  Object.defineProperty(window, 'speechSynthesis', {configurable: true, value: {
    getVoices: () => [voice],
    speak: utterance => {
      mock.pending = utterance;
      mock.speech.push({text: utterance.text, lang: utterance.lang, rate: utterance.rate,
                        voice: utterance.voice?.name});
    },
    cancel: () => {
      const current = mock.pending; mock.pending = null; mock.cancellations++;
      current?.onerror?.({error: 'canceled'});
    }
  }});
  Object.defineProperty(navigator, 'vibrate', {configurable: true, value: pattern => {
    mock.vibrations.push(pattern); return true;
  }});
  if (sessionStorage.getItem('platform-test-expire-section')) {
    sessionStorage.removeItem('platform-test-expire-section');
    const raw = localStorage.getItem('hiyori-study-v1');
    if (raw) {
      const data = JSON.parse(raw);
      if (data.session?.mode === 'exam' && data.session.phase === 'active') {
        data.session.deadline = Date.now() - 1000;
        localStorage.setItem('hiyori-study-v1', JSON.stringify(data));
      }
    }
  }
})();
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


@contextmanager
def subpath_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT.parent)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/{ROOT.name}/"
    finally:
        server.shutdown()
        server.server_close()


def state(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", KEY)


def action(page, name):
    return page.locator(f'[data-action="{name}"]:visible').first


def current_question(page):
    session = state(page)["session"]
    return session["questions"][session["index"]]


def answer(page, correct=True):
    question = current_question(page)
    if question["kind"] == "input":
        page.locator("#answer-input").fill(question["answer"] if correct else "こたえがちがいます")
        action(page, "answer-input").click()
    else:
        option = question["answer"] if correct else next(x for x in question["options"] if x != question["answer"])
        page.locator(f'[data-action="answer-choice"][data-index="{question["options"].index(option)}"]').click()
    return question


def route(page, name, selector):
    page.evaluate("name => location.hash = name", name)
    expect(page.locator(selector).first).to_be_visible()


def expire_section(page):
    # pagehide saves the live state, so modify the deadline from the init script
    # before the next app module loads rather than racing that save.
    page.evaluate("flag => sessionStorage.setItem(flag, '1')", EXPIRE_FLAG)
    page.reload()


def test_cold_offline(browser, base):
    context = browser.new_context(service_workers="allow")
    try:
        context.set_offline(True)
        page = context.new_page()
        try:
            page.goto(base, wait_until="domcontentloaded", timeout=7000)
        except PlaywrightError as exc:
            assert "ERR_INTERNET_DISCONNECTED" in str(exc) or "ERR_FAILED" in str(exc), str(exc)
        else:
            raise AssertionError("A fresh uncached context unexpectedly loaded the offline app")
        assert page.locator(".hero").count() == 0
        return {"freshUncachedOfflineLoad": "correctly unavailable; first online installation is required"}
    finally:
        context.close()


def test_subpath_offline(browser, base, errors):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow", reduced_motion="reduce")
    try:
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base, wait_until="networkidle")
        expect(page.locator(".hero")).to_be_visible()
        page.evaluate("Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker did not become ready within 15 seconds')), 15000))])")
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        registration = page.evaluate("async () => {const r=await navigator.serviceWorker.ready; return {scope:r.scope, script:r.active.scriptURL};}")
        assert registration["scope"] == base
        assert registration["script"] == base + "sw.js"
        manifest = page.evaluate("async () => (await fetch('./manifest.webmanifest')).json()")
        assert urljoin(base, manifest["start_url"]).startswith(base)
        assert urljoin(base, manifest["scope"]).startswith(base)
        sw_source = (ROOT / "sw.js").read_text()
        file_list = re.search(r"const FILES\s*=\s*\[([\s\S]+?)\];", sw_source).group(1)
        expected_urls = {urljoin(base, path) for path in re.findall(r"['\"]([^'\"]+)['\"]", file_list)}
        cached = page.evaluate("""async () => {
          const output=[];
          for (const name of (await caches.keys()).filter(n=>n.startsWith('hiyori-static-'))) {
            const cache=await caches.open(name);
            for (const request of await cache.keys()) output.push({url:request.url, ok:(await cache.match(request)).ok});
          }
          return output;
        }""")
        assert expected_urls <= {item["url"] for item in cached}, "Precache is missing app files"
        assert all(item["ok"] and item["url"].startswith(base) for item in cached)
        context.set_offline(True)
        page.reload(wait_until="networkidle")
        expect(page.locator(".hero")).to_be_visible()
        action(page, "daily").click()
        expect(page.locator(".question-card")).to_be_visible()
        assert len(state(page)["session"]["questions"]) == 10
        for _ in range(10):
            answer(page)
            expect(page.locator(".feedback.good")).to_be_visible()
            action(page, "next-question").click()
        expect(page.locator(".result-card")).to_be_visible()
        assert state(page)["history"][-1]["correct"] == 10
        page.reload(wait_until="networkidle")
        expect(page.locator(".result-card")).to_be_visible()
        assert len(state(page)["attempts"]) == 10
        return {"deploymentPath": f"/{ROOT.name}/", "cachedFiles": len(expected_urls), "offlineDailyScore": "10/10", "offlineResultReload": True}
    finally:
        context.close()


def adapter_page(browser, base, errors):
    context = browser.new_context(viewport={"width": 820, "height": 1180}, service_workers="block", reduced_motion="reduce")
    context.add_init_script(ADAPTERS)
    page = context.new_page()
    page.set_default_timeout(7000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base, wait_until="networkidle")
    expect(page.locator(".hero")).to_be_visible()
    return context, page


def test_mock_haptics(browser, base, errors):
    context, page = adapter_page(browser, base, errors)
    try:
        action(page, "daily").click()
        expect(page.locator(".question-card")).to_be_visible()
        answer(page)
        assert page.evaluate("window.__platformMock.vibrations") == [], "Haptics must be opt-in"
        route(page, "settings", "#haptics")
        page.locator("#haptics").check()
        assert state(page)["settings"]["haptics"] is True
        # Ignore the setting toggle's own demonstration pulse.
        page.evaluate("window.__platformMock.vibrations = []")
        route(page, "home", ".hero")
        action(page, "resume").click()
        expect(page.locator(".feedback.good")).to_be_visible()
        action(page, "next-question").click()
        answer(page, False)
        expect(page.locator(".feedback.bad")).to_be_visible()
        action(page, "next-question").click()
        answer(page, True)
        expect(page.locator(".feedback.good")).to_be_visible()
        vibrations = page.evaluate("window.__platformMock.vibrations")
        assert vibrations == [[7, 45, 7], 7], vibrations
        return {"adapter": "mock navigator.vibrate", "defaultOff": True, "wrongPattern": [7, 45, 7], "correctPulseMs": 7}
    finally:
        context.close()


def test_mock_speech_exam(browser, base, errors):
    context, page = adapter_page(browser, base, errors)
    try:
        route(page, "exam", ".exam-card")
        page.locator('.exam-card [data-action="exam-start"][data-variant="full"]').click()
        action(page, "confirm-exam").click()
        expect(page.locator("#toast")).to_contain_text("请先完成日语试音")
        action(page, "audio-test").click()
        speech = page.evaluate("window.__platformMock.speech")
        assert len(speech) == 1 and speech[0]["lang"] == "ja-JP"
        assert speech[0]["voice"] == "TEST ONLY Japanese voice"
        page.evaluate("() => {const m=window.__platformMock, u=m.pending; m.pending=null; u.onend({});}")
        expect(page.locator("#audio-status")).to_contain_text("试音播放完成")
        action(page, "confirm-exam").click()
        expect(page.locator("#timer")).to_be_visible()
        initial = state(page)["session"]
        assert len(initial["questions"]) == 102
        assert [s["minutes"] for s in initial["sections"]] == [30, 70, 40]
        assert initial["variant"] == "full"
        starred_question = current_question(page)
        action(page, "star-current").click()
        saved = state(page)
        assert saved["session"]["stars"][starred_question["id"]] is True
        assert starred_question["id"] not in saved["mistakes"], "Exam star leaked a question before submission"
        answer(page, True)
        assert page.locator(".feedback, .option.correct, .option.wrong, .teaching").count() == 0
        assert state(page)["attempts"] == []
        expire_section(page)
        expect(page.locator(".between-card")).to_be_visible()
        assert state(page)["session"]["completedSections"] == [0]
        assert starred_question["id"] not in state(page)["mistakes"]
        action(page, "next-section").click()
        expect(page.locator("#timer")).to_be_visible()
        assert state(page)["session"]["sectionIndex"] == 1
        answer(page, False)
        assert page.locator(".feedback, .teaching").count() == 0
        expire_section(page)
        expect(page.locator(".between-card")).to_be_visible()
        assert state(page)["session"]["completedSections"] == [0, 1]
        action(page, "next-section").click()
        expect(action(page, "play-question")).to_be_visible()
        assert state(page)["session"]["sectionIndex"] == 2
        listening_question = current_question(page)
        assert listening_question["subject"] == "listening"
        action(page, "play-question").click()
        expect(action(page, "play-question")).to_be_disabled()
        assert state(page)["session"]["played"] == [listening_question["id"]]
        assert page.evaluate("window.__platformMock.pending !== null"), "Mock utterance should still be playing"
        assert page.evaluate("window.__platformMock.speech[0].text") == listening_question["audioText"]
        # Interrupt playback through real navigation; returning must not restore
        # the consumed play even though the mock has not fired onend.
        action(page, "next-question").click()
        action(page, "previous-question").click()
        expect(action(page, "play-question")).to_be_disabled()
        assert state(page)["session"]["played"] == [listening_question["id"]]
        assert page.evaluate("window.__platformMock.speech.length") == 1
        page.reload()
        expect(action(page, "play-question")).to_be_disabled()
        answer(page, True)
        assert page.locator(".feedback, .teaching, .audio-transcript").count() == 0
        action(page, "ask-submit").click()
        action(page, "submit-section").click()
        expect(page.locator(".result-card")).to_be_visible()
        saved = state(page)
        assert saved["session"] is None
        assert saved["history"][-1]["total"] == 102
        assert saved["history"][-1]["correct"] == 2
        assert len(saved["attempts"]) == 102
        assert sum(not a["correct"] for a in saved["attempts"]) == 100
        assert saved["mistakes"][starred_question["id"]]["starred"] is True
        assert saved["mistakes"][starred_question["id"]]["wrongCount"] == 0
        expect(page.locator(".result-card")).to_contain_text("99 道未作答")
        page.reload()
        expect(page.locator(".result-card")).to_be_visible()
        assert len(state(page)["attempts"]) == 102, "Reload duplicated the completed exam"
        assert state(page)["mistakes"][starred_question["id"]]["starred"] is True
        return {"adapter": "mock Japanese SpeechSynthesis", "sectionMinutes": [30, 70, 40], "expiryTransitions": 2,
                "playOnceSurvivesInterruptionAndReload": True, "deferredStarCommittedOnFinish": True,
                "score": {"correct": 2, "total": 102, "unanswered": 99}, "actualAudioTested": False}
    finally:
        context.close()


def main(args):
    report = {"browser": "native Chromium", "checks": [], "pageErrors": [],
              "limitations": ["Speech and vibration use explicit test adapters; no actual audio or haptic hardware was exercised.",
                              "Localhost is a secure-context exception; real HTTPS hosting and Safari/iOS remain untested.",
                              "Offline operation is verified only after a successful online service-worker installation."]}
    with subpath_server() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                                             args=["--no-sandbox", "--disable-dev-shm-usage"])
        checks = [
            ("cold context requires first online installation", lambda: test_cold_offline(browser, base)),
            ("subpath SW precache, offline reload and complete daily practice", lambda: test_subpath_offline(browser, base, report["pageErrors"])),
            ("mock haptics: opt-in and distinct answer patterns", lambda: test_mock_haptics(browser, base, report["pageErrors"])),
            ("mock Japanese voice: full exam, expiry, one play, deferred stars", lambda: test_mock_speech_exam(browser, base, report["pageErrors"])),
        ]
        for name, check in checks:
            started = time.monotonic()
            try:
                details = check()
                report["checks"].append({"name": name, "passed": True, "details": details, "seconds": round(time.monotonic() - started, 2)})
                print("PASS " + name, flush=True)
            except Exception as exc:
                report["checks"].append({"name": name, "passed": False, "error": str(exc), "traceback": traceback.format_exc()})
                print(f"FAIL {name}: {exc}", flush=True)
        browser.close()
    report["passed"] = all(check["passed"] for check in report["checks"]) and not report["pageErrors"]
    destination = Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"passed": report["passed"], "report": str(destination), "pageErrors": report["pageErrors"]}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", default="/workspace/.japanstudy-onboarding/platform-report.json")
    raise SystemExit(main(parser.parse_args()))
