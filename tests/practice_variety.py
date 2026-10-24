#!/usr/bin/env python3
"""Check practice coverage and repetition in isolated Chromium contexts."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_smoke import local_server, action, navigate, get_state, finish_practice, answer, check_width

OUT = Path('/workspace/.japanstudy-onboarding/practice-variety')


def begin(page, kind='words', subject='mixed', style='mixed'):
    navigate(page, 'practice')
    action(page, 'setup-' + kind).click()
    page.locator('#practice-count').select_option('10')
    if kind == 'words':
        page.locator('#word-subject').select_option(subject)
        page.locator('#practice-style').select_option(style)
    action(page, 'begin-practice').click()
    expect(page.locator('.question-card')).to_be_visible()
    return get_state(page)['session']['questions']


def base_ids(questions):
    return {q['id'].rsplit('-', 1)[0] for q in questions}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    checks, errors = [], []
    with local_server(None) as url, sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        try:
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True,
                                          has_touch=True, service_workers='block')
            page = context.new_page()
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.goto(url + '/#practice')
            # Simulate a learner who finished the original N3 banks. Existing IDs
            # must count as covered, and new lessons must draw the added content.
            backup = page.evaluate('''async () => {
              const {emptyState,recordAttempt}=await import('./assets/core.js');
              const {VOCAB,KANJI}=await import('./assets/word-data.js');
              const {GRAMMAR}=await import('./assets/grammar-data.js');
              const {wordQuestion}=await import('./assets/word-questions.js');
              const s=emptyState();s.settings.level='N3';
              for(const [bank,subject,limit] of [[VOCAB,'vocab',30],[KANJI,'kanji',20]])
                for(const row of bank.filter(x=>x.level==='N3'&&Number(x.id.split('-').at(-1))<=limit)) {
                  const q=wordQuestion(row,subject,'reading');recordAttempt(s,q,q.answer,'old-'+q.id,1000);
                }
              for(const q of GRAMMAR.filter(x=>x.level==='N3'&&Number(x.id.split('-').at(-1))<=20))
                recordAttempt(s,q,q.answer,'old-'+q.id,1000);
              return {type:'hiyori-backup',state:s};
            }''')
            # Restore through the UI so pagehide cannot overwrite externally
            # seeded storage with the app's still-empty in-memory state.
            navigate(page, 'settings')
            page.locator('#backup-file').set_input_files({
                'name': 'old-n3-progress.json', 'mimeType': 'application/json',
                'buffer': json.dumps(backup, ensure_ascii=False).encode(),
            })
            expect(action(page, 'confirm-backup')).to_be_visible()
            action(page, 'confirm-backup').click()
            navigate(page, 'practice')
            expect(action(page, 'setup-words')).to_contain_text('已练 50 / 480 词条')
            expect(action(page, 'setup-grammar')).to_contain_text('已练 20 / 100 题')
            checks.append('Old N3 records retain coverage instead of being reset by expansion')

            first = begin(page, subject='vocab', style='input')
            assert all(q['kind'] == 'input' and int(q['id'].split('-')[2]) > 30 for q in first)
            finish_practice(page)
            second = begin(page, subject='vocab', style='choice')
            assert not base_ids(first) & base_ids(second)
            finish_practice(page)
            page.reload()
            navigate(page, 'practice')
            expect(action(page, 'setup-words')).to_contain_text('已练 70 / 480 词条')
            checks.append('Completed words stay covered across format switches and reload; second lesson has no repeats')

            first_kanji = begin(page, subject='kanji', style='input')
            assert all(int(q['id'].split('-')[2]) > 20 for q in first_kanji)
            finish_practice(page)
            second_kanji = begin(page, subject='kanji', style='choice')
            assert not base_ids(first_kanji) & base_ids(second_kanji)
            finish_practice(page)
            checks.append('Kanji lessons use added material and do not repeat the preceding lesson')

            first_grammar = begin(page, kind='grammar')
            assert all(int(q['id'].split('-')[2]) > 20 for q in first_grammar)
            q = answer(page, False)
            expect(page.locator('.feedback .chosen-reason')).to_be_visible()
            expect(page.locator('.feedback .teaching')).to_contain_text(q['explanation'])
            finish_practice(page)
            second_grammar = begin(page, kind='grammar')
            assert not {q['id'] for q in first_grammar} & {q['id'] for q in second_grammar}
            finish_practice(page)
            checks.append('Grammar lessons avoid old/recent questions and still teach why a wrong answer is wrong')

            known_words = {a['questionId'].rsplit('-', 1)[0] for a in get_state(page)['attempts']
                           if a['subject'] in ('vocab', 'kanji')}
            known_grammar = {a['questionId'] for a in get_state(page)['attempts'] if a['subject'] == 'grammar'}
            navigate(page, 'home')
            action(page, 'daily').click()
            expect(page.locator('.question-card')).to_be_visible()
            daily = get_state(page)['session']['questions']
            assert not base_ids([q for q in daily if q['subject'] in ('vocab', 'kanji')]) & known_words
            assert not {q['id'] for q in daily if q['subject'] == 'grammar'} & known_grammar
            checks.append('Daily practice respects the same vocabulary, kanji and grammar history')

            navigate(page, 'practice')
            check_width(page)
            page.screenshot(path=str(OUT / 'iphone-coverage.png'), full_page=True, animations='disabled')
            page.set_viewport_size({'width': 820, 'height': 1180})
            check_width(page)
            page.screenshot(path=str(OUT / 'ipad-coverage.png'), full_page=True, animations='disabled')
            assert not errors, errors
        finally:
            browser.close()
    report = {'passed': True, 'checks': checks, 'browserErrors': errors}
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
