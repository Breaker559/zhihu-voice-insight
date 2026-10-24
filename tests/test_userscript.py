"""Browser regressions for safe blocking and frequency evidence.

Run: python -m unittest discover -s tests -v
Requires Python Playwright and Chromium. All HTTP/GM requests are local fixtures.
"""
import json
import subprocess
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'zhihu-voice-insight.user.js').read_text(encoding='utf-8')
MARKER = "  if (document.readyState === 'loading') {"
EXPORTS = """window.zvi = {cfg, buildStats, evaluate, locate, getData, rescan,
  renderBurstEvidence, applyAction, pageAuthors};
"""
EXPOSED = SOURCE[:SOURCE.index(MARKER)] + EXPORTS + '})();'
BOOT = SOURCE.replace(MARKER, EXPORTS + MARKER)


def card(token, identity=None):
    return f'''<div class="List-item"><div class="ContentItem AnswerItem" id="{identity or token}">
      <div class="AuthorInfo"><a href="https://www.zhihu.com/people/{token}">头像</a>
      <a href="https://www.zhihu.com/people/{token}">{token}</a></div>
      <div class="RichContent"><div class="RichText">{token} 的回答正文，应该只影响这一条。
      <a href="https://www.zhihu.com/people/mentioned">正文中提到的其他人</a></div></div>
    </div></div>'''


HTML = '''<!doctype html><html><head><meta charset="utf-8"><style>
body {font:15px/1.7 "Microsoft YaHei",sans-serif;margin:0;background:#f6f7f9;color:#333;}
header {background:#fff;padding:12px 28px;border-bottom:1px solid #ddd;}
main {max-width:780px;margin:24px auto;padding:0 20px;}
.List-item {background:white;margin:16px 0;padding:18px;border-radius:8px;}
.AuthorInfo {font-weight:600;margin-bottom:8px;} a {color:#14448c;}
</style></head><body>
<header><a id="nav-user" href="https://www.zhihu.com/people/menu-user">页头个人中心</a> · 本地回归样例</header>
<main id="layout"><h1>知乎卡片与高频发言测试</h1><div id="feed">''' + card('alice') + card('bob') + '''</div>
<aside><a href="https://www.zhihu.com/people/sidebar-user">侧栏推荐用户</a></aside></main></body></html>'''

STUB = r'''() => {
  window.requests = [];
  window.store = {};
  window.delay = 0;
  window.apiMode = 'ok';
  window.now = Math.floor(Date.now() / 1000);
  window.post = (token, id, age, content = '<p>' + '真实正文'.repeat(30) + '</p>', kind = 'answer') => ({
    type: kind, id, created_time: now - age, created: now - age,
    content, title: '发言 ' + id, question: {id: 123, title: '问题 ' + id},
    author: {id: token + '-id', name: token, url_token: token}
  });
  window.fixtures = {
    alice: Array.from({length: 12}, (_, i) => post('alice', i + 1, i * 10)),
    bob: Array.from({length: 3}, (_, i) => post('bob', i + 20, i * 3 * 86400)),
    'menu-user': Array.from({length: 6}, (_, i) => post('menu-user', i + 40, i * 10))
  };
  window.GM = {
    getValue: (k, d) => Promise.resolve(Object.hasOwn(store, k) ? store[k] : d),
    setValue: (k, v) => { store[k] = v; return Promise.resolve(); }
  };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = options => {
    requests.push(options.url);
    const url = new URL(options.url);
    const match = url.pathname.match(/\/members\/([^/]+)/);
    const token = match && decodeURIComponent(match[1]);
    let status = 200, data, raw;
    if (url.pathname.startsWith('/people/')) raw = window.fallbackHtml || '<html>Access denied</html>';
    else if (apiMode === 'all-fail') {status = 403; data = {error: {message: 'Forbidden'}};}
    else if (/\/members\/[^/]+$/.test(url.pathname)) data = {id: token + '-id', name: token,
      url_token: token, answer_count: (fixtures[token] || []).length, articles_count: 0,
      created: now - 86400 * 365};
    else if (apiMode === 'lists-fail') {status = 403; data = {error: {message: 'Forbidden'}};}
    else if (url.pathname.endsWith('/answers')) data = {data: (fixtures[token] || []).slice(0, Number(url.searchParams.get('limit'))), paging: {is_end: true}};
    else if (url.pathname.endsWith('/articles')) data = {data: [], paging: {is_end: true}};
    else data = {content: '<p>' + '真实正文'.repeat(30) + '</p>'};
    setTimeout(() => options.onload({status, responseText: raw === undefined ? JSON.stringify(data) : raw}), delay);
  };
}'''


class UserscriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1280, 'height': 1000})
        self.page_errors = []
        self.page.on('pageerror', lambda e: self.page_errors.append(str(e)))
        self.page.set_content(HTML)
        self.page.wait_for_load_state('networkidle')
        self.page.evaluate(STUB)

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.page_errors, [], 'Unexpected JavaScript error')

    def boot(self, config=None, source=BOOT):
        if config is not None:
            self.page.evaluate('(cfg) => { store.zvi_cfg_v2 = JSON.stringify(cfg); }', config)
        self.page.evaluate(source)

    def wait_cards(self, count=2):
        self.page.wait_for_function('(n) => document.querySelectorAll(".zvi-inline").length >= n', arg=count)

    def assert_layout_visible(self):
        for selector in ('html', 'body', 'header', '#layout', '#feed', '#bob .RichText', '#zvi-fab'):
            self.assertTrue(self.page.locator(selector).is_visible(), selector)
        self.assertEqual(self.page.locator('body[data-zvi], html[data-zvi], main[data-zvi]').count(), 0)

    def test_original_page_disappearance_is_reproduced(self):
        original = subprocess.run(['git', 'show', '29def6115c2b967d47ee5584bf2b127f7292beda:zhihu-voice-insight.user.js'],
                                  cwd=ROOT, check=True, capture_output=True).stdout.decode('utf-8')
        self.boot({'action': 'hide'}, source=original)
        self.page.wait_for_function('document.body.classList.contains("zvi-hidden")')
        self.assertFalse(self.page.locator('header').is_visible())

    def test_collapse_only_affects_target_card_and_has_recovery(self):
        self.boot({'action': 'collapse'})
        self.wait_cards()
        self.assert_layout_visible()
        self.assertFalse(self.page.locator('#alice .RichText').is_visible())
        self.assertTrue(self.page.locator('#alice > .zvi-bar').is_visible())
        self.assertEqual(self.page.locator('.zvi-inline').count(), 2, 'Avatar and nickname must not create duplicate panels')
        self.page.locator('#alice [data-zvi-act="unfold"]').click()
        self.assertTrue(self.page.locator('#alice .RichText').is_visible())
        self.page.evaluate('zvi.rescan()')
        self.wait_cards()
        self.assertTrue(self.page.locator('#alice .RichText').is_visible(), 'Temporary reveal survives rescanning')

    def test_hide_keeps_page_and_author_list_recovery(self):
        self.boot({'action': 'hide'})
        self.wait_cards()
        self.assert_layout_visible()
        self.assertFalse(self.page.locator('#alice').is_visible())
        self.page.locator('#zvi-fab').click()
        self.assertEqual(self.page.locator('.zvi-author-entry').count(), 1)
        self.page.locator('.zvi-author-entry > summary').click()
        self.page.locator('.zvi-author-entry [data-zvi-act="unfold"]').click()
        self.assertTrue(self.page.locator('#alice .RichText').is_visible())

    def test_whitelist_restores_all_cards_of_the_author(self):
        self.page.locator('#feed').evaluate('(el, html) => el.insertAdjacentHTML("beforeend", html)', card('alice', 'alice-second'))
        self.boot({'action': 'collapse'})
        self.wait_cards(3)
        self.page.locator('#alice > .zvi-bar [data-zvi-act="wl"]').click()
        self.assertTrue(self.page.locator('#alice .RichText').is_visible())
        self.assertTrue(self.page.locator('#alice-second .RichText').is_visible())
        saved = self.page.evaluate('JSON.parse(store.zvi_cfg_v2)')
        self.assertIn('alice', saved['whitelist'])
        self.page.evaluate('zvi.rescan()')
        self.wait_cards(3)
        self.assertEqual(self.page.locator('.zvi-collapsed').count(), 0)

    def test_default_mark_and_manual_block_with_rules_disabled(self):
        self.boot({'burst': {'enabled': False}})
        self.wait_cards()
        self.assertTrue(self.page.locator('#alice .RichText').is_visible())
        self.page.locator('#alice [data-zvi-act="detail"]').click()
        self.page.locator('#alice [data-zvi-act="block"]').click()
        self.page.wait_for_selector('#alice.zvi-collapsed')
        self.assert_layout_visible()

    def test_multi_card_article_and_unknown_wrappers_are_never_blocked(self):
        self.page.evaluate('''() => {
          const feed = document.querySelector('#feed');
          const outer = document.createElement('article'); outer.id = 'outer'; outer.className = 'ContentItem';
          outer.innerHTML = '<a href="https://www.zhihu.com/people/menu-user">外层用户</a>';
          feed.parentElement.insertBefore(outer, feed); outer.appendChild(feed);
          document.querySelector('main').classList.add('ContentItem');
        }''')
        self.boot({'action': 'hide'})
        self.wait_cards()
        self.assertTrue(self.page.locator('#outer').is_visible())
        self.assert_layout_visible()
        self.assertEqual(self.page.locator('#outer[data-zvi]').count(), 0)

    def test_single_article_is_supported(self):
        self.page.set_content('<html><body><article class="Post" id="post"><div class="Post-Author"><a href="https://www.zhihu.com/people/alice">alice</a></div><div class="Post-RichText">文章正文</div></article><footer>页脚</footer></body></html>')
        self.boot({'action': 'collapse'})
        self.wait_cards(1)
        self.assertFalse(self.page.locator('#post .Post-RichText').is_visible())
        self.assertTrue(self.page.locator('footer').is_visible())
        self.assertTrue(self.page.locator('#post > .zvi-bar').is_visible())

    def test_burst_evidence_includes_older_posts_outside_recent_limit(self):
        self.page.evaluate('''() => {
          fixtures.alice = [post('alice', 'recent-1', 10), post('alice', 'recent-2', 86410),
            post('alice', 'recent-3', 172810), ...Array.from({length: 4}, (_, i) => post('alice', 'burst-' + i, 10 * 86400 + (3-i) * 15))];
        }''')
        self.boot({'showLimit': 2, 'action': 'collapse'})
        self.wait_cards()
        self.page.locator('#alice > .zvi-bar .zvi-evidence > summary').click()
        proof = self.page.locator('#alice > .zvi-bar .zvi-proof-list')
        self.assertEqual(proof.count(), 1, 'Identical windows should share one list')
        self.assertEqual(proof.locator('li').count(), 4)
        self.assertIn('问题 burst-0', proof.inner_text())
        self.assertNotIn('recent-1', proof.inner_text())
        self.assertIn('距上一条 15 秒', proof.inner_text())
        self.assertRegex(proof.inner_text(), r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d')
        self.page.locator('#zvi-fab').click()
        self.page.locator('.zvi-author-entry > summary').click()
        self.page.locator('.zvi-author-entry .zvi-evidence > summary').click()
        out = ROOT / 'review' / '2.8.0-evidence.png'
        out.parent.mkdir(exist_ok=True)
        self.page.screenshot(path=str(out), full_page=True)

    def test_window_boundaries_deduplication_and_mixed_content(self):
        self.page.evaluate(EXPOSED)
        result = self.page.evaluate('''() => {
          const a = post('alice', 1, 100);
          const stats = zvi.buildStats({}, [a, a, post('alice', 2, 160), post('alice', 3, 161)],
            [post('alice', 1, 130, '<p>正文</p>', 'article')], {showLimit: 1});
          return {total: stats.totalFetched, minute: stats.burst.m1,
            entries: stats.windows.m1.items.map(x => x.kind + ':' + x.id), recent: stats.recent.length};
        }''')
        self.assertEqual(result['total'], 4)
        self.assertEqual(result['minute'], 3)
        self.assertEqual(result['entries'], ['ans:2', 'art:1', 'ans:1'])
        self.assertEqual(result['recent'], 1)

    def test_excerpt_only_data_cannot_trigger_short_post_blocking(self):
        self.page.evaluate(EXPOSED)
        result = self.page.evaluate('''() => {
          const answers = Array.from({length:10}, (_, i) => ({...post('alice', i, i * 172800, ''), excerpt:'x'.repeat(30)}));
          return zvi.evaluate({stats:zvi.buildStats({}, answers, [], {})});
        }''')
        self.assertFalse(result['hit'])

    def test_config_changes_invalidate_statistics_and_include_evidence(self):
        self.page.evaluate(EXPOSED)
        result = self.page.evaluate('''async () => {
          await zvi.getData('alice');
          zvi.cfg.showLimit = 10; zvi.cfg.snipChars = 0; zvi.cfg.llm.enabled = true;
          const data = await zvi.getData('alice');
          return {recent:data.stats.recent.length, texts:data.stats.texts.length,
            snippets:data.stats.samples.some(x => x.snip), windows:Object.keys(data.stats.windows).length, requests:requests.length};
        }''')
        self.assertEqual(result, {'recent': 10, 'texts': 6, 'snippets': False, 'windows': 4, 'requests': 6})

    def test_failed_lists_are_not_silently_cached_as_no_posts(self):
        self.page.evaluate(EXPOSED)
        result = self.page.evaluate('''async () => {
          apiMode='lists-fail'; const data=await zvi.getData('alice');
          apiMode='ok'; const good=await zvi.getData('alice');
          return {error:data.error, total:good.stats.totalFetched, fallback:requests.filter(x=>x.includes('/people/')).length};
        }''')
        self.assertTrue(result['error'])
        self.assertEqual(result['total'], 12)
        self.assertEqual(result['fallback'], 1)

    def test_fallback_rejects_other_authors_before_scoring(self):
        self.page.evaluate(EXPOSED)
        result = self.page.evaluate('''async () => {
          apiMode='all-fail';
          const people = ['other','alice'].map(token=>({type:'people',id:token+'-id',name:token,url_token:token}));
          fallbackHtml='<script id="js-initialData">'+JSON.stringify({people, answers:[post('other',99,10),post('alice',1,20)]})+'</scr'+'ipt>';
          const data=await zvi.getData('alice');
          return {name:data.profile.name, ids:data.stats.samples.map(x=>x.id)};
        }''')
        self.assertEqual(result, {'name': 'alice', 'ids': ['1']})

    def test_disabling_while_requests_pending_prevents_late_mounts(self):
        self.page.evaluate('delay = 1100')
        self.boot({'action': 'hide'})
        self.page.wait_for_function('requests.length >= 3')
        self.page.locator('#zvi-fab').click()
        self.page.locator('[data-k="mode"]').select_option('off')
        self.page.locator('[data-act="save"]').click()
        self.page.wait_for_timeout(1500)
        self.assertEqual(self.page.locator('.zvi-inline, .zvi-hidden, .zvi-collapsed').count(), 0)
        self.assert_layout_visible()

    def test_idle_page_does_not_keep_rewriting_badge(self):
        self.boot()
        self.wait_cards()
        self.page.wait_for_timeout(400)
        self.page.evaluate('''() => {
          window.badgeWrites=0;
          new MutationObserver(()=>badgeWrites++).observe(document.querySelector('#zvi-fab'), {childList:true});
        }''')
        self.page.wait_for_timeout(2600)
        self.assertEqual(self.page.evaluate('badgeWrites'), 0)

    def test_dynamic_cards_and_author_reuse_do_not_hide_the_wrong_author(self):
        self.boot({'action': 'hide'})
        self.wait_cards()
        self.page.locator('#feed').evaluate('(el, html) => el.insertAdjacentHTML("beforeend", html)', card('alice', 'new-alice'))
        self.page.wait_for_selector('#new-alice.zvi-hidden', state='attached')
        self.page.locator('#new-alice .AuthorInfo a').evaluate_all('(links) => links.forEach(a => a.href="https://www.zhihu.com/people/bob")')
        self.page.wait_for_function('document.querySelector("#new-alice").getAttribute("data-zvi") === "bob"')
        self.assertTrue(self.page.locator('#new-alice .RichText').is_visible())
        self.assert_layout_visible()

    def test_evidence_html_is_escaped_and_panel_fits_mobile(self):
        self.page.set_viewport_size({'width': 375, 'height': 812})
        self.page.evaluate('fixtures.alice.forEach(p => p.question.title = "<img src=x onerror=alert(1)>")')
        self.boot()
        self.wait_cards()
        self.page.locator('#zvi-fab').click()
        self.page.locator('.zvi-author-entry > summary').click()
        self.page.locator('.zvi-author-entry .zvi-evidence > summary').click()
        self.assertEqual(self.page.locator('.zvi-proof-list img').count(), 0)
        box = self.page.locator('#zvi-panel').bounding_box()
        self.assertGreaterEqual(box['x'], 0)
        self.assertLessEqual(box['x'] + box['width'], 375)


if __name__ == '__main__':
    unittest.main(verbosity=2)
