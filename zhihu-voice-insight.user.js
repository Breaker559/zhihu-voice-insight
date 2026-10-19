// ==UserScript==
// @name         知乎发言画像 · 发言频率/字数标注与刷屏屏蔽
// @namespace    zhihu-voice-insight
// @version      2.5.0
// @description  在知乎答主头像/昵称下方直接插入一条发言画像：近 7/30 天条数、平均间隔、正文字数、最近发言列表；自动识别「几分钟内连发多条、一小时内刷屏、新号高产、短句灌水」，可按规则折叠或隐藏其回答。
// @author       WorkBuddy
// @match        https://*.zhihu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_registerMenuCommand
// @connect      www.zhihu.com
// @connect      zhihu.com
// @connect      zhuanlan.zhihu.com
// @connect      api.zhihu.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ==================== 配置 ==================== */

  var DEFAULT_CFG = {
    mode: 'inline',          // inline = 头像下方内联标注；hover = 悬停卡片；off = 关闭
    fetchLimit: 20,          // 抓取最近多少条用于统计（知乎单页上限 20）
    showLimit: 5,            // 展开后列出多少条
    includeArticles: true,   // 是否把「文章」计入发言
    cacheMinutes: 30,
    exactLength: false,      // true = 为最近几条单独请求正文取精确字数（更慢）
    countMode: 'char',       // char = 字符数（中文口径）；word = 中日韩字符 + 英文单词
    maxPerPage: 15,          // 单页最多标注多少个作者

    burst: {
      enabled: true,
      min1: 2,               // 1 分钟内 ≥ N 条
      min5: 3,               // 5 分钟内 ≥ N 条
      hour: 4,               // 1 小时内 ≥ N 条
      day: 10,               // 24 小时内 ≥ N 条
      gapHours: 6,           // 平均间隔 < N 小时
      newDays: 30,           // 注册 ≤ N 天
      newPosts: 30,          // 且累计 ≥ N 条
      shortLen: 50,          // 平均字数 < N
      shortDays: 10          // 且近 30 天 ≥ N 条
    },
    action: 'collapse',      // mark = 仅标记；collapse = 折叠；hide = 隐藏
    whitelist: [],           // 永不屏蔽
    blocklist: []            // 手动屏蔽
  };

  var cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

  var CFG_KEY = 'zvi_cfg_v2';
  var CACHE_KEY = 'zvi_cache_v2';
  var LEN_KEY = 'zvi_len_v2';

  var cache = {};      // token -> { ts, data }
  var lenCache = {};   // answerId/articleId -> 字数
  var inflight = new Map();
  var pending = new Set();
  var API = 'https://www.zhihu.com/api/v4';

  // 关键：必须显式 include content，否则知乎只返回约 100 字的 excerpt
  var ANSWER_INCLUDE = 'data[*].content,excerpt,created_time,updated_time,voteup_count,comment_count,question,url';
  var ARTICLE_INCLUDE = 'data[*].content,excerpt,created,updated,voteup_count,comment_count,title,url';

  /* ==================== 文本处理 ==================== */

  var ENTITY_MAP = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013'
  };

  function decodeEntities(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, g) {
      if (Object.prototype.hasOwnProperty.call(ENTITY_MAP, g)) return ENTITY_MAP[g];
      if (g.charAt(0) === '#') {
        var code = (g.charAt(1) === 'x' || g.charAt(1) === 'X')
          ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    });
  }

  function stripHtml(html) {
    if (!html) return '';
    var s = String(html);
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|blockquote|h[1-6]|tr|section)>/gi, '\n');
    s = s.replace(/<img[^>]*>/gi, ' ');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/[\u200b-\u200f\ufeff]/g, '');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

  function countText(text) {
    if (!text) return 0;
    if (cfg.countMode === 'word') {
      var cjk = (text.match(CJK_RE) || []).length;
      var rest = text.replace(CJK_RE, ' ');
      var words = (rest.match(/[A-Za-z0-9][A-Za-z0-9'_.\-]*/g) || []).length;
      return cjk + words;
    }
    return text.replace(/\s/g, '').length;
  }

  /** 正文长度。返回 {len, approx} —— approx 表示拿到的是摘要/截断内容 */
  function measure(a) {
    var html = a.content || '';
    var approx = false;
    if (!html) { html = a.excerpt || ''; approx = true; }
    var t = stripHtml(html);
    if (/\u2026\s*$/.test(t)) approx = true;
    return { len: countText(t), approx: approx };
  }

  function plainText(html, n) {
    var t = stripHtml(html).replace(/\s+/g, ' ').trim();
    return n && t.length > n ? t.slice(0, n) + '\u2026' : t;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmtTime(ts) {
    if (!ts) return '\u672a\u77e5';
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '\u672a\u77e5';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 紧凑时间：今年省略年份 → 10-19 17:32；跨年保留 → 2025-12-31 17:32 */
  function fmtShort(ts) {
    if (!ts) return '\u672a\u77e5';
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '\u672a\u77e5';
    var sameYear = d.getFullYear() === new Date().getFullYear();
    return (sameYear ? '' : d.getFullYear() + '-') +
      pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function timeAgo(ts) {
    if (!ts) return '\u672a\u77e5';
    var diff = Math.floor(Date.now() / 1000) - Number(ts);
    if (diff < 0) diff = 0;
    if (diff < 60) return '\u521a\u521a';
    if (diff < 3600) return Math.floor(diff / 60) + '\u5206\u949f\u524d';
    if (diff < 86400) return Math.floor(diff / 3600) + '\u5c0f\u65f6\u524d';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + '\u5929\u524d';
    if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + '\u4e2a\u6708\u524d';
    return (diff / (86400 * 365)).toFixed(1) + '\u5e74\u524d';
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  function num() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return Number(v) || 0;
    }
    return 0;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function tokenFromHref(href) {
    if (!href) return null;
    var m = String(href).match(/\/people\/([A-Za-z0-9_\-\.]{1,64})(?:[\/\?#]|$)/);
    return m ? m[1] : null;
  }

  /* ==================== 网络 ==================== */

  function getText(url) {
    return new Promise(function (resolve) {
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'zh-CN,zh;q=0.9'
            },
            responseType: 'text',
            timeout: 20000,
            onload: function (r) {
              resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || '' });
            },
            onerror: function () { resolve({ ok: false, status: 0, text: '' }); },
            ontimeout: function () { resolve({ ok: false, status: 0, text: '' }); },
            onabort: function () { resolve({ ok: false, status: 0, text: '' }); }
          });
          return;
        } catch (e) { /* 落到 fetch */ }
      }
      fetch(url, { credentials: 'include' })
        .then(function (r) { return r.text().then(function (t) { resolve({ ok: r.ok, status: r.status, text: t }); }); })
        .catch(function () { resolve({ ok: false, status: 0, text: '' }); });
    });
  }

  function jsonOf(url) {
    return getText(url).then(function (r) {
      if (!r.ok || !r.text) return null;
      try { return JSON.parse(r.text); } catch (e) { return null; }
    });
  }

  /* ==================== 知乎数据 ==================== */

  function parseInitialData(html) {
    if (!html) return null;
    var m = html.match(/<script[^>]+id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/i) ||
      html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) {
      try { return JSON.parse(m[1].replace(/^\s*window\.[A-Za-z_$]+\s*=\s*/, '').replace(/;\s*$/, '')); }
      catch (e2) { return null; }
    }
  }

  function extractFromJson(json) {
    var answers = [], articles = [], people = [];
    var seen = Object.create(null);
    var budget = 60000;
    function push(arr, obj, tag) {
      var id = obj.id || obj.url_token || obj.urlToken || obj.slug || '';
      var k = tag + ':' + id + ':' + String(obj.title || obj.excerpt || obj.name || '').slice(0, 40);
      if (seen[k]) return;
      seen[k] = 1;
      arr.push(obj);
    }
    function visit(o) {
      var t = o.type;
      var hasTime = o.created_time || o.created;
      if (t === 'answer' && hasTime) push(answers, o, 'a');
      else if (t === 'article' && hasTime) push(articles, o, 'r');
      else if (t === 'people' || t === 'member') push(people, o, 'p');
      else if (hasTime && o.question) push(answers, o, 'a');
      else if (hasTime && o.title && (o.column || o.content || /^https?:\/\/zhuanlan/.test(o.url || ''))) push(articles, o, 'r');
      else if ((o.answer_count !== undefined || o.answerCount !== undefined) && (o.name || o.url_token || o.urlToken)) push(people, o, 'p');
    }
    (function walk(node) {
      if (budget-- < 0) return;
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
      visit(node);
      for (var k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]); }
    })(json);
    return { answers: answers, articles: articles, people: people };
  }

  function answerUrl(a) {
    if (!a) return null;
    if (a.url && /^https?:\/\//.test(a.url) && !/\/api\//.test(a.url)) return a.url;
    var q = a.question || {};
    var qid = q.id || q.questionId;
    if (qid && a.id) return 'https://www.zhihu.com/question/' + qid + '/answer/' + a.id;
    return null;
  }

  function normalizeProfile(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return {
      name: raw.name || '',
      headline: raw.headline || '',
      follower: num(raw.follower_count, raw.followerCount),
      answerCount: num(raw.answer_count, raw.answerCount),
      articleCount: num(raw.articles_count, raw.articlesCount, raw.articleCount),
      created: num(raw.created, raw.createdAt),
      urlToken: raw.url_token || raw.urlToken || ''
    };
  }

  function normalizeAnswer(a) {
    if (!a) return null;
    var ts = num(a.created_time, a.created);
    if (!ts) return null;
    var m = measure(a);
    return {
      kind: 'ans', id: String(a.id || ''), ts: ts,
      title: (a.question && (a.question.title || a.question.name)) || a.title || '\uff08\u65e0\u6807\u9898\uff09',
      len: m.len, approx: m.approx,
      excerpt: plainText(a.excerpt || a.content || '', 70),
      voteup: num(a.voteup_count, a.voteupCount),
      comment: num(a.comment_count, a.commentCount),
      url: answerUrl(a)
    };
  }

  function normalizeArticle(a) {
    if (!a) return null;
    var ts = num(a.created, a.created_time);
    if (!ts) return null;
    var m = measure(a);
    return {
      kind: 'art', id: String(a.id || ''), ts: ts,
      title: a.title || '\uff08\u65e0\u6807\u9898\uff09',
      len: m.len, approx: m.approx,
      excerpt: plainText(a.excerpt || a.content || '', 70),
      voteup: num(a.voteup_count, a.voteupCount),
      comment: num(a.comment_count, a.commentCount),
      url: (a.url && /^https?:\/\//.test(a.url) && !/\/api\//.test(a.url))
        ? a.url : (a.id ? 'https://zhuanlan.zhihu.com/p/' + a.id : null)
    };
  }

  /** 滑动窗口：任意长度为 winSec 的时间窗内最多有多少条 */
  function maxInWindow(sortedAscTs, winSec) {
    var best = 0, j = 0;
    for (var i = 0; i < sortedAscTs.length; i++) {
      while (sortedAscTs[i] - sortedAscTs[j] > winSec) j++;
      if (i - j + 1 > best) best = i - j + 1;
    }
    return best;
  }

  function buildStats(profile, answers, articles, opts) {
    opts = opts || {};
    var items = [];
    (answers || []).forEach(function (a) { var n = normalizeAnswer(a); if (n) items.push(n); });
    if (opts.includeArticles !== false) {
      (articles || []).forEach(function (a) { var n = normalizeArticle(a); if (n) items.push(n); });
    }
    items.sort(function (x, y) { return y.ts - x.ts; });

    var DAY = 86400;
    var now = Math.floor(Date.now() / 1000);
    var asc = items.map(function (i) { return i.ts; }).slice().sort(function (a, b) { return a - b; });

    var lens = items.map(function (i) { return i.len; }).filter(function (n) { return n > 0; });
    var avgLen = lens.length ? Math.round(lens.reduce(function (a, b) { return a + b; }, 0) / lens.length) : 0;
    var medLen = median(lens);
    var maxLen = lens.length ? Math.max.apply(null, lens) : 0;

    function inWindow(days) {
      var edge = now - days * DAY, n = 0;
      items.forEach(function (i) { if (i.ts >= edge) n++; });
      return n;
    }

    var burst = {
      m1: maxInWindow(asc, 60),
      m5: maxInWindow(asc, 300),
      h1: maxInWindow(asc, 3600),
      d1: maxInWindow(asc, 86400)
    };

    var lastTs = items.length ? items[0].ts : 0;
    var avgGapHours = null;
    if (items.length >= 2) avgGapHours = ((items[0].ts - items[items.length - 1].ts) / 3600) / (items.length - 1);

    var accountDays = profile.created ? Math.max(0, (now - profile.created) / DAY) : null;
    var totalPosts = (profile.answerCount || 0) + (profile.articleCount || 0);
    var perDay = (accountDays && accountDays > 0) ? totalPosts / accountDays : null;

    return {
      recent: items.slice(0, opts.showLimit || 5),
      totalFetched: items.length,
      d7: inWindow(7), d30: inWindow(30),
      burst: burst,
      avgLen: avgLen, medLen: medLen, maxLen: maxLen,
      avgGapHours: avgGapHours,
      avgGapText: avgGapHours === null ? '\u2014'
        : (avgGapHours < 24 ? avgGapHours.toFixed(1) + ' \u5c0f\u65f6' : (avgGapHours / 24).toFixed(1) + ' \u5929'),
      lastTs: lastTs,
      lastTime: lastTs ? fmtShort(lastTs) : '',
      accountDays: accountDays === null ? null : Math.round(accountDays),
      totalPosts: totalPosts,
      perDayText: perDay === null ? '\u2014'
        : (perDay >= 1 ? perDay.toFixed(1) + ' \u6761/\u5929' : (perDay * 30).toFixed(1) + ' \u6761/\u6708')
    };
  }

  /** 依据配置判定是否属于「短时间集中发多条」 */
  function evaluate(data) {
    var b = cfg.burst;
    var s = data.stats;
    var reasons = [];
    if (b.min1 && s.burst.m1 >= b.min1) reasons.push('1 \u5206\u949f\u5185\u8fde\u53d1 ' + s.burst.m1 + ' \u6761');
    if (b.min5 && s.burst.m5 >= b.min5) reasons.push('5 \u5206\u949f\u5185\u8fde\u53d1 ' + s.burst.m5 + ' \u6761');
    if (b.hour && s.burst.h1 >= b.hour) reasons.push('1 \u5c0f\u65f6\u5185 ' + s.burst.h1 + ' \u6761');
    if (b.day && s.burst.d1 >= b.day) reasons.push('24 \u5c0f\u65f6\u5185 ' + s.burst.d1 + ' \u6761');
    if (b.gapHours && s.avgGapHours !== null && s.avgGapHours < b.gapHours && s.totalFetched >= 5) {
      reasons.push('\u5e73\u5747 ' + s.avgGapHours.toFixed(1) + ' \u5c0f\u65f6\u4e00\u6761');
    }
    if (b.newDays && s.accountDays !== null && s.accountDays <= b.newDays && s.totalPosts >= b.newPosts) {
      reasons.push('\u65b0\u53f7\u9ad8\u4ea7\uff1a\u6ce8\u518c ' + s.accountDays + ' \u5929 / ' + s.totalPosts + ' \u6761');
    }
    if (b.shortLen && s.avgLen > 0 && s.avgLen < b.shortLen && s.d30 >= b.shortDays) {
      reasons.push('\u77ed\u53e5\u704c\u6c34\uff1a\u5747 ' + s.avgLen + ' \u5b57');
    }
    return { hit: reasons.length > 0, reasons: reasons };
  }

  /** 精确字数：为单条内容单独请求正文 */
  function exactLength(item) {
    if (!item.id || lenCache[item.id] !== undefined) return Promise.resolve();
    var url = item.kind === 'ans'
      ? API + '/answers/' + encodeURIComponent(item.id) + '?include=content'
      : API + '/articles/' + encodeURIComponent(item.id) + '?include=content';
    return jsonOf(url).then(function (r) {
      if (!r || !r.content) return;
      lenCache[item.id] = countText(stripHtml(r.content));
      saveLen();
    });
  }

  function loadMember(token) {
    var t = encodeURIComponent(token);
    var limit = Math.min(20, Math.max(5, cfg.fetchLimit));
    var pUrl = API + '/members/' + t;
    var aUrl = API + '/members/' + t + '/answers?offset=0&limit=' + limit +
      '&sort_by=created&include=' + encodeURIComponent(ANSWER_INCLUDE);
    var rUrl = API + '/members/' + t + '/articles?offset=0&limit=' + limit +
      '&sort_by=created&include=' + encodeURIComponent(ARTICLE_INCLUDE);

    return Promise.all([
      jsonOf(pUrl),
      jsonOf(aUrl),
      cfg.includeArticles ? jsonOf(rUrl) : Promise.resolve(null)
    ]).then(function (res) {
      var profile = (res[0] && !res[0].error) ? normalizeProfile(res[0]) : {};
      var answers = (res[1] && Array.isArray(res[1].data)) ? res[1].data : [];
      var articles = (res[2] && Array.isArray(res[2].data)) ? res[2].data : [];
      var source = 'api';

      var chain = Promise.resolve();
      if (!answers.length && !articles.length && !profile.name) {
        // 接口被拦（未登录 / 需要签名）→ 退回个人主页 HTML
        chain = getText('https://www.zhihu.com/people/' + t + '/answers').then(function (h) {
          if (!h || !h.text) return;
          var ex = extractFromJson(parseInitialData(h.text) || {});
          if (!ex) return;
          answers = ex.answers.slice(0, limit);
          articles = ex.articles.slice(0, limit);
          var hit = null;
          ex.people.forEach(function (p) {
            if (!hit && ((p.url_token || p.urlToken) === token || (p.id && p.name))) hit = p;
          });
          profile = normalizeProfile(hit || ex.people[0] || {});
          source = 'html';
        });
      }
      return chain.then(function () {
        var data = {
          token: token,
          profile: profile,
          stats: buildStats(profile, answers, articles, {
            showLimit: cfg.showLimit,
            includeArticles: cfg.includeArticles
          }),
          source: source,
          fetchedAt: Date.now()
        };
        if (cfg.exactLength) {
          return Promise.all(data.stats.recent.map(exactLength)).then(function () {
            data.stats.recent.forEach(function (it) {
              if (lenCache[it.id] !== undefined) { it.len = lenCache[it.id]; it.approx = false; }
            });
            var lens = data.stats.recent.map(function (i) { return i.len; });
            if (lens.length) data.stats.avgLen = Math.round(lens.reduce(function (a, b) { return a + b; }, 0) / lens.length);
            return data;
          });
        }
        return data;
      });
    }).catch(function (err) {
      return { token: token, error: '\u8bf7\u6c42\u5f02\u5e38\uff1a' + (err && err.message ? err.message : String(err)) };
    });
  }

  /* ==================== 缓存 ==================== */

  function cacheValid(e) { return e && e.data && (Date.now() - e.ts) < cfg.cacheMinutes * 60000; }

  var saveTimer = null, lenTimer = null;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { GM.setValue(CACHE_KEY, JSON.stringify(cache)); } catch (e) { }
    }, 1500);
  }
  function saveLen() {
    clearTimeout(lenTimer);
    lenTimer = setTimeout(function () {
      try { GM.setValue(LEN_KEY, JSON.stringify(lenCache)); } catch (e) { }
    }, 1500);
  }
  function persistCfg() {
    try { GM.setValue(CFG_KEY, JSON.stringify(cfg)); } catch (e) { }
  }

  function getData(token, force) {
    var e = cache[token];
    if (!force && cacheValid(e)) return Promise.resolve(Object.assign({ fromCache: true }, e.data));
    if (inflight.has(token)) return inflight.get(token);
    var p = loadMember(token).then(function (d) {
      inflight.delete(token);
      if (!d.error) { cache[token] = { ts: Date.now(), data: d }; saveCache(); }
      return d;
    });
    inflight.set(token, p);
    return p;
  }

  /* ==================== 样式 ==================== */

  var STYLE = [
    '.zvi-inline{display:block;box-sizing:border-box;width:100%;max-width:100%;clear:both;',
    'margin:3px 0 10px;padding:6px 11px;border-radius:8px;',
    'background:#f6f7f9;border:1px solid #eef0f2;',
    'color:#9aa0a6;font-size:12px;line-height:1.6;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '.zvi-inline.is-warn{background:#fff8f2;border-color:#ffe0c7;box-shadow:inset 3px 0 0 #ffb37a;}',
    '.zvi-inline.is-warn .zvi-chip{background:#ffe9de;}',
    '.zvi-line{display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;min-height:19px;}',
    '.zvi-line b{color:#555;font-weight:600;}',
    '.zvi-sep{color:#d5d8dc;}',
    '.zvi-tag{white-space:nowrap;}',
    '.zvi-chip{padding:0 5px;border-radius:3px;font-size:11px;line-height:15px;background:#fff1f0;color:#d4380d;white-space:nowrap;}',
    '.zvi-act{margin-left:auto;display:flex;align-items:center;gap:6px;}',
    '.zvi-lnk{font:inherit;font-size:11.5px;color:#8590a6;background:none;border:none;padding:0;cursor:pointer;white-space:nowrap;}',
    '.zvi-lnk:hover{color:#0084ff;}',
    '.zvi-btn{font:inherit;font-size:11px;color:#8590a6;background:#fff;border:1px solid #e6e8eb;',
    'border-radius:4px;padding:1px 7px;cursor:pointer;line-height:18px;}',
    '.zvi-btn:hover{color:#0084ff;border-color:#0084ff;}',
    '.zvi-detail{display:none;margin:6px 0 0;padding:6px 10px;background:#fff;',
    'border:1px solid #eef0f2;border-radius:7px;}',
    '.zvi-inline.is-open .zvi-detail{display:block;}',
    '.zvi-detail ul{list-style:none;margin:0;padding:0;}',
    '.zvi-detail li{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:12px;line-height:1.5;}',
    '.zvi-detail li+li{border-top:1px solid #f3f5f7;}',
    '.zvi-ttl{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'color:#2b2b2b;text-decoration:none;font-size:12.5px;}',
    '.zvi-ttl:hover{color:#0084ff;}',
    '.zvi-len{flex:0 0 auto;color:#b0b5bb;font-size:11px;}',
    '.zvi-time{flex:0 0 auto;color:#8b9096;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.zvi-meta{flex:0 0 auto;color:#b0b5bb;font-size:11px;}',
    '.zvi-note{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;color:#b6bbc1;font-size:11px;',
    'margin-top:5px;padding-top:5px;border-top:1px solid #f3f5f7;}',

    '.zvi-collapsed > *:not(.zvi-bar){display:none !important;}',
    '.zvi-bar{display:flex;align-items:center;gap:10px;padding:9px 12px;margin:0 0 8px;',
    'border:1px dashed #f0d5bd;background:#fffdfa;border-radius:8px;color:#9c6a3c;font-size:12px;}',
    '.zvi-bar b{color:#d4380d;}',
    '.zvi-marked{border-left:3px solid #ff922b;padding-left:8px;}',
    '.zvi-hidden{display:none !important;}',

    '#zvi-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:6px;',
    'padding:7px 12px;border-radius:20px;background:#fff;border:1px solid #e0e0e0;',
    'box-shadow:0 3px 12px rgba(0,0,0,.14);cursor:pointer;font-size:12px;color:#444;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;}',
    '#zvi-fab:hover{border-color:#0084ff;color:#0084ff;}',
    '#zvi-fab .zvi-n{background:#f5222d;color:#fff;border-radius:9px;padding:0 6px;font-size:11px;}',
    '#zvi-panel{position:fixed;right:18px;bottom:62px;z-index:2147483001;width:330px;max-height:70vh;overflow:auto;',
    'background:#fff;border:1px solid #e0e0e0;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.2);',
    'padding:14px;font-size:12px;color:#333;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '#zvi-panel h3{margin:0 0 10px;font-size:13px;color:#1a1a1a;}',
    '#zvi-panel .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;}',
    '#zvi-panel label{color:#666;}',
    '#zvi-panel input[type=number]{width:56px;}',
    '#zvi-panel select,#zvi-panel input{padding:2px 4px;border:1px solid #ddd;border-radius:4px;font-size:12px;}',
    '#zvi-panel .hint{color:#999;font-size:11px;line-height:1.5;margin:6px 0 0;}',
    '#zvi-panel .grp{border-top:1px solid #f0f0f0;margin-top:10px;padding-top:10px;}',
    '#zvi-panel button{padding:4px 10px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;}',
    '#zvi-panel button:hover{border-color:#0084ff;color:#0084ff;}'
  ].join('');

  /* ==================== 内联标注 ==================== */

  var ITEM_SEL = '.ContentItem, .AnswerItem, .List-item, .Post, .Profile-answerItem, article';
  // 注意：不要用 .Card 之类的泛化类名——知乎的作者小卡片也用 Card，
  // closest() 会就近命中窄的作者列，导致面板被塞进 360px 的框里
  var CONTENT_SEL = '.RichText, .RichContent, .Post-RichText, .AnswerItem-content, [class*="RichText"]';
  var SKIP_SEL = '.Comments-container, .CommentItem, .Comments, .zvi-inline, #zvi-panel, #zvi-fab';

  /** 从作者链接往上找：第一个「内部含正文块」的祖先才是这条内容所属的卡片 */
  function locate(a) {
    var el = a.parentElement, depth = 0;
    while (el && depth++ < 12) {
      var c = el.querySelector(CONTENT_SEL);
      if (c) return { item: el, content: c };
      el = el.parentElement;
    }
    var near = a.closest ? a.closest(ITEM_SEL) : null;
    if (near) return { item: near, content: near.querySelector(CONTENT_SEL) };
    return { item: null, content: null };
  }

  /**
   * 挂载：插在正文块之前（作者行下方），确保不压住昵称头像、也不受作者列宽度限制。
   * 找不到正文块时退到卡片内、操作栏之前；再退到作者行之后（强制整宽）。
   */
  function mount(a, panel) {
    var loc = locate(a);
    if (loc.content && loc.content.parentElement) {
      loc.content.insertAdjacentElement('beforebegin', panel);
      return true;
    }
    if (loc.item) {
      var acts = loc.item.querySelector('.ContentItem-actions, .AnswerItem-actions, .RichContent-actions');
      loc.item.insertBefore(panel, acts || null);
      return true;
    }
    var el = a, i = 0;
    while (el && i++ < 8) {
      var cm = el.className ? String(el.className) : '';
      if (/AuthorInfo|authorInfo/i.test(cm) && el.parentElement) {
        panel.style.flexBasis = '100%';
        el.insertAdjacentElement('afterend', panel);
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function itemContainer(el) {
    var sels = ['.ContentItem', '.AnswerItem', '.List-item', '.Post', 'article'];
    for (var i = 0; i < sels.length; i++) {
      var c = el.closest ? el.closest(sels[i]) : null;
      if (c) return c;
    }
    var p = el.parentElement;
    for (var j = 0; j < 3 && p; j++) p = p.parentElement;
    return p || el;
  }

  var blockedCount = 0;

  function applyAction(token, verdict) {
    var action = cfg.action;
    if (cfg.whitelist.indexOf(token) >= 0) action = 'mark';
    var manual = cfg.blocklist.indexOf(token) >= 0;
    var shouldAct = cfg.burst.enabled && (verdict.hit || manual);
    if (!shouldAct || action === 'mark') {
      document.querySelectorAll('[data-zvi="' + cssEsc(token) + '"]').forEach(function (b) {
        var c = itemContainer(b);
        if (c && verdict.hit) c.classList.add('zvi-marked');
      });
      return;
    }
    document.querySelectorAll('[data-zvi="' + cssEsc(token) + '"]').forEach(function (b) {
      var c = itemContainer(b);
      if (!c) return;
      if (action === 'hide') { c.classList.add('zvi-hidden'); blockedCount++; return; }
      if (c.classList.contains('zvi-collapsed')) return;
      var bar = document.createElement('div');
      bar.className = 'zvi-bar';
      bar.innerHTML = '<span>\u5df2\u6298\u53e0\uff1a<b>' + esc(verdict.reasons.join('\uff1b') || '\u624b\u52a8\u5c4f\u853d') +
        '</b></span><button class="zvi-btn" data-zvi-act="unfold">\u5c55\u5f00</button>' +
        '<button class="zvi-btn" data-zvi-act="wl">\u4e0d\u518d\u5c4f\u853d</button>';
      c.insertBefore(bar, c.firstChild);
      c.classList.add('zvi-collapsed');
      blockedCount++;
    });
    updateFab();
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function renderInline(anchor, token, data) {
    var s = data.stats, p = data.profile || {};
    var verdict = evaluate(data);
    var panel = document.createElement('div');
    panel.className = 'zvi-inline' + (verdict.hit ? ' is-warn' : '');
    panel.setAttribute('data-zvi-inline', token);

    var sep = '<span class="zvi-sep">\u00b7</span>';
    var main = [
      '\u8fd1 7 \u5929 <b>' + s.d7 + '</b> \u6761',
      '30 \u5929 <b>' + s.d30 + '</b> \u6761',
      '\u95f4\u9694 <b>' + esc(s.avgGapText) + '</b>',
      '\u5747 <b>' + s.avgLen + '</b> \u5b57'
    ].join(sep);

    var chips = verdict.reasons.map(function (r) {
      return '<span class="zvi-chip">' + esc(r) + '</span>';
    }).join('');

    // 每条一行：标题（单行省略） + 字数 + 相对时间，摘要放进 title 里悬停看
    var detail = s.recent.map(function (it) {
      var tip = (it.title || '') + '\n' +
        (it.kind === 'art' ? '\u6587\u7ae0' : '\u56de\u7b54') + ' \u00b7 ' + fmtTime(it.ts) +
        ' \u00b7 ' + (it.approx ? '\u7ea6' : '') + it.len + ' \u5b57' +
        (it.excerpt ? '\n' + it.excerpt : '');
      return '<li>' +
        '<a class="zvi-ttl" href="' + esc(it.url || '#') + '" target="_blank" rel="noopener" title="' + esc(tip) + '">' +
        esc(it.title) + '</a>' +
        '<span class="zvi-len">' + (it.approx ? '\u2248' : '') + it.len + '\u5b57</span>' +
        '<span class="zvi-time">' + esc(fmtShort(it.ts)) + '</span>' +
        '</li>';
    }).join('');

    var foot = ['\u6837\u672c ' + s.totalFetched + ' \u6761'];
    if (s.lastTime) foot.push('\u6700\u65b0 ' + s.lastTime);
    if (s.medLen) foot.push('\u4e2d\u4f4d ' + s.medLen + ' \u5b57');
    if (s.maxLen) foot.push('\u6700\u957f ' + s.maxLen);
    if (s.accountDays !== null) foot.push('\u6ce8\u518c ' + s.accountDays + ' \u5929');
    if (s.perDayText && s.perDayText !== '\u2014') foot.push('\u65e5\u5747 ' + s.perDayText);
    if (s.totalPosts > 0) foot.push('\u7d2f\u8ba1 ' + s.totalPosts + ' \u6761');

    panel.innerHTML =
      '<div class="zvi-line">' + main + chips +
      '<span class="zvi-act">' +
      '<button class="zvi-lnk" data-zvi-act="detail">\u6700\u8fd1 ' + s.recent.length + ' \u6761 \u25be</button>' +
      '</span>' +
      '</div>' +
      '<div class="zvi-detail"><ul>' +
      (detail || '<li class="zvi-meta">\u6682\u65e0\u53d1\u8a00\u8bb0\u5f55</li>') + '</ul>' +
      '<div class="zvi-note"><span>' + esc(foot.join(' \u00b7 ')) + '</span>' +
      '<span class="zvi-act"><button class="zvi-lnk" data-zvi-act="block">' +
      (cfg.blocklist.indexOf(token) >= 0 ? '\u53d6\u6d88\u5c4f\u853d\u6b64\u4eba' : '\u5c4f\u853d\u6b64\u4eba') +
      '</button></span></div>' +
      '</div>';

    if (!mount(anchor, panel)) return;
    applyAction(token, verdict);
  }

  function renderError(anchor, token, msg) {
    var panel = document.createElement('div');
    panel.className = 'zvi-inline';
    panel.innerHTML = '<span class="zvi-meta">' + esc(msg) +
      ' <a href="https://www.zhihu.com/people/' + esc(token) + '" target="_blank" rel="noopener">\u53bb\u4e3b\u9875\u770b</a></span>';
    mount(anchor, panel);
  }

  /** 正文 / 操作栏 / 评论里的 /people/ 链接不是「作者」，正文里 @ 人尤其常见 */
  function notAuthorLink(a) {
    if (a.closest && a.closest(SKIP_SEL)) return true;
    return !!(a.closest && a.closest('.RichText, .RichContent, .Post-RichText, .ContentItem-actions, .AnswerItem-actions, .RichItem-actions'));
  }

  /**
   * 一张卡片只认一个作者。
   * 知乎卡片里同一作者会同时挂头像链接和昵称链接（甚至还有正文里 @ 的、推荐关注的），
   * 逐个 anchor 标注就会在同一张卡片下生成两三条面板。
   * 取「正文块之前、DOM 顺序最后一个」——那通常就是紧贴正文的作者行。
   */
  function pickAuthor(root, list) {
    if (!list.length) return null;
    var content = root.querySelector(CONTENT_SEL);
    var before = [];
    for (var i = 0; i < list.length; i++) {
      // 2 = DOCUMENT_POSITION_PRECEDING，即该链接在正文块之前
      if (content && (content.compareDocumentPosition(list[i].a) & 2)) before.push(list[i]);
    }
    if (before.length) return before[before.length - 1];
    return list[0];
  }

  /** 兜底：同一张卡片内若已有多条面板，只保留 DOM 顺序最靠前的那条 */
  function dedupePanels() {
    var panels = [].slice.call(document.querySelectorAll('.zvi-inline'));
    if (panels.length < 2) return;
    var keep = [];
    panels.forEach(function (p) {
      var root = (p.closest && p.closest(ITEM_SEL)) || p.parentElement;
      for (var i = 0; i < keep.length; i++) {
        var q = keep[i];
        var qroot = (q.closest && q.closest(ITEM_SEL)) || q.parentElement;
        if (qroot === root || (qroot && qroot.contains(p)) || (root && root.contains(q))) {
          p.remove();
          return;
        }
      }
      keep.push(p);
    });
  }

  var scanBusy = false;
  function scan() {
    if (cfg.mode !== 'inline' || scanBusy) return;
    var anchors = document.querySelectorAll('a[href*="/people/"]');
    var groups = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (notAuthorLink(a)) continue;
      var token = tokenFromHref(a.getAttribute('href') || a.href);
      if (!token) continue;
      var root = (a.closest ? a.closest(ITEM_SEL) : null) || locate(a).item;
      if (!root) continue;
      if (root.getAttribute('data-zvi') || root.querySelector('.zvi-inline')) continue;
      var g = null;
      for (var k = 0; k < groups.length; k++) { if (groups[k].root === root) { g = groups[k]; break; } }
      if (!g) { g = { root: root, list: [] }; groups.push(g); }
      g.list.push({ a: a, token: token });
    }

    var queue = [];
    for (var j = 0; j < groups.length && queue.length < cfg.maxPerPage; j++) {
      var pick = pickAuthor(groups[j].root, groups[j].list);
      if (!pick || pending.has(pick.token)) continue;
      groups[j].root.setAttribute('data-zvi', pick.token);
      queue.push({ anchor: pick.a, item: groups[j].root, token: pick.token });
    }
    if (!queue.length) { dedupePanels(); return; }

    scanBusy = true;
    var idx = 0;
    function next() {
      if (idx >= queue.length) { scanBusy = false; dedupePanels(); return; }
      var job = queue[idx++];
      getData(job.token).then(function (d) {
        if (d.error) { renderError(job.anchor, job.token, d.error); }
        else if (!d.stats || !d.stats.totalFetched) { renderError(job.anchor, job.token, '\u672a\u83b7\u53d6\u5230\u53d1\u8a00\u8bb0\u5f55'); }
        else { renderInline(job.anchor, job.token, d); }
      }).then(function () { setTimeout(next, 220); });
    }
    var start = Math.min(4, queue.length);
    for (var k2 = 0; k2 < start; k2++) next();
  }

  /* ==================== 设置面板 ==================== */

  var fab, panel;

  function updateFab() {
    if (!fab) return;
    var n = document.querySelectorAll('.zvi-collapsed, .zvi-hidden').length;
    fab.innerHTML = '<span>\u53d1\u8a00\u753b\u50cf</span>' + (n ? '<span class="zvi-n">' + n + '</span>' : '');
  }

  function buildFab() {
    if (fab) return;
    fab = document.createElement('div');
    fab.id = 'zvi-fab';
    fab.innerHTML = '<span>\u53d1\u8a00\u753b\u50cf</span>';
    fab.addEventListener('click', function () { togglePanel(); });
    document.body.appendChild(fab);
    updateFab();
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    buildPanel();
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'zvi-panel';
    panel.innerHTML =
      '<h3>\u77e5\u4e69\u53d1\u8a00\u753b\u50cf \u00b7 \u8bbe\u7f6e</h3>' +
      '<div class="row"><label>\u5c55\u793a\u65b9\u5f0f</label><select data-k="mode">' +
      opt('inline', '\u5934\u50cf\u4e0b\u65b9\u5185\u8054', cfg.mode) +
      opt('hover', '\u60ac\u505c\u5361\u7247', cfg.mode) +
      opt('off', '\u5173\u95ed', cfg.mode) + '</select></div>' +
      '<div class="row"><label>\u5361\u7247\u5c55\u5f00\u6761\u6570</label><input type="number" min="1" max="20" data-k="showLimit" value="' + cfg.showLimit + '"></div>' +
      '<div class="row"><label>\u7edf\u8ba1\u6837\u672c\u6761\u6570</label><input type="number" min="5" max="20" data-k="fetchLimit" value="' + cfg.fetchLimit + '"></div>' +
      '<div class="row"><label>\u5b57\u6570\u53e3\u5f84</label><select data-k="countMode">' +
      opt('char', '\u5b57\u7b26\u6570\uff08\u4e2d\u6587\uff09', cfg.countMode) +
      opt('word', '\u5b57+\u82f1\u6587\u5355\u8bcd', cfg.countMode) + '</select></div>' +
      '<div class="row"><label>\u7cbe\u786e\u5b57\u6570\uff08\u66f4\u6162\uff09</label><input type="checkbox" data-k="exactLength"' + (cfg.exactLength ? ' checked' : '') + '></div>' +
      '<div class="row"><label>\u5305\u542b\u6587\u7ae0</label><input type="checkbox" data-k="includeArticles"' + (cfg.includeArticles ? ' checked' : '') + '></div>' +

      '<div class="grp"><div class="row"><label><b>\u96c6\u4e2d\u5237\u5c4f\u5224\u5b9a</b></label>' +
      '<input type="checkbox" data-k="burst.enabled"' + (cfg.burst.enabled ? ' checked' : '') + '></div>' +
      '<div class="row"><label>1 \u5206\u949f\u5185 \u2265</label><input type="number" min="0" max="20" data-k="burst.min1" value="' + cfg.burst.min1 + '"></div>' +
      '<div class="row"><label>5 \u5206\u949f\u5185 \u2265</label><input type="number" min="0" max="20" data-k="burst.min5" value="' + cfg.burst.min5 + '"></div>' +
      '<div class="row"><label>1 \u5c0f\u65f6\u5185 \u2265</label><input type="number" min="0" max="50" data-k="burst.hour" value="' + cfg.burst.hour + '"></div>' +
      '<div class="row"><label>24 \u5c0f\u65f6\u5185 \u2265</label><input type="number" min="0" max="50" data-k="burst.day" value="' + cfg.burst.day + '"></div>' +
      '<div class="row"><label>\u5e73\u5747\u95f4\u9694 &lt; (\u5c0f\u65f6)</label><input type="number" min="0" max="72" data-k="burst.gapHours" value="' + cfg.burst.gapHours + '"></div>' +
      '<div class="row"><label>\u65b0\u53f7\uff1a\u6ce8\u518c\u2264(\u5929) \u4e14 \u7d2f\u8ba1\u2265</label>' +
      '<span><input type="number" min="0" max="365" data-k="burst.newDays" value="' + cfg.burst.newDays + '">' +
      '<input type="number" min="0" max="999" data-k="burst.newPosts" value="' + cfg.burst.newPosts + '"></span></div>' +
      '<div class="row"><label>\u547d\u4e2d\u540e</label><select data-k="action">' +
      opt('mark', '\u4ec5\u6807\u8bb0', cfg.action) +
      opt('collapse', '\u6298\u53e0\u56de\u7b54', cfg.action) +
      opt('hide', '\u5b8c\u5168\u9690\u85cf', cfg.action) + '</select></div>' +
      '<p class="hint">\u9608\u503c\u586b 0 \u8868\u793a\u4e0d\u542f\u7528\u8be5\u6761\u3002\u767d\u540d\u5355\u91cc\u7684\u4eba\u6c38\u4e0d\u6298\u53e0\uff0c\u53ea\u6807\u8bb0\u3002</p></div>' +

      '<div class="grp"><div class="row"><button data-act="save">\u4fdd\u5b58\u5e76\u91cd\u65b0\u626b\u63cf</button>' +
      '<button data-act="clear">\u6e05\u7a7a\u7f13\u5b58</button></div>' +
      '<p class="hint">\u767d\u540d\u5355 ' + cfg.whitelist.length + ' \u4eba \u00b7 \u5c4f\u853d\u540d\u5355 ' + cfg.blocklist.length + ' \u4eba\u3002' +
      '\u5728\u4f5c\u8005\u65c1\u7684\u6807\u6ce8\u6761\u4e0a\u70b9\u300c\u5c4f\u853d\u300d\u5373\u53ef\u52a0\u5165\u3002</p></div>';

    document.body.appendChild(panel);
    bindPanel();
  }

  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
  }

  function readPanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-k]').forEach(function (el) {
      var k = el.getAttribute('data-k');
      var v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      if (k.indexOf('burst.') === 0) cfg.burst[k.slice(6)] = v;
      else cfg[k] = v;
    });
    persistCfg();
  }

  function rescan() {
    document.querySelectorAll('.zvi-inline, .zvi-bar').forEach(function (n) { n.remove(); });
    document.querySelectorAll('[data-zvi]').forEach(function (n) { n.removeAttribute('data-zvi'); });
    document.querySelectorAll('.zvi-collapsed').forEach(function (n) { n.classList.remove('zvi-collapsed'); });
    document.querySelectorAll('.zvi-hidden').forEach(function (n) { n.classList.remove('zvi-hidden'); });
    document.querySelectorAll('.zvi-marked').forEach(function (n) { n.classList.remove('zvi-marked'); });
    pending.clear();
    blockedCount = 0;
    scan();
    updateFab();
  }

  function bindPanel() {
    panel.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'save') { readPanel(); rescan(); panel.remove(); panel = null; }
      if (act === 'clear') {
        cache = {}; lenCache = {};
        try { GM.setValue(CACHE_KEY, '{}'); GM.setValue(LEN_KEY, '{}'); } catch (err) { }
        rescan();
      }
    });
    panel.addEventListener('change', function () { readPanel(); });
  }

  /* ==================== 事件 ==================== */

  function onClick(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-zvi-act');
    if (!act) return;
    var host = t.closest ? t.closest('[data-zvi-inline]') : null;
    var token = host ? host.getAttribute('data-zvi-inline') : null;

    if (act === 'detail') {
      if (!host) return;
      var open = host.classList.toggle('is-open');
      if (!t.getAttribute('data-label')) t.setAttribute('data-label', t.textContent);
      t.textContent = open ? '\u6536\u8d77' : t.getAttribute('data-label');
      return;
    }
    if (act === 'block' && token) {
      var i = cfg.blocklist.indexOf(token);
      if (i >= 0) cfg.blocklist.splice(i, 1); else cfg.blocklist.push(token);
      persistCfg();
      rescan();
      return;
    }
    if (act === 'wl' && token) {
      if (cfg.whitelist.indexOf(token) < 0) cfg.whitelist.push(token);
      persistCfg();
      rescan();
      return;
    }
    if (act === 'unfold') {
      var c = t.closest ? t.closest('.zvi-collapsed') : null;
      if (c) { c.classList.remove('zvi-collapsed'); var bar = c.querySelector('.zvi-bar'); if (bar) bar.remove(); }
      updateFab();
    }
  }

  /* 悬停卡片模式（mode = hover 时启用） */
  var card, cardBody, hideTimer, showTimer, anchorEl;
  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.style.cssText = 'position:fixed;z-index:2147483000;width:400px;max-width:calc(100vw - 24px);' +
      'background:#fff;border:1px solid #e6e6e6;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);' +
      'font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1a1a1a;' +
      'opacity:0;transition:opacity .12s ease;pointer-events:none;';
    card.innerHTML = '<div style="padding:16px 14px"></div>';
    cardBody = card.firstElementChild;
    document.body.appendChild(card);
    card.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    card.addEventListener('mouseleave', function () { hideTimer = setTimeout(hideCard, 260); });
    return card;
  }
  function hideCard() { clearTimeout(showTimer); if (card) card.style.opacity = '0'; }
  function showHover(el, token) {
    ensureCard();
    anchorEl = el;
    cardBody.textContent = '\u6b63\u5728\u8bfb\u53d6\u2026';
    card.style.opacity = '1';
    var r = el.getBoundingClientRect();
    card.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 412)) + 'px';
    card.style.top = (r.bottom + 8) + 'px';
    getData(token).then(function (d) {
      if (!d || d.error) { cardBody.textContent = d && d.error ? d.error : '\u672a\u83b7\u53d6\u5230\u6570\u636e'; return; }
      var s = d.stats, v = evaluate(d);
      cardBody.innerHTML = '<div style="font-weight:600;color:#14448c">' + esc(d.profile.name || token) + '</div>' +
        '<div style="margin:6px 0;color:#555">\u8fd17\u5929 <b>' + s.d7 + '</b> \u6761 \u00b7 \u8fd130\u5929 <b>' + s.d30 +
        '</b> \u6761 \u00b7 \u95f4\u9694 <b>' + esc(s.avgGapText) + '</b> \u00b7 \u5747 <b>' + s.avgLen + '</b> \u5b57</div>' +
        (v.hit ? '<div style="color:#d4380d;margin-bottom:6px">' + esc(v.reasons.join('\uff1b')) + '</div>' : '') +
        '<ul style="list-style:none;margin:0;padding:0">' + s.recent.map(function (it) {
          return '<li style="padding:4px 0;border-top:1px dashed #eee">' +
            '<a style="color:#14448c;text-decoration:none" href="' + esc(it.url || '#') + '" target="_blank" rel="noopener">' + esc(it.title) + '</a> ' +
            '<span style="color:#d4380d;font-size:11px">' + (it.approx ? '\u2248' : '') + it.len + '\u5b57</span>' +
            '<div style="color:#999;font-size:11px">' + esc(fmtShort(it.ts)) + '</div></li>';
        }).join('') + '</ul>';
      var r2 = el.getBoundingClientRect();
      card.style.top = (r2.bottom + 8) + 'px';
    });
  }

  function onMouseOver(e) {
    if (cfg.mode !== 'hover') return;
    var el = e.target && e.target.closest ? e.target.closest('a[href*="/people/"]') : null;
    if (!el) return;
    var token = tokenFromHref(el.href || el.getAttribute('href'));
    if (!token) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(function () { showHover(el, token); }, 320);
  }
  function onMouseOut(e) {
    if (cfg.mode !== 'hover') return;
    if (e.relatedTarget && card && card.contains(e.relatedTarget)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hideCard, 260);
  }

  /* ==================== 启动 ==================== */

  var scanTimer = null;
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      try { scan(); } catch (err) { console.warn('[ZVI] scan error', err); }
      updateFab();
    }, delay || 1200);
  }

  function boot() {
    var style = document.createElement('style');
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);

    try {
      GM.getValue(CFG_KEY, null).then(function (v) {
        if (v) {
          try {
            var saved = JSON.parse(v);
            Object.assign(cfg, saved);
            cfg.burst = Object.assign({}, DEFAULT_CFG.burst, saved.burst || {});
            cfg.whitelist = Array.isArray(saved.whitelist) ? saved.whitelist : [];
            cfg.blocklist = Array.isArray(saved.blocklist) ? saved.blocklist : [];
          } catch (e) { }
        }
        scheduleScan(600);
      }).catch(function () { scheduleScan(600); });
      GM.getValue(CACHE_KEY, '{}').then(function (v) { try { cache = JSON.parse(v) || {}; } catch (e) { cache = {}; } }).catch(function () { });
      GM.getValue(LEN_KEY, '{}').then(function (v) { try { lenCache = JSON.parse(v) || {}; } catch (e) { lenCache = {}; } }).catch(function () { });
    } catch (e) { scheduleScan(600); }

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', function () { if (cfg.mode === 'hover') hideCard(); }, true);

    var mo = new MutationObserver(function () {
      if (cfg.mode === 'inline') scheduleScan(1200);
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });

    buildFab();
    registerMenus();
    console.log('[ZVI] \u53d1\u8a00\u753b\u50cf v2 \u5df2\u542f\u52a8\uff1b\u53f3\u4e0b\u89d2\u6309\u94ae\u53ef\u8c03\u9608\u503c\u4e0e\u5c4f\u853d\u89c4\u5219\u3002');
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('[\u53d1\u8a00\u753b\u50cf] \u6253\u5f00\u8bbe\u7f6e\u9762\u677f', function () {
      buildFab(); if (!panel) { togglePanel(); }
    });
    GM_registerMenuCommand('[\u53d1\u8a00\u753b\u50cf] \u91cd\u65b0\u626b\u63cf\u672c\u9875', function () { rescan(); });
    GM_registerMenuCommand('[\u53d1\u8a00\u753b\u50cf] \u6e05\u7a7a\u7f13\u5b58', function () {
      cache = {}; lenCache = {};
      try { GM.setValue(CACHE_KEY, '{}'); GM.setValue(LEN_KEY, '{}'); } catch (e) { }
      rescan();
    });
    GM_registerMenuCommand('[\u53d1\u8a00\u753b\u50cf] \u81ea\u68c0\uff08\u8f93\u51fa\u5230\u63a7\u5236\u53f0\uff09', function () {
      var a = document.querySelector('a[href*="/people/"]');
      var token = a ? tokenFromHref(a.getAttribute('href') || a.href) : null;
      if (!token) { console.log('[ZVI] \u672c\u9875\u6ca1\u627e\u5230\u4f5c\u8005\u94fe\u63a5'); return; }
      console.log('[ZVI] token =', token);
      var url = API + '/members/' + encodeURIComponent(token) + '/answers?offset=0&limit=5&sort_by=created&include=' +
        encodeURIComponent(ANSWER_INCLUDE);
      jsonOf(url).then(function (r) {
        if (!r || !Array.isArray(r.data)) { console.warn('[ZVI] \u63a5\u53e3\u672a\u8fd4\u56de\u6570\u636e\uff1a', r); return; }
        console.log('[ZVI] \u6837\u672c\u6570\u91cf =', r.data.length);
        r.data.slice(0, 3).forEach(function (it) {
          var raw = it.content || '';
          console.log('[ZVI] content \u539f\u59cb\u957f\u5ea6 =', raw.length, ' \u2192 \u7eaf\u6587\u672c\u5b57\u6570 =', countText(stripHtml(raw)),
            ' | excerpt\u957f\u5ea6 =', (it.excerpt || '').length);
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
