#!/usr/bin/env python3
"""Opt-in checks against the configured real Supabase project.

RUN_LIVE_SYNC=1 python3 tests/cloud_live.py [--api-only | --browser-only]

Creates only temporary test accounts and deletes their exact UUIDs in finally.
No credentials are written to reports or screenshots. Browser requests use a
Python urllib bridge so the managed proxy's trusted CA remains verified.
"""
from copy import deepcopy
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path('/workspace/.japanstudy-onboarding/sync-live')


class CheckError(Exception):
    """Only explicitly safe diagnostic text belongs in this exception."""


class LiveCloud:
    def __init__(self):
        source = (ROOT / 'assets/cloud-config.js').read_text()
        self.config = json.loads(source.split('export const CLOUD_CONFIG = ', 1)[1].rstrip().removesuffix(';'))
        self.url = self.config['url'].rstrip('/')
        parsed = urllib.parse.urlsplit(self.url)
        if parsed.scheme != 'https' or not re.fullmatch(r'[a-z]{20}\.supabase\.co', parsed.netloc):
            raise CheckError('Unexpected project URL; refusing live operations')
        self.ref = parsed.netloc.split('.')[0]
        self.management_token = os.environ.get('SUPABASE_ACCESS_TOKEN')
        if not self.management_token:
            raise CheckError('SUPABASE_ACCESS_TOKEN is required for exact test-account cleanup')
        self.created = set()
        self.checks = []
        self.stage = 'preflight'
        self.bridge_failures = []

    def checked(self, name):
        self.checks.append(name)
        print('PASS', name, flush=True)

    def request(self, path, body=None, token=None, method=None, headers=None):
        request_headers = {'apikey': self.config['publishableKey'], 'Content-Type': 'application/json'}
        if token:
            request_headers['Authorization'] = 'Bearer ' + token
        request_headers.update(headers or {})
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                                         headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None, dict(response.headers)
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                data = json.loads(raw)
            except ValueError:
                data = None
            return error.code, data, dict(error.headers)

    def expect_http(self, response, allowed, label):
        status, data, _ = response
        if status not in allowed:
            code = data.get('code', data.get('error_code', 'unknown')) if isinstance(data, dict) else 'non-json'
            safe_code = str(code) if re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', str(code)) else 'redacted'
            raise CheckError(f'{label}: HTTP {status}, error code {safe_code}')
        return data

    def sql(self, query):
        request = urllib.request.Request('https://api.supabase.com/v1/projects/' + self.ref + '/database/query',
            data=json.dumps({'query': query, 'read_only': False}).encode(),
            headers={'Authorization': 'Bearer ' + self.management_token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise CheckError(f'Management SQL returned HTTP {error.code}') from None

    @staticmethod
    def credentials(code):
        return {'email': hashlib.sha256(code.encode()).hexdigest()[:48] + '@sync.hiyori.invalid', 'password': code}

    def remember_signup(self, data):
        if isinstance(data, dict) and isinstance(data.get('user'), dict) and data['user'].get('id'):
            self.created.add(str(uuid.UUID(data['user']['id'])))

    def signup(self):
        code = secrets.token_hex(24)
        response = self.request('/auth/v1/signup', self.credentials(code))
        # A signup without an immediate session may still have created a user.
        self.remember_signup(response[1])
        result = self.expect_http(response, [200, 201], 'Signup')
        if not result.get('access_token') or not result.get('refresh_token'):
            raise CheckError('Signup did not return a session; confirm Auth autoconfirm configuration')
        return code, result

    def rpc(self, token, revision, document=None):
        body = {'expected_revision': revision}
        if document is not None:
            body['document'] = document
        return self.request('/rest/v1/rpc/hiyori_sync', body, token)

    def cleanup(self):
        if not self.created:
            return 0
        exact = ','.join("'" + str(uuid.UUID(value)) + "'::uuid" for value in sorted(self.created))
        self.sql('delete from auth.users where id in (' + exact + ');')
        result = self.sql('select count(*)::int as remaining from auth.users where id in (' + exact + ');')
        if not result or result[0]['remaining'] != 0:
            raise CheckError('Temporary test-account cleanup could not be verified')
        removed = len(self.created)
        self.created.clear()
        return removed

    def browser_route(self, route):
        """Relay to the real API over inherited proxy/TLS trust, with no mocking."""
        request = route.request
        if not request.url.startswith(self.url + '/'):
            route.abort()
            self.bridge_failures.append('Unexpected request destination')
            return
        allowed = {'apikey', 'authorization', 'content-type', 'origin', 'accept',
                   'access-control-request-method', 'access-control-request-headers'}
        headers = {k: v for k, v in request.headers.items() if k in allowed}
        raw_request = urllib.request.Request(request.url, data=request.post_data_buffer,
                                              method=request.method, headers=headers)
        try:
            try:
                response = urllib.request.urlopen(raw_request, timeout=25)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                if urllib.parse.urlsplit(response.geturl()).netloc != urllib.parse.urlsplit(self.url).netloc:
                    raise CheckError('Unexpected API redirect')
                raw = response.read()
                if '/auth/v1/signup' in request.url and response.status in (200, 201):
                    self.remember_signup(json.loads(raw))
                response_headers = {k: v for k, v in response.headers.items()
                                    if k.lower() in {'content-type', 'access-control-allow-origin',
                                        'access-control-allow-methods', 'access-control-allow-headers',
                                        'access-control-allow-credentials', 'access-control-max-age'}}
                route.fulfill(status=response.status, headers=response_headers, body=raw)
        except Exception as error:
            self.bridge_failures.append(type(error).__name__)
            route.abort()


def api_checks(cloud):
    cloud.stage = 'Auth signup/signin/refresh'
    code_a, a = cloud.signup()
    _, b = cloud.signup()
    signed_in = cloud.expect_http(cloud.request('/auth/v1/token?grant_type=password', cloud.credentials(code_a)), [200], 'Same-code login')
    assert signed_in['user']['id'] == a['user']['id']
    refreshed = cloud.expect_http(cloud.request('/auth/v1/token?grant_type=refresh_token',
        {'refresh_token': signed_in['refresh_token']}), [200], 'Refresh session')
    assert refreshed['user']['id'] == a['user']['id']
    token_a, token_b = refreshed['access_token'], b['access_token']
    cloud.checked('Real Auth creates distinct accounts, same-code login and session refresh succeed')

    cloud.stage = 'CAS'
    empty = {'version': 1, 'attempts': [], 'mistakes': {}, 'history': []}
    initial = cloud.expect_http(cloud.rpc(token_a, -1), [200], 'Initial read')
    assert initial == {'ok': True, 'revision': 0, 'document': None}
    first = cloud.expect_http(cloud.rpc(token_a, 0, empty), [200], 'Initial write')
    assert first['ok'] and first['revision'] == 1
    stale = cloud.expect_http(cloud.rpc(token_a, 0, empty), [200], 'Stale write')
    assert stale['ok'] is False and stale['revision'] == 1
    updated = deepcopy(empty)
    updated['attempts'].append({'id': 'live-check:example', 'questionId': 'example', 'subject': 'verb',
        'level': 'N4', 'correct': True, 'answer': '書ける', 'time': 1000, 'day': '1970-01-01'})
    second = cloud.expect_http(cloud.rpc(token_a, 1, updated), [200], 'Next version')
    assert second['ok'] and second['revision'] == 2
    cloud.checked('Real CAS creates a row, rejects stale revision and preserves the current document')

    cloud.stage = 'RLS isolation'
    owner_a = str(uuid.UUID(a['user']['id']))
    table = '/rest/v1/hiyori_study_progress'
    cross_read = cloud.expect_http(cloud.request(table + '?user_id=eq.' + owner_a + '&select=user_id', token=token_b), [200], 'Cross-account read')
    assert cross_read == []
    cross_patch = cloud.expect_http(cloud.request(table + '?user_id=eq.' + owner_a,
        {'document': empty}, token_b, 'PATCH', {'Prefer': 'return=representation'}), [200], 'Cross-account patch')
    assert cross_patch == []
    cloud.expect_http(cloud.request(table, {'user_id': owner_a, 'document': empty}, token_b, 'POST'), [401, 403, 409], 'Cross-account insert')
    actual = cloud.expect_http(cloud.rpc(token_a, -1), [200], 'Read after attack')
    assert actual['revision'] == 2 and actual['document'] == updated
    own_b = cloud.expect_http(cloud.rpc(token_b, -1), [200], 'Other account read')
    assert own_b['document'] is None and own_b['revision'] == 0
    cloud.expect_http(cloud.request(table + '?select=user_id'), [401, 403], 'Anonymous table read')
    cloud.expect_http(cloud.rpc(None, -1), [401, 403], 'Anonymous RPC')
    cloud.expect_http(cloud.request(table, {'user_id': owner_a, 'document': empty}, method='POST'), [401, 403], 'Anonymous table write')
    cloud.checked('Real RLS blocks another account and anonymous clients from reading or changing a user row')

    cloud.stage = 'Document constraints'
    for malformed in [{}, {'version': 1, 'attempts': [], 'mistakes': [], 'history': []},
                      {'version': 1, 'attempts': [], 'mistakes': {}, 'history': [None] * 101}]:
        cloud.expect_http(cloud.rpc(token_a, 2, malformed), [400, 409, 422], 'Malformed document')
    actual = cloud.expect_http(cloud.rpc(token_a, -1), [200], 'Read after invalid writes')
    assert actual['revision'] == 2 and actual['document'] == updated
    cloud.checked('Database rejects malformed/oversized-history documents without replacing saved progress')


def browser_checks(cloud):
    from playwright.sync_api import sync_playwright, expect
    from browser_smoke import local_server, action, navigate, check_width
    from sync_browser import state, count, answer_one, sync, create_space, join_space

    cloud.stage = 'Browser two-device sync against real Supabase'
    errors = []
    with local_server(None) as local_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        try:
            contexts = [browser.new_context(viewport={'width': w, 'height': h}, is_mobile=True,
                has_touch=True, service_workers='block') for w, h in [(390, 844), (820, 1180)]]
            for context in contexts:
                context.route(cloud.url + '/**', cloud.browser_route)
            phone, pad = [context.new_page() for context in contexts]
            for page in [phone, pad]:
                page.set_default_timeout(30000)
                page.on('pageerror', lambda error: errors.append(type(error).__name__))
                page.goto(local_url + '/#settings')
                expect(page.locator('#cloud-panel')).to_be_visible()
            question_id = answer_one(phone, False)
            code = create_space(phone)
            join_space(pad, code)
            count(pad, 1)
            assert question_id in state(pad)['mistakes']
            assert state(pad)['session'] is None
            cloud.checked('Phone UI creates a real learning space; iPad connects and retrieves its existing wrong answer')

            cloud.stage = 'Browser real offline merge'
            for context in contexts:
                context.set_offline(True)
            answer_one(phone, True)
            answer_one(pad, False)
            assert len(state(phone)['attempts']) == 2 and len(state(pad)['attempts']) == 2
            for context in contexts:
                context.set_offline(False)
            sync(phone)
            sync(pad)
            sync(phone)
            count(phone, 3)
            count(pad, 3)
            navigate(phone, 'mistakes')
            action(phone, 'star-item').click()
            marked = next(k for k, v in state(phone)['mistakes'].items() if v['starred'])
            sync(phone)
            sync(pad)
            navigate(pad, 'mistakes')
            pad.locator(f'[data-action="star-item"][data-id="{marked}"]').click()
            sync(pad)
            sync(phone)
            assert state(phone)['mistakes'][marked]['starred'] is False
            cloud.checked('Real backend merges both offline devices and propagates star cancellation')

            for page, name in [(phone, 'iphone'), (pad, 'ipad')]:
                navigate(page, 'settings')
                check_width(page)
                assert not page.locator('#modal[open]').count()
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(ARTIFACTS / (name + '-real-sync.png')), full_page=True, animations='disabled')
            assert not errors and not cloud.bridge_failures
        finally:
            browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--api-only', action='store_true')
    modes.add_argument('--browser-only', action='store_true')
    args = parser.parse_args()
    if os.environ.get('RUN_LIVE_SYNC') != '1':
        print('SKIPPED: set RUN_LIVE_SYNC=1 to create temporary real accounts. No live check has passed.')
        return 0
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    cloud = None
    report = {'passed': False, 'backend': 'real Supabase',
              'browser_transport': 'Python urllib bridge with inherited proxy and TLS verification',
              'mode': 'api-only' if args.api_only else 'browser-only' if args.browser_only else 'full',
              'time': datetime.now(timezone.utc).isoformat()}
    try:
        cloud = LiveCloud()
        if not args.browser_only:
            api_checks(cloud)
        if not args.api_only:
            browser_checks(cloud)
        report['passed'] = True
    except Exception as error:
        report['failed_stage'] = cloud.stage if cloud else 'configuration'
        report['error_type'] = type(error).__name__
        if isinstance(error, CheckError):
            report['safe_error'] = str(error)
    finally:
        if cloud:
            report['checks'] = cloud.checks
            try:
                report['test_accounts_removed'] = cloud.cleanup()
                report['cleanup_verified'] = True
            except Exception as error:
                report['passed'] = False
                report['cleanup_verified'] = False
                report['cleanup_error_type'] = type(error).__name__
                if isinstance(error, CheckError):
                    report['safe_cleanup_error'] = str(error)
        target = ARTIFACTS / ('report-' + report['mode'] + '.json')
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
