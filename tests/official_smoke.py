#!/usr/bin/env python3
"""Exercise both official N3 workbooks in real Chromium.

Runs complete 99/102-question exams against independently transcribed official
answer keys, real MP3 playback, mistake review, and downloaded-bank offline
operation under the /Japanstudy/ deployment path. No speech/audio mocks are used;
a transparent play observer only exposes the actual HTMLMediaElement to checks.
Requires Python Playwright and Chromium (CHROMIUM_PATH or /usr/bin/chromium).
"""

import argparse
import json
import os
from pathlib import Path
import time
import traceback
from urllib.parse import urljoin

from playwright.sync_api import expect, sync_playwright

from browser_smoke import KEY, action, check_width, get_state, question
from platform_smoke import subpath_server

ROOT = Path(__file__).resolve().parents[1]
# Independently transcribed from downloaded official N3answer.pdf files. Group
# boundaries are retained so fixture errors can be checked against each table.
KEYS = {
    "2012": [
        "32231424" + "341223" + "243312321" + "14323" + "41411",
        "2243412344231" + "24213" + "34321" + "3334" + "341321" + "1442" + "23",
        "241232" + "314244" + "224" + "2321" + "31322132",
    ],
    "2018": [
        "42132431" + "433214" + "24131324412" + "41312" + "32213",
        "2431423231241" + "24213" + "34132" + "3241" + "234341" + "4413" + "22",
        "231212" + "241134" + "342" + "1233" + "132113212",
    ],
}
EXPECTED = {"2012": {"counts": [33, 39, 27], "ones": 20},
            "2018": {"counts": [35, 39, 28], "ones": 26}}
OBSERVE_REAL_AUDIO = r"""
(() => {
  window.__officialMedia = null;
  window.__speechCalls = 0;
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    window.__officialMedia = this;
    return realPlay.apply(this, args);
  };
  if (window.speechSynthesis) {
    const realSpeak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (...args) => { window.__speechCalls++; return realSpeak(...args); };
  }
})();
"""


def new_page(browser, base, errors, width=390, offline_capable=False):
    context = browser.new_context(viewport={"width": width, "height": 1180 if width > 500 else 844},
                                  is_mobile=True, has_touch=True, reduced_motion="reduce",
                                  service_workers="allow")
    context.add_init_script(OBSERVE_REAL_AUDIO)
    page = context.new_page()
    page.set_default_timeout(10000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base, wait_until="networkidle")
    expect(page.locator(".hero")).to_be_visible()
    page.wait_for_function("navigator.serviceWorker.controller !== null")
    return context, page


def go_exam(page):
    page.evaluate("location.hash = 'exam'")
    expect(page.locator('[data-action="exam-start"][data-bank="official-2012"]').first).to_be_visible()
    expect(page.locator('[data-action="exam-start"][data-bank="official-2018"]').first).to_be_visible()


def import_personal_audio(page, year):
    go_exam(page)
    status = page.locator(f'[data-audio-import-status="official-{year}"]')
    if "5 / 5" not in status.inner_text():
        files = [str(ROOT / "assets" / "official" / year / f"N3Q{i}.mp3") for i in range(1, 6)]
        page.locator(f'.official-audio-file[data-bank="official-{year}"]').set_input_files(files)
        expect(status).to_contain_text("5 / 5", timeout=30000)


def start_exam(page, year):
    import_personal_audio(page, year)
    page.locator(f'[data-action="exam-start"][data-bank="official-{year}"]').first.click()
    expect(page.locator("#modal[open]")).to_be_visible()
    action(page, "confirm-exam").click()
    assert not (get_state(page) or {}).get("session"), "Official full exam skipped its original-audio check"
    action(page, "audio-test").click()
    expect(page.locator("#audio-status")).to_contain_text("原版录音正在播放")
    action(page, "confirm-exam").click()
    expect(page.locator(".question-card")).to_be_visible()
    expect(page.locator("#timer")).to_be_visible()


def choose_digit(page, digit="1"):
    # Official answer numbers must remain in their printed order, including
    # three-choice listening tasks. Click the visible option with that number.
    q = question(page)
    assert q["options"] == [str(i) for i in range(1, len(q["options"]) + 1)], q["id"]
    option = page.locator(f'[data-action="answer-choice"][data-index="{int(digit)-1}"]')
    expect(option).to_be_visible()
    option.click()
    return q


def no_early_answers(page):
    assert page.locator(".feedback, .correct-answer, .option.correct, .option.wrong, .teaching").count() == 0
    assert page.locator('img[src*="N3answer"], img[src*="N3script"]').count() == 0
    assert not get_state(page)["attempts"], "Exam attempts were committed before final submission"


