#!/usr/bin/env python3
"""Exercise the sync UI using two isolated browsers and a simulated Auth/CAS API.

No real cloud account is created. Real Auth/RLS checks are a separate deployment
check. Codes, passwords, and tokens are never included in the report/screenshots.
"""
from copy import deepcopy
import json
from pathlib import Path
import uuid

from playwright.sync_api import sync_playwright, expect
from browser_smoke import local_server, action, navigate, check_width

ARTIFACTS = Path("/workspace/.japanstudy-onboarding/sync")
STATE_JS = """() => {
 const auth=JSON.parse(localStorage.getItem('hiyori-cloud-auth-v1')||'null');
 return JSON.parse(localStorage.getItem(auth?'hiyori-study-v1:account:'+auth.userId:'hiyori-study-v1')||'null');
}"""


class FakeCloud:
    def __init__(self):
        self.accounts, self.tokens, self.rows = {}, {}, {}
        self.signups = 0

    def route(self, route):
        request = route.request
        headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
                   "Access-Control-Allow-Methods": "POST,OPTIONS", "Content-Type": "application/json"}
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=headers)
            return
        data = request.post_data_json
        if "/auth/v1/" in request.url:
            user = None
            if "/signup" in request.url:
                self.signups += 1
                user = {"id": str(uuid.uuid4()), "password": data["password"]}
                self.accounts[data["email"]] = user
            elif "grant_type=refresh_token" in request.url:
                user = next((u for u in self.accounts.values() if "r-" + u["id"] == data["refresh_token"]), None)
            else:
                candidate = self.accounts.get(data["email"])
                if candidate and candidate["password"] == data["password"]:
                    user = candidate
            if user is None:
                route.fulfill(status=400, headers=headers, body=json.dumps({"error": "invalid_credentials"}))
                return
            token = "t-" + user["id"]
            self.tokens[token] = user["id"]
            result = {"user": {"id": user["id"]}, "access_token": token,
                      "refresh_token": "r-" + user["id"], "expires_in": 3600}
        else:
            owner = self.tokens.get(request.headers.get("authorization", "").removeprefix("Bearer "))
            if not owner:
                route.fulfill(status=401, headers=headers, body="{}")
                return
            row = self.rows.get(owner, {"revision": 0, "document": None})
            ok = True
            if data["expected_revision"] >= 0:
                ok = data["expected_revision"] == row["revision"]
                if ok:
                    row = {"revision": row["revision"] + 1, "document": deepcopy(data["document"])}
                    self.rows[owner] = row
            result = {"ok": ok, **row}
        route.fulfill(status=200, headers=headers, body=json.dumps(result))


def state(page):
    return page.evaluate(STATE_JS)


def count(page, expected):
    page.wait_for_function("""expected => {
      const a=JSON.parse(localStorage.getItem('hiyori-cloud-auth-v1')||'null');
      const s=JSON.parse(localStorage.getItem(a?'hiyori-study-v1:account:'+a.userId:'hiyori-study-v1')||'null');
      return s?.attempts.length===expected;
    }""", arg=expected)


def answer_one(page, correct=False):
    navigate(page, "home")
    action(page, "daily").click()
    if page.locator('#modal[open] [data-action="replace-session"]').count():
        action(page, "replace-session").click()
    expect(page.locator(".question-card")).to_be_visible()
    q = state(page)["session"]["questions"][0]
    if q["kind"] == "input":
        page.locator("#answer-input").fill(q["answer"] if correct else "まちがい")
        action(page, "answer-input").click()
    else:
        i = q["options"].index(q["answer"]) if correct else next(i for i, v in enumerate(q["options"]) if v != q["answer"])
        page.locator(f'[data-action="answer-choice"][data-index="{i}"]').click()
    expect(page.locator(".feedback")).to_be_visible()
    navigate(page, "settings")
    return q["id"]


