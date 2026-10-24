"""Reproduce review findings against the unmodified userscript in headless Chromium.

Run: python review/reproduce.py
Requires Python Playwright and its Chromium browser. All requests use local fixtures.
These checks confirm existing bugs; they are not assertions of correct behavior.
"""
import json
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = subprocess.run(
    ['git', 'show', '29def6115c2b967d47ee5584bf2b127f7292beda:zhihu-voice-insight.user.js'],
    cwd=ROOT, check=True, capture_output=True,
).stdout.decode('utf-8')
MARKER = "  if (document.readyState === 'loading') {"
EXPORTS = """
  window.zvi = {
    cfg: cfg, buildStats: buildStats, evaluate: evaluate, getData: getData,
    loadMember: loadMember, showHover: showHover, aiAnalyze: aiAnalyze,
    aiScore: aiScore, applyAction: applyAction, rescan: rescan, scan: scan,
    cache: function () { return cache; }, lenCache: function () { return lenCache; }
  };
"""
EXPOSED = SOURCE[:SOURCE.index(MARKER)] + EXPORTS + '})();'
BOOT_EXPOSED = SOURCE.replace(MARKER, EXPORTS + MARKER)
HTML = """<!doctype html><html><body>
<div class="ContentItem AnswerItem">
  <div class="AuthorInfo"><a href="https://www.zhihu.com/people/alice">Alice</a></div>
  <div class="RichContent"><div class="RichText">An answer on the page.</div></div>
</div></body></html>"""
STUB = """() => {
  window.requests = [];
  window.store = {};
  window.apiMode = 'ok';
  window.totalAnswers = 12;
  window.responseDelay = 0;
  window.profileName = 'Alice';
  window.aiReply = '{}';
  window.answer = (id, ageSeconds, content = '<p>Hello world</p>') => ({
    type: 'answer', id, created_time: Math.floor(Date.now() / 1000) - ageSeconds,
    content, question: {id: 99, title: 'Question ' + id},
    author: {id: 'alice-id', name: 'Alice', url_token: 'alice'}
  });
  window.GM = {
    getValue: (k, d) => Promise.resolve(Object.hasOwn(store, k) ? store[k] : d),
    setValue: (k, v) => { store[k] = v; return Promise.resolve(); }
  };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = options => {
    requests.push({method: options.method, url: options.url});
    const u = new URL(options.url);
    let status = 200, payload = null, raw = null;
    if (options.method === 'POST') {
      payload = {choices: [{message: {content: aiReply}}]};
    } else if (u.pathname.startsWith('/people/')) {
      raw = window.fallbackHtml || '<html>Access denied</html>';
    } else if (apiMode === 'all-fail') {
      status = 403; payload = {error: {message: 'Forbidden'}};
    } else if (/\\/members\\/[^/]+$/.test(u.pathname)) {
      payload = {id: 'alice-id', name: profileName, url_token: 'alice',
        answer_count: totalAnswers, articles_count: 0,
        created: Math.floor(Date.now() / 1000) - 86400 * 365};
    } else if (apiMode === 'lists-fail') {
      status = 403; payload = {error: {message: 'Forbidden'}};
    } else if (u.pathname.endsWith('/answers')) {
      const limit = Number(u.searchParams.get('limit') || 20);
      payload = {data: Array.from({length: Math.min(limit, totalAnswers)},
        (_, i) => answer(i + 1, i * 10)), paging: {is_end: totalAnswers <= limit,
          next: 'https://www.zhihu.com/api/v4/members/alice/answers?offset=' + limit}};
    } else if (u.pathname.endsWith('/articles')) {
      payload = {data: [], paging: {is_end: true}};
    } else {
      payload = {content: '<p>Hello world</p>'};
    }
    setTimeout(() => options.onload({status, responseText: raw ?? JSON.stringify(payload)}), responseDelay);
  };
}"""

findings = []


def record(name, evidence, reproduced):
    if not reproduced:
        raise AssertionError(f'Could not reproduce {name}: {evidence}')
    findings.append({'finding': name, 'reproduced': True, 'evidence': evidence})
    print(f'REPRODUCED: {name}', flush=True)