def verify_question_images(page):
    q = question(page)
    for path in q.get("pageImages", []):
        locator = page.locator(f'img[src="{path}"]').first
        expect(locator).to_be_attached()
        locator.scroll_into_view_if_needed()
        page.wait_for_function("path => [...document.images].some(img => img.getAttribute('src') === path && img.complete && img.naturalWidth > 0)", arg=path)
    check_width(page)


def submit_section(page, next_section=True):
    action(page, "ask-submit").click()
    action(page, "submit-section").click()
    if next_section:
        expect(page.locator(".between-card")).to_be_visible()
        action(page, "next-section").click()
        expect(page.locator(".question-card")).to_be_visible()
    else:
        expect(page.locator(".result-card")).to_be_visible()


def full_exam(page, year, artifacts):
    start_exam(page, year)
    initial = get_state(page)["session"]
    assert [len(sec["ids"]) for sec in initial["sections"]] == EXPECTED[year]["counts"]
    assert [sec["minutes"] for sec in initial["sections"]] == [30, 70, {"2012": 41, "2018": 44}[year]]
    assert 29 * 60_000 < initial["deadline"] - time.time() * 1000 <= 30 * 60_000 + 1000
    all_questions = initial["questions"]
    independent_key = "".join(KEYS[year])
    assert "".join(q["answer"] for q in all_questions) == independent_key, "Question answers differ from official PDF key"
    first_id = all_questions[0]["id"]
    action(page, "star-current").click()
    action(page, "flag-question").click()
    assert first_id not in get_state(page)["mistakes"], "Star exposed an exam question before submission"
    answered = 0
    for section_number, count in enumerate(EXPECTED[year]["counts"]):
        assert get_state(page)["session"]["sectionIndex"] == section_number
        for position in range(count):
            verify_question_images(page)
            q = choose_digit(page)
            answered += 1
            no_early_answers(page)
            if answered == 1:
                page.reload(wait_until="networkidle")
                expect(page.locator(".option.selected")).to_be_visible()
                expect(action(page, "flag-question")).to_have_attribute("aria-pressed", "true")
                assert get_state(page)["session"]["answers"][q["id"]]["value"] == "1"
                no_early_answers(page)
                page.screenshot(path=str(artifacts / f"{year}-official-exam.png"), full_page=True)
            if position < count - 1:
                action(page, "next-question").click()
        submit_section(page, next_section=section_number < 2)
        if section_number < 2:
            assert get_state(page)["session"]["completedSections"] == list(range(section_number + 1))
            no_early_answers(page)
    saved = get_state(page)
    total = sum(EXPECTED[year]["counts"])
    assert saved["session"] is None
    assert len(saved["attempts"]) == total
    assert saved["history"][-1]["correct"] == EXPECTED[year]["ones"]
    assert saved["history"][-1]["total"] == total
    assert len(saved["mistakes"]) == total - EXPECTED[year]["ones"]
    assert saved["mistakes"][first_id]["starred"]
    page.locator(".review-item summary").first.click()
    expect(page.locator(".review-item[open] .correct-answer")).to_contain_text(KEYS[year][0][0])
    assert page.locator('.review-item[open] img[src*="N3answer"]').count() > 0
    page.reload(wait_until="networkidle")
    expect(page.locator(".result-card")).to_be_visible()
    assert len(get_state(page)["attempts"]) == total, "Reload duplicated completed-exam scoring"
    # Reuse the actual first error from this completed exam in a real review.
    page.evaluate("location.hash = 'mistakes'")
    page.locator(f'[data-action="inspect-mistake"][data-id="{first_id}"]').click()
    action(page, "review-one").click()
    verify_question_images(page)
    choose_digit(page, KEYS[year][0][0])
    expect(page.locator(".feedback.good")).to_be_visible()
    action(page, "next-question").click()
    expect(page.locator(".result-card")).to_be_visible()
    assert get_state(page)["mistakes"][first_id]["correctStreak"] == 1
    assert page.evaluate("window.__speechCalls") == 0
    return {"questionsAnsweredThroughUI": total, "fixedAnswer": "1", "officialKeyScore": EXPECTED[year]["ones"],
            "allQuestionImagesLoaded": True, "deferredFeedback": True, "markedMistakeReviewed": True}


def start_listening_practice(page, year):
    import_personal_audio(page, year)
    page.locator(f'[data-action="official-practice"][data-bank="official-{year}"][data-section="2"]').click()
    expect(page.locator(".question-card")).to_be_visible()


def play_real_audio(page):
    action(page, "official-play").click()
    page.wait_for_function("window.__officialMedia && !__officialMedia.paused && __officialMedia.currentTime > 0.15 && Number.isFinite(__officialMedia.duration)", timeout=15000)
    media = page.evaluate("({src:__officialMedia.currentSrc, time:__officialMedia.currentTime, duration:__officialMedia.duration})")
    assert media["src"].endswith(".mp3"), media
    assert media["duration"] > 15
    assert page.evaluate("window.__speechCalls") == 0
    return media