def sync(page):
    navigate(page, "settings")
    page.wait_for_function("() => !document.querySelector('[data-action=\"cloud-sync\"]')?.disabled")
    action(page, "cloud-sync").click()
    expect(page.locator("[data-cloud-status]")).to_have_text("所有学习记录已同步")


def create_space(page):
    navigate(page, "settings")
    action(page, "cloud-create").click()
    action(page, "cloud-confirm-create").click()
    expect(page.locator("#cloud-code")).to_be_visible()
    code = page.locator("#cloud-code").input_value()
    action(page, "close-modal").first.click()
    sync(page)
    return code


def join_space(page, code, import_local=False):
    navigate(page, "settings")
    action(page, "cloud-join").click()
    page.locator("#cloud-code-input").fill(code)
    if import_local:
        page.locator("#cloud-import-local").check()
    page.locator("#cloud-join-submit").click()
    expect(page.locator("#modal")).not_to_have_attribute("open", "")
    sync(page)


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    cloud, errors, checks = FakeCloud(), [], []
    with local_server(None) as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        phone_context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block")
        pad_context = browser.new_context(viewport={"width": 820, "height": 1180}, is_mobile=True, has_touch=True, service_workers="block")
        for context in [phone_context, pad_context]:
            context.route("https://*.supabase.co/**", cloud.route)
        phone, pad = phone_context.new_page(), pad_context.new_page()
        for page in [phone, pad]:
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url + "/#settings")
            expect(page.locator("#cloud-panel")).to_be_visible()
            check_width(page)

        first_question = answer_one(phone)
        code = create_space(phone)
        join_space(pad, code)
        count(pad, 1)
        assert state(pad)["session"] is None
        assert first_question in state(pad)["mistakes"]
        checks.append("Existing local records migrate; another device joins; active exam stays local")

        for context in [phone_context, pad_context]:
            context.set_offline(True)
        answer_one(phone, True)
        answer_one(pad, False)
        assert len(state(phone)["attempts"]) == 2
        assert len(state(pad)["attempts"]) == 2
        for context in [phone_context, pad_context]:
            context.set_offline(False)
        sync(phone)
        sync(pad)
        sync(phone)
        count(phone, 3)
        count(pad, 3)
        checks.append("Offline answers on phone/tablet merge without duplication or loss")

        navigate(phone, "mistakes")
        action(phone, "star-item").click()
        starred_id = next(k for k, v in state(phone)["mistakes"].items() if v["starred"])
        sync(phone)
        sync(pad)
        navigate(pad, "mistakes")
        pad.locator(f'[data-action="star-item"][data-id="{starred_id}"]').click()
        sync(pad)
        sync(phone)
        assert state(phone)["mistakes"][starred_id]["starred"] is False
        checks.append("Star and cancellation propagate across devices")

        for page, name in [(phone, "iphone"), (pad, "ipad")]:
            navigate(page, "settings")
            check_width(page)
            page.evaluate("window.scrollTo(0,0)")
            page.screenshot(path=str(ARTIFACTS / f"{name}-sync-settings.png"), full_page=True, animations="disabled")
        action(pad, "cloud-disconnect").click()
        action(pad, "cloud-confirm-disconnect").click()
        assert pad.evaluate("localStorage.getItem('hiyori-cloud-auth-v1')") is None
        assert len(state(pad)["attempts"]) == 0
        action(pad, "cloud-join").click()
        pad.locator("#cloud-code-input").fill("f" * 48)
        pad.locator("#cloud-join-submit").click()
        expect(pad.locator("#cloud-form-error")).to_contain_text("同步码")
        assert cloud.signups == 1
        action(pad, "close-modal").first.click()
        answer_one(pad, True)
        create_space(pad)
        assert cloud.signups == 2
        count(pad, 1)
        sync(phone)
        count(phone, 3)
        checks.append("Wrong code never signs up; disconnect and new space keep users separate")
        assert not errors, errors
        browser.close()
    report = {"passed": True, "checks": checks, "browserErrors": errors, "backend": "simulated"}
    (ARTIFACTS / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