def page_for(browser, boot=False, html=HTML):
    page = browser.new_page()
    page.set_content(html)
    page.wait_for_load_state('networkidle')
    page.evaluate(STUB)
    if not boot:
        page.evaluate(EXPOSED)
    return page


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # Real boot and delegated button handling, using the default configuration.
    page = page_for(browser, boot=True)
    page.evaluate(BOOT_EXPOSED)
    page.wait_for_selector('.zvi-collapsed')
    evidence = page.evaluate("() => ({action: zvi.cfg.action, collapsed: document.querySelectorAll('.zvi-collapsed').length})")
    record('Default action contradicts documented mark-only default', evidence,
           evidence == {'action': 'collapse', 'collapsed': 1})
    page.locator('[data-zvi-act="wl"]').click()
    evidence = page.evaluate("() => ({whitelist: zvi.cfg.whitelist, collapsed: document.querySelectorAll('.zvi-collapsed').length, host: !!document.querySelector('[data-zvi-act=wl]').closest('[data-zvi-inline]')})")
    record('Do-not-block button cannot resolve the author token', evidence,
           evidence['whitelist'] == [] and evidence['collapsed'] == 1 and not evidence['host'])
    page.close()

    # No page content changes or authors: only the script's own badge mutates.
    page = page_for(browser, boot=True, html='<html><body></body></html>')
    page.evaluate(BOOT_EXPOSED)
    page.evaluate("""() => {
      window.badgeWrites = 0;
      new MutationObserver(() => badgeWrites++).observe(document.querySelector('#zvi-fab'), {childList: true});
    }""")
    page.wait_for_timeout(3900)
    evidence = page.evaluate('() => ({badgeWrites, requests: requests.length})')
    record('MutationObserver perpetually retriggers scanning on an idle page', evidence,
           evidence['badgeWrites'] >= 3 and evidence['requests'] == 0)
    page.close()

    page = page_for(browser)
    evidence = page.evaluate("""async () => {
      apiMode = 'lists-fail';
      const data = await zvi.getData('alice');
      return {name: data.profile.name, fetched: data.stats.totalFetched,
        error: data.error || null, fallbackRequests: requests.filter(r => r.url.includes('/people/')).length,
        cachedAsSuccess: !!zvi.cache().alice};
    }""")
    record('List API failures skip fallback and are cached as empty success', evidence,
           evidence['fetched'] == 0 and evidence['fallbackRequests'] == 0 and evidence['cachedAsSuccess'])
    page.close()

    page = page_for(browser)
    evidence = page.evaluate("""async () => {
      apiMode = 'all-fail';
      const stranger = {type: 'people', id: 'other-id', name: 'Other user', url_token: 'other', answer_count: 1};
      const target = {type: 'people', id: 'alice-id', name: 'Alice', url_token: 'alice', answer_count: 1};
      const otherAnswer = {...answer(999, 5), author: stranger};
      fallbackHtml = '<script id="js-initialData">' + JSON.stringify({
        people: [stranger, target], answers: [otherAnswer, answer(1, 20)]
      }) + '</scr' + 'ipt>';
      const data = await zvi.getData('alice');
      return {requestedToken: data.token, profileToken: data.profile.urlToken,
        profileName: data.profile.name, answerIds: data.stats.recent.map(x => x.id)};
    }""")
    record('HTML fallback attributes other users and answers to the target', evidence,
           evidence['profileToken'] == 'other' and '999' in evidence['answerIds'])
    page.close()

    page = page_for(browser)
    evidence = page.evaluate("""async () => {
      const before = await zvi.getData('alice');
      const requestsBefore = requests.length;
      Object.assign(zvi.cfg, {showLimit: 10, countMode: 'word'});
      Object.assign(zvi.cfg.llm, {enabled: true, baseUrl: 'https://model.invalid/v1', model: 'new-model'});
      const after = await zvi.getData('alice');
      return {configuredShowLimit: zvi.cfg.showLimit, actualRecent: after.stats.recent.length,
        textsForAI: after.stats.texts.length, actualAvgLen: after.stats.avgLen,
        expectedWordLength: 2, requestsBefore, requestsAfter: requests.length, fromCache: after.fromCache};
    }""")
    record('Configuration changes reuse incompatible computed-data cache', evidence,
           evidence['actualRecent'] == 5 and evidence['textsForAI'] == 0
           and evidence['actualAvgLen'] != 2 and evidence['requestsAfter'] == evidence['requestsBefore'])
    page.close()

    page = page_for(browser)
    evidence = page.evaluate("""async () => {
      totalAnswers = 60;
      const data = await zvi.loadMember('alice');
      return {knownPostsInFixture: totalAnswers, displayed7Days: data.stats.d7,
        displayed30Days: data.stats.d30, sample: data.stats.totalFetched,
        answerRequests: requests.filter(r => /\\/answers\\?/.test(r.url)).length};
    }""")
    record('Seven/thirty-day totals silently stop at the first API page', evidence,
           evidence['displayed7Days'] == 20 and evidence['displayed30Days'] == 20
           and evidence['answerRequests'] == 1)
    page.close()

    page = page_for(browser)
    evidence = page.evaluate("""() => {
      const answers = Array.from({length: 10}, (_, i) => ({...answer(i + 1, i * 86400 * 2, ''), excerpt: 'x'.repeat(30)}));
      const stats = zvi.buildStats({}, answers, [], {});
      return {avgLen: stats.avgLen, allApproximate: stats.recent.every(x => x.approx),
        reasons: zvi.evaluate({stats}).reasons};
    }""")
    record('Excerpt lengths trigger short-post blocking as if they were full text', evidence,
           evidence['allApproximate'] and any('短句灌水' in s for s in evidence['reasons']))
    page.close()

    page = page_for(browser)
    evidence = page.evaluate("""async () => {
      Object.assign(zvi.cfg.llm, {enabled: true, baseUrl: 'https://model.invalid/v1', model: 'model-a'});
      aiReply = '{}';
      const empty = await zvi.aiAnalyze('alice', ['Some public text']);
      zvi.cfg.llm.model = 'model-b';
      aiReply = JSON.stringify({templated: 0.9});
      const changedModel = await zvi.aiAnalyze('alice', ['Different text']);
      return {emptyScore: empty.score, missing: empty.missing.length, error: empty.error || null,
        configuredModel: zvi.cfg.llm.model, actualModel: changedModel.model,
        fromCache: changedModel.fromCache, posts: requests.filter(r => r.method === 'POST').length};
    }""")
    record('Empty model output is accepted and cached as a zero score', evidence,
           evidence['emptyScore'] == 0 and evidence['missing'] == 7 and evidence['error'] is None)
    record('Model changes reuse the previous model and text result', evidence,
           evidence['configuredModel'] != evidence['actualModel'] and evidence['posts'] == 1)
    page.close()

    page = page_for(browser)
    page.evaluate("() => { zvi.cfg.mode = 'hover'; zvi.showHover(document.querySelector('a'), 'alice'); }")
    page.wait_for_function("document.body.lastElementChild.textContent.includes('Alice')")
    evidence = page.evaluate("""() => {
      const card = document.body.lastElementChild;
      const link = card.querySelector('a');
      const rect = link.getBoundingClientRect();
      return {pointerEvents: getComputedStyle(card).pointerEvents,
        linkReceivesPointer: document.elementFromPoint(rect.x + 2, rect.y + 2) === link};
    }""")
    record('Hover-card links cannot receive mouse input', evidence,
           evidence['pointerEvents'] == 'none' and not evidence['linkReceivesPointer'])
    page.close()

    # Pause while the initial API calls are still pending; old callbacks still mount.
    page = page_for(browser, boot=True)
    page.evaluate('() => { responseDelay = 1000; }')
    page.evaluate(BOOT_EXPOSED)
    page.wait_for_function('requests.length === 3')
    page.locator('#zvi-fab').click()
    page.locator('[data-k="mode"]').select_option('off')
    page.locator('[data-act="save"]').click()
    page.wait_for_selector('.zvi-inline', state='attached')
    evidence = page.evaluate("() => ({mode: zvi.cfg.mode, panels: document.querySelectorAll('.zvi-inline').length, collapsed: document.querySelectorAll('.zvi-collapsed').length})")
    record('In-flight scans still mount panels after switching off', evidence,
           evidence['mode'] == 'off' and evidence['panels'] > 0)
    page.close()

    browser_version = browser.version
    browser.close()

result = {'sourceCommit': '29def6115c2b967d47ee5584bf2b127f7292beda',
          'browser': browser_version, 'network': 'All requests mocked locally',
          'findings': findings}
out = Path(__file__).with_name('results.json')
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{len(findings)} findings reproduced. Evidence: {out}')