def media_continuity(page):
    before = play_real_audio(page)
    first_group = question(page)["audioGroup"]
    choose_digit(page)
    expect(page.locator(".feedback")).to_be_visible()
    action(page, "next-question").click()
    assert question(page)["audioGroup"] == first_group
    after = page.evaluate("({src:__officialMedia.currentSrc, time:__officialMedia.currentTime, paused:__officialMedia.paused})")
    assert not after["paused"] and after["src"] == before["src"] and after["time"] >= before["time"], (before, after)
    action(page, "official-pause").click()
    assert page.evaluate("__officialMedia.paused") is True
    paused_at = page.evaluate("__officialMedia.currentTime")
    page.reload(wait_until="networkidle")
    resumed = play_real_audio(page)
    assert resumed["time"] >= paused_at - 0.25, (paused_at, resumed)
    return {"src": before["src"], "duration": before["duration"], "sameGroupContinuous": True, "pauseReloadResume": True}


def listening_practice(page, artifacts):
    start_listening_practice(page, "2018")
    verify_question_images(page)
    details = media_continuity(page)
    slider = page.locator("input.official-audio-progress")
    expect(slider).to_be_enabled()
    slider.evaluate("input => {input.value = '20'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));}")
    page.wait_for_function("__officialMedia.currentTime >= 19 && __officialMedia.currentTime < 23")
    choose_digit(page)
    expect(page.locator(".feedback")).to_be_visible()
    assert page.locator('img[src*="N3script"]').count() > 0, "Listening feedback does not offer the original transcript"
    check_width(page)
    page.screenshot(path=str(artifacts / "official-listening-practice.png"), full_page=True)
    details["practiceSeeking"] = True
    return details


def listening_exam(page):
    start_exam(page, "2012")
    submit_section(page)
    submit_section(page)
    before = play_real_audio(page)
    assert page.locator("input.official-audio-progress:not([disabled])").count() == 0, "Exam permits seeking"
    choose_digit(page)
    action(page, "next-question").click()
    assert not page.evaluate("__officialMedia.paused")
    assert page.evaluate("__officialMedia.currentTime") >= before["time"]
    action(page, "official-pause").click()
    paused_at = page.evaluate("__officialMedia.currentTime")
    page.reload(wait_until="networkidle")
    resumed = play_real_audio(page)
    assert resumed["time"] >= paused_at - 0.25
    assert page.locator("input.official-audio-progress:not([disabled])").count() == 0
    no_early_answers(page)
    # Accelerate the actual decoded recording to its tail; let Chromium fire
    # the real ended event instead of mocking player state or waiting minutes.
    page.evaluate("__officialMedia.currentTime = __officialMedia.duration - 0.15")
    page.wait_for_function("__officialMedia.ended", timeout=10000)
    expect(action(page, "official-play")).to_be_disabled()
    page.reload(wait_until="networkidle")
    expect(action(page, "official-play")).to_be_disabled()
    return {"realMP3Playback": True, "examSeekingDisabled": True, "reloadResumesWithoutRestart": True,
            "completedRecordingCannotReplayAfterReload": True}


def offline_banks(page, context, base):
    page.evaluate("Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(Error('SW readiness timeout')), 15000))])")
    page.wait_for_function("navigator.serviceWorker.controller !== null")
    go_exam(page)
    banks = page.evaluate("async () => (await import('./assets/official-banks.js')).OFFICIAL_BANKS")
    assert len(banks) == 2
    assets = set()
    for bank in banks:
        import_personal_audio(page, str(bank["year"]))
        assets.update(resource["path"] for resource in bank.get("resources", []))
        for section in bank["sections"]:
            for q in section["questions"]:
                for field in ("pageImages", "answerImages", "scriptImages"):
                    assets.update(q.get(field, []))
                if q.get("audioSrc"):
                    assets.add(q["audioSrc"])
        button = page.locator(f'[data-action="offline-bank"][data-bank="{bank["id"]}"]')
        button.click()
        page.wait_for_function("async paths => {for (const path of paths) if (!(await caches.match(new URL(path, location.href)))) return false; return true;}", arg=sorted(assets), timeout=120000)
        expect(page.locator(f'[data-cache-status="{bank["id"]}"]')).to_contain_text("本套图文离线资料已保存")
    context.set_offline(True)
    page.reload(wait_until="networkidle")
    go_exam(page)
    audio_paths = sorted(path for path in assets if path.endswith(".mp3"))
    assert len(audio_paths) == 10
    images = sorted(path for path in assets if path.endswith(".webp"))
    loaded = page.evaluate("""async paths => {
      const results=[];
      for (const path of paths) {
        const response=await fetch(path); if(!response.ok) throw Error(path+': '+response.status);
        const blob=await response.blob(), bitmap=await createImageBitmap(blob);
        if(!bitmap.width || !bitmap.height) throw Error('Empty image: '+path);
        results.push(path); bitmap.close();
      }
      return results.length;
    }""", images)
    for path in audio_paths:
        result = page.evaluate("""async path => {
          const r=await fetch(path,{headers:{Range:'bytes=64-319'}});
          return {status:r.status,range:r.headers.get('Content-Range'), bytes:[...new Uint8Array(await r.arrayBuffer())]};
        }""", path)
        data = (ROOT / path).read_bytes()
        assert result["status"] == 206, (path, result["status"])
        assert result["range"] == f"bytes 64-319/{len(data)}"
        assert bytes(result["bytes"]) == data[64:320], path
    pdf_paths = sorted(path for path in assets if path.endswith(".pdf"))
    for path in pdf_paths:
        result = page.evaluate("async path => {const r=await fetch(path);const b=new Uint8Array(await r.arrayBuffer()); return {status:r.status,head:String.fromCharCode(...b.slice(0,5))};}", path)
        assert result == {"status": 200, "head": "%PDF-"}, path
    path = audio_paths[0]
    data = (ROOT / path).read_bytes()
    suffix = page.evaluate("async path => {const r=await fetch(path,{headers:{Range:'bytes=-128'}}); return {status:r.status, bytes:[...new Uint8Array(await r.arrayBuffer())]};}", path)
    assert suffix["status"] == 206 and bytes(suffix["bytes"]) == data[-128:]
    invalid = page.evaluate("async ({path,size}) => {const r=await fetch(path,{headers:{Range:'bytes='+size+'-'}}); return {status:r.status,range:r.headers.get('Content-Range')};}", {"path": path, "size": len(data) + 10})
    assert invalid["status"] == 416 and invalid["range"] == f"bytes */{len(data)}"
    start_listening_practice(page, "2018")
    verify_question_images(page)
    played = play_real_audio(page)
    return {"subpath": "/" + ROOT.name + "/", "offlineImagesDecoded": loaded,
            "originalMP3RangesVerified": len(audio_paths), "offlineOriginalPDFs": len(pdf_paths), "suffixAndInvalidRange": True,
            "offlineActualPlayback": played["src"]}


def main(args):
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    report = {"checks": [], "pageErrors": [], "limitations": [
        "Chromium 390/820px emulation does not replace Safari/iPhone/iPad hardware validation.",
        "Original MP3 files are decoded and their real playback clocks advance in headless Chromium; audible speaker output is not checked.",
        "Workbook PDF keys are independently transcribed fixtures; original page image readability still requires visual review."]}
    with subpath_server() as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                                             args=["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"])
        cases = [("2012: complete 99-question official exam, score and marked error review", 390, False, lambda p,c: full_exam(p, "2012", artifacts)),
                 ("2018: complete 102-question official exam on iPad width", 820, False, lambda p,c: full_exam(p, "2018", artifacts)),
                 # The basic Python server has no Range support. Exercise the
                 # app's real SW range handler, which also supports iOS seeking.
                 ("real MP3 practice continuity, seeking, pause/reload, original transcript", 390, True, lambda p,c: listening_practice(p, artifacts)),
                 ("real MP3 timed exam continuity and disabled seeking", 390, False, lambda p,c: listening_exam(p)),
                 ("both downloaded workbooks offline, original images and MP3 ranges", 820, True, lambda p,c: offline_banks(p, c, base))]
        for name, width, offline, run in cases:
            context, page = new_page(browser, base, report["pageErrors"], width, offline)
            started = time.monotonic()
            try:
                details = run(page, context)
                report["checks"].append({"name": name, "passed": True, "details": details, "seconds": round(time.monotonic() - started, 2)})
                print("PASS " + name, flush=True)
            except Exception as exc:
                report["checks"].append({"name": name, "passed": False, "error": str(exc), "traceback": traceback.format_exc()})
                page.screenshot(path=str(artifacts / ("failure-" + str(len(report["checks"])) + ".png")), full_page=True)
                print("FAIL " + name + ": " + str(exc), flush=True)
            finally:
                context.close()
        browser.close()
    report["passed"] = all(item["passed"] for item in report["checks"]) and not report["pageErrors"]
    destination = artifacts / "report.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"passed": report["passed"], "checks": len(report["checks"]), "pageErrors": report["pageErrors"], "report": str(destination)}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", default="/workspace/.japanstudy-onboarding/official-browser")
    raise SystemExit(main(parser.parse_args()))
