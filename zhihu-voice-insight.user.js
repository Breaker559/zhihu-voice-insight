// ==UserScript==
// @name         知乎发言画像 · 发言频率/字数标注与刷屏屏蔽
// @namespace    zhihu-voice-insight
// @version      2.8.0
// @description  在知乎答主头像/昵称下方直接插入一条发言画像：近 7/30 天条数、平均间隔、正文字数、最近发言列表；自动识别「几分钟内连发多条、一小时内刷屏、新号高产、短句灌水」，可按规则折叠或隐藏其回答；可选接 OpenAI 兼容接口做文本评估。
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
// @connect      *
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
    snipChars: 120,          // 每条发言摘录多少字（太长会 CSS 截成两行）
    includeArticles: true,   // 是否把「文章」计入发言
    cacheMinutes: 30,
    exactLength: false,      // true = 为最近几条单独请求正文取精确字数（更慢）
    countMode: 'char',       // char = 字符数（中文口径）；word = 中日韩字符 + 英文单词
    maxPerPage: 15,          // 每批最多处理多少张卡片

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
    action: 'mark',          // mark = 仅标记；collapse = 折叠；hide = 隐藏
    whitelist: [],           // 永不屏蔽
    blocklist: [],           // 手动屏蔽

    // 文本评估：可选。填了兼容 OpenAI 格式的接口才启用（留空即完全不发外部请求）
    llm: {
      enabled: false,
      baseUrl: '',           // 如 https://api.typesafe.ai/v1、https://openrouter.ai/api/v1、http://127.0.0.1:11434/v1
      apiKey: '',
      model: '',             // 如 jev-latest、qwen-plus、gpt-4o-mini
      maxItems: 6,           // 取最近几条正文参与评估
      maxChars: 600,         // 每条正文最多取多少字
      onlySuspicious: true,  // 只在命中行为规则时才分析（省调用）
      flagAt: 0.6,           // 合成分 ≥ 此值才显示红色标签
      cacheDays: 7
    }
  };

  var cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

  var CFG_KEY = 'zvi_cfg_v2';
  var CACHE_KEY = 'zvi_cache_v3'; // v3 保留高频窗口的全部证据，不能复用旧统计
  var LEN_KEY = 'zvi_len_v2';
  var AI_KEY = 'zvi_ai_v1';

  // 文本评估维度：值越大越可疑，权重之和为 1
  var AI_DIMS = [
    { k: 'templated', w: 0.22, name: '模板', desc: '模板化结构：总分总、并列要点罗列、结尾升华、整齐的小标题' },
    { k: 'no_experience', w: 0.20, name: '无经历', desc: '缺少作者亲历的具体事件，没有我当年、我朋友、上周我去这类个人经历' },
    { k: 'no_detail', w: 0.15, name: '缺细节', desc: '缺少具体时间、地点、数字、专有名词等可核验的细节' },
    { k: 'low_density', w: 0.15, name: '套话', desc: '信息密度低，大量正确但无用的车轱辘话' },
    { k: 'uniform_style', w: 0.13, name: '笔法一致', desc: '这几条之间写作风格高度一致，像出自同一套笔法而非自然波动' },
    { k: 'hedging', w: 0.10, name: '两头说', desc: '通篇平衡中立、正反两面都说到、不做明确判断' },
    { k: 'promotion', w: 0.05, name: '推广', desc: '含有推广、引流、品牌名、产品名称、引导关注或购买的内容' }
  ];

  var cache = {};      // token -> { ts, data }
  var lenCache = {};   // answerId/articleId -> 字数
  var inflight = new Map();
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

  function countText(text, mode) {
    if (!text) return 0;
    if ((mode || cfg.countMode) === 'word') {
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
      id: raw.id || '',
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
      raw: stripHtml(a.content || ''),
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
      raw: stripHtml(a.content || ''),
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

  // 除了条数，还保留造成该峰值的记录；并列时选择时间更近的一段。
  function busiestWindow(items, winSec) {
    var bestStart = 0, bestEnd = -1, start = 0;
    for (var end = 0; end < items.length; end++) {
      while (items[end].ts - items[start].ts > winSec) start++;
      if (end - start >= bestEnd - bestStart) { bestStart = start; bestEnd = end; }
    }
    var posts = items.slice(bestStart, bestEnd + 1);
    return { count: posts.length, start: posts.length ? posts[0].ts : 0,
      end: posts.length ? posts[posts.length - 1].ts : 0, items: posts };
  }

  var BURST_WINDOWS = [
    { key: 'm1', cfgKey: 'min1', seconds: 60, label: '1 分钟' },
    { key: 'm5', cfgKey: 'min5', seconds: 300, label: '5 分钟' },
    { key: 'h1', cfgKey: 'hour', seconds: 3600, label: '1 小时' },
    { key: 'd1', cfgKey: 'day', seconds: 86400, label: '24 小时' }
  ];

  function buildStats(profile, answers, articles, opts) {
    opts = opts || {};
    var items = [];
    (answers || []).forEach(function (a) { var n = normalizeAnswer(a); if (n) items.push(n); });
    if (opts.includeArticles !== false) {
      (articles || []).forEach(function (a) { var n = normalizeArticle(a); if (n) items.push(n); });
    }
    var DAY = 86400;
    var now = Math.floor(Date.now() / 1000);
    var seen = new Set();
    items = items.filter(function (it) {
      var key = it.kind + ':' + it.id;
      if (it.ts > now || (it.id && seen.has(key))) return false;
      if (it.id) seen.add(key);
      return true;
    });
    items.sort(function (x, y) { return y.ts - x.ts; });

    var lens = items.map(function (i) { return i.len; }).filter(function (n) { return n > 0; });
    var avgLen = lens.length ? Math.round(lens.reduce(function (a, b) { return a + b; }, 0) / lens.length) : 0;
    var medLen = median(lens);
    var maxLen = lens.length ? Math.max.apply(null, lens) : 0;

    function inWindow(days) {
      var edge = now - days * DAY, n = 0;
      items.forEach(function (i) { if (i.ts >= edge) n++; });
      return n;
    }

    var lastTs = items.length ? items[0].ts : 0;
    var avgGapHours = null;
    if (items.length >= 2) avgGapHours = ((items[0].ts - items[items.length - 1].ts) / 3600) / (items.length - 1);

    var accountDays = profile.created ? Math.max(0, (now - profile.created) / DAY) : null;
    var totalPosts = (profile.answerCount || 0) + (profile.articleCount || 0);
    var perDay = (accountDays && accountDays > 0) ? totalPosts / accountDays : null;

    // 供文本评估用的正文片段：每条截断保存，避免把全文塞进缓存
    var texts = [];
    if (opts.llm) {
      var pick = opts.llmItems || 6, cap = opts.llmChars || 600;
      for (var ti = 0; ti < items.length && texts.length < pick; ti++) {
        var tx = (items[ti].raw || '').replace(/\s+/g, ' ').trim();
        if (tx) texts.push(tx.slice(0, cap));
      }
    }

    // 最近发言：额外带一段截断的正文摘录，完整正文不进缓存
    var snipCap = (opts.snipChars === 0 || opts.snipChars === '0') ? 0 : (opts.snipChars || 120);
    var samples = items.map(function (it) {
      var c = Object.assign({}, it);
      var raw = (it.raw || '').replace(/\s+/g, ' ').trim();
      c.snip = snipCap > 0 ? raw.slice(0, snipCap) : '';
      delete c.raw;
      return c;
    });
    var recent = samples.slice(0, opts.showLimit || 5);
    var ascending = samples.slice().reverse(), burst = {}, windows = {};
    BURST_WINDOWS.forEach(function (rule) {
      windows[rule.key] = busiestWindow(ascending, rule.seconds);
      burst[rule.key] = windows[rule.key].count;
    });

    return {
      recent: recent,
      samples: samples,
      windows: windows,
      lengthReliable: items.length > 0 && items.every(function (it) { return !it.approx; }),
      texts: texts,
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
    var windows = [];
    BURST_WINDOWS.forEach(function (rule) {
      var w = s.windows && s.windows[rule.key];
      if (cfg.burst[rule.cfgKey] > 0 && w && w.count >= cfg.burst[rule.cfgKey]) {
        windows.push(Object.assign({ key: rule.key, label: rule.label }, w));
      }
    });
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
    if (b.shortLen && s.lengthReliable && s.avgLen > 0 && s.avgLen < b.shortLen && s.d30 >= b.shortDays) {
      reasons.push('\u77ed\u53e5\u704c\u6c34\uff1a\u5747 ' + s.avgLen + ' \u5b57');
    }
    return { hit: reasons.length > 0, reasons: reasons, windows: windows,
      frequent: windows.length > 0 || !!(b.gapHours && s.avgGapHours !== null &&
        s.avgGapHours < b.gapHours && s.totalFetched >= 5) };
  }

  /** 精确字数：为单条内容单独请求正文 */
  function exactLength(item) {
    var key = lengthKey(item), mode = cfg.countMode;
    if (!item.id || lenCache[key] !== undefined) return Promise.resolve();
    var url = item.kind === 'ans'
      ? API + '/answers/' + encodeURIComponent(item.id) + '?include=content'
      : API + '/articles/' + encodeURIComponent(item.id) + '?include=content';
    return jsonOf(url).then(function (r) {
      if (!r || !r.content) return;
      lenCache[key] = countText(stripHtml(r.content), mode);
      saveLen();
    });
  }

  function lengthKey(item) { return item.kind + ':' + item.id + ':' + cfg.countMode; }

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
      var answersOK = !!(res[1] && Array.isArray(res[1].data) && !res[1].error);
      var articlesOK = !cfg.includeArticles || !!(res[2] && Array.isArray(res[2].data) && !res[2].error);
      var source = 'api';

      var chain = Promise.resolve();
      if (!answersOK || !articlesOK) {
        // 接口被拦（未登录 / 需要签名）→ 退回个人主页 HTML
        chain = getText('https://www.zhihu.com/people/' + t + '/answers').then(function (h) {
          if (!h || !h.ok || !h.text) return;
          var ex = extractFromJson(parseInitialData(h.text) || {});
          if (!ex) return;
          var hit = ex.people.find(function (p) { return (p.url_token || p.urlToken) === token; });
          if (hit) profile = normalizeProfile(hit);
          function ownPosts(posts) {
            return posts.filter(function (post) {
              var author = post.author || {};
              return (author.url_token || author.urlToken) === token ||
                !!(profile.id && String(author.id || author) === String(profile.id));
            }).sort(function (a, b) { return num(b.created_time, b.created) - num(a.created_time, a.created); }).slice(0, limit);
          }
          if (!answersOK) answers = ownPosts(ex.answers);
          if (!articlesOK) articles = ownPosts(ex.articles);
          source = 'html';
        });
      }
      return chain.then(function () {
        if (!answers.length && !articles.length && (!answersOK || !articlesOK)) {
          return { token: token, error: '发言列表读取失败，请稍后重新扫描或打开作者主页' };
        }
        var data = {
          token: token,
          profile: profile,
          stats: buildStats(profile, answers, articles, {
            showLimit: cfg.showLimit,
            includeArticles: cfg.includeArticles,
            llm: cfg.llm.enabled,
            llmItems: cfg.llm.maxItems,
            llmChars: cfg.llm.maxChars,
            snipChars: cfg.snipChars
          }),
          source: source,
          partial: !answersOK || !articlesOK,
          fetchedAt: Date.now()
        };
        if (cfg.exactLength) {
          return Promise.all(data.stats.recent.map(exactLength)).then(function () {
            data.stats.recent.forEach(function (it) {
              var key = lengthKey(it);
              if (lenCache[key] !== undefined) { it.len = lenCache[key]; it.approx = false; }
            });
            var lens = data.stats.samples.map(function (i) { return i.len; }).filter(function (n) { return n > 0; });
            if (lens.length) {
              data.stats.avgLen = Math.round(lens.reduce(function (a, b) { return a + b; }, 0) / lens.length);
              data.stats.medLen = median(lens);
              data.stats.maxLen = Math.max.apply(null, lens);
            }
            data.stats.lengthReliable = data.stats.samples.length > 0 && data.stats.samples.every(function (it) { return !it.approx; });
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

  function dataSignature() {
    return JSON.stringify([cfg.fetchLimit, cfg.showLimit, cfg.snipChars, cfg.includeArticles,
      cfg.countMode, cfg.exactLength, cfg.llm.enabled, cfg.llm.maxItems, cfg.llm.maxChars]);
  }

  function cacheValid(e) { return e && e.data && e.signature === dataSignature() && (Date.now() - e.ts) < cfg.cacheMinutes * 60000; }

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
    var signature = dataSignature(), key = JSON.stringify([token, signature]);
    var e = cache[token];
    if (!force && cacheValid(e)) return Promise.resolve(Object.assign({ fromCache: true }, e.data));
    if (inflight.has(key)) return inflight.get(key);
    var p = loadMember(token).then(function (d) {
      if (!d.error && !d.partial && signature === dataSignature()) {
        cache[token] = { ts: Date.now(), signature: signature, data: d }; saveCache();
      }
      return d;
    }).finally(function () { inflight.delete(key); });
    inflight.set(key, p);
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
    '.zvi-ai{flex:0 0 auto;padding:0 5px;border-radius:3px;font-size:11px;line-height:15px;',
    'background:#eef1f4;color:#6b7280;white-space:nowrap;font-variant-numeric:tabular-nums;}',
    '.zvi-ai.is-hot{background:#ffe9de;color:#d4380d;}',
    '.zvi-ai.is-loading{background:#eef1f4;color:#9aa0a6;}',
    '.zvi-ai.is-err{background:#fdeaea;color:#a32d2d;}',
    '.zvi-airow{color:#b6bbc1;font-size:11px;}',
    '.zvi-airow.is-hot{color:#d4380d;}',
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
    '.zvi-detail li{display:block;padding:5px 0;}',
    '.zvi-detail li+li{border-top:1px solid #f3f5f7;}',
    '.zvi-row{display:flex;align-items:baseline;gap:8px;}',
    '.zvi-snip{margin:2px 0 0;color:#9aa0a6;font-size:11.5px;line-height:1.5;',
    'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.zvi-ttl{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'color:#2b2b2b;text-decoration:none;font-size:12.5px;}',
    '.zvi-ttl:hover{color:#0084ff;}',
    '.zvi-len{flex:0 0 auto;color:#b0b5bb;font-size:11px;}',
    '.zvi-time{flex:0 0 auto;color:#8b9096;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;}',
    '.zvi-meta{flex:0 0 auto;color:#b0b5bb;font-size:11px;}',
    '.zvi-note{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;color:#b6bbc1;font-size:11px;',
    'margin-top:5px;padding-top:5px;border-top:1px solid #f3f5f7;}',

    '[data-zvi-card].zvi-collapsed > *:not(.zvi-bar){display:none !important;}',
    '.zvi-bar{display:block;padding:9px 12px;margin:0 0 8px;',
    'border:1px dashed #f0d5bd;background:#fffdfa;border-radius:8px;color:#9c6a3c;font-size:12px;}',
    '.zvi-barline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}',
    '.zvi-bar b{color:#d4380d;}',
    '.zvi-marked{border-left:3px solid #ff922b;padding-left:8px;}',
    '[data-zvi-card].zvi-hidden{display:none !important;}',
    '.zvi-evidence{margin-top:6px;color:#555;font-size:12px;line-height:1.6;}',
    '.zvi-evidence>summary{color:#a65121;cursor:pointer;font-weight:600;}',
    '.zvi-window{margin:8px 0;padding:8px 10px;background:#fff;border:1px solid #eef0f2;border-radius:6px;}',
    '.zvi-proof-note{color:#777;font-size:11px;line-height:1.6;margin:4px 0;overflow-wrap:anywhere;}',
    '.zvi-proof-list{list-style:none!important;margin:8px 0 0!important;padding:0 0 0 10px!important;',
    'border-left:2px solid #f0d5bd;max-height:300px;overflow:auto;}',
    '.zvi-proof-list>li{padding:6px 0!important;border:0!important;overflow-wrap:anywhere;}',
    '.zvi-proof-list a{color:#14448c;text-decoration:none;}',
    '.zvi-proof-time{font:11px/1.6 Consolas,monospace;color:#777;}',
    '.zvi-author-entry{padding:9px 0;border-top:1px solid #eef0f2;}',
    '.zvi-author-entry>summary{cursor:pointer;color:#444;}',
    '.zvi-author-entry>summary span{font-size:11px;color:#777;margin-left:8px;}',
    '.zvi-author-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
    '#zvi-panel [data-zvi-authors]{max-height:45vh;overflow:auto;}',
    '#zvi-panel button:focus-visible,.zvi-btn:focus-visible,.zvi-evidence summary:focus-visible,',
    '.zvi-author-entry summary:focus-visible,#zvi-fab:focus-visible{outline:2px solid #0084ff;outline-offset:2px;}',

    '#zvi-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:6px;',
    'padding:7px 12px;border-radius:20px;background:#fff;border:1px solid #e0e0e0;',
    'box-shadow:0 3px 12px rgba(0,0,0,.14);cursor:pointer;font-size:12px;color:#444;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none;}',
    '#zvi-fab:hover{border-color:#0084ff;color:#0084ff;}',
    '#zvi-fab .zvi-n{background:#f5222d;color:#fff;border-radius:9px;padding:0 6px;font-size:11px;}',
    '#zvi-panel{position:fixed;right:12px;bottom:62px;z-index:2147483001;width:390px;max-width:calc(100vw - 24px);box-sizing:border-box;max-height:78vh;overflow:auto;',
    'background:#fff;border:1px solid #e0e0e0;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.2);',
    'padding:14px;font-size:12px;color:#333;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '#zvi-panel h3{margin:0 0 10px;font-size:13px;color:#1a1a1a;}',
    '#zvi-panel .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;}',
    '#zvi-panel label{color:#666;}',
    '#zvi-panel input[type=number]{width:56px;}',
    '#zvi-panel select,#zvi-panel input{padding:2px 4px;border:1px solid #ddd;border-radius:4px;font-size:12px;}',
    '#zvi-panel .hint{color:#999;font-size:11px;line-height:1.5;margin:6px 0 0;}',
    '#zvi-panel .hint:empty{display:none;}',
    '#zvi-panel .grp{border-top:1px solid #f0f0f0;margin-top:10px;padding-top:10px;}',
    '#zvi-panel button{padding:4px 10px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font-size:12px;}',
    '#zvi-panel button:hover{border-color:#0084ff;color:#0084ff;}'
  ].join('');

  /* ==================== 文本评估（可选，走 OpenAI 兼容接口） ==================== */

  var AI_SYSTEM = '你是文本分析助手。你会收到同一位作者的若干条发言，需要按给定维度逐项给出 0 到 1 的小数。' +
    '只输出一个 JSON 对象，不要任何解释文字，不要代码块标记。';

  var aiCache = {};
  var aiInflight = new Map();

  function aiSave() {
    try { GM.setValue(AI_KEY, JSON.stringify(aiCache)); } catch (e) { }
  }
  function aiValid(e) {
    return e && e.result && (Date.now() - e.ts) < (cfg.llm.cacheDays || 7) * 86400000;
  }

  function aiPrompt(texts) {
    var dims = AI_DIMS.map(function (d) { return '  "' + d.k + '": ' + d.desc; }).join('\n');
    return '以下是同一位作者最近的 ' + texts.length + ' 条发言，用 --- 分隔：\n\n' +
      texts.map(function (t) { return '---\n' + t; }).join('\n') + '\n\n' +
      '请按下面 ' + AI_DIMS.length + ' 个维度逐项打分，取值 0 到 1 之间的小数（如 0.85），数值越大表示该特征越明显：\n{\n' +
      dims + '\n}\n' +
      '只输出这个 JSON 对象。';
  }

  /** 模型常会夹带 ```json 或前后废话，这里把 JSON 抠出来；再不行就逐维度正则抠数字 */
  function parseAiJson(txt) {
    if (!txt) return null;
    var s = String(txt).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
    try { return JSON.parse(s); } catch (e) { /* 落到下面的正则兜底 */ }
    var out = {};
    AI_DIMS.forEach(function (d) {
      var m = new RegExp('["\']?' + d.k + '["\']?\\s*[:\\uff1a=]\\s*([0-9]*\\.?[0-9]+)').exec(txt);
      if (m) out[d.k] = Number(m[1]);
    });
    return Object.keys(out).length ? out : null;
  }

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  /** 直接的 OpenAI 兼容 /chat/completions 调用 */
  function aiRequest(texts) {
    var base = (cfg.llm.baseUrl || '').replace(/\/+$/, '');
    var body = JSON.stringify({
      model: cfg.llm.model,
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user', content: aiPrompt(texts) }
      ]
    });
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: base + '/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.llm.apiKey
        },
        data: body,
        timeout: 60000,
        onload: function (r) {
          if (r.status >= 200 && r.status < 300) {
            try {
              var j = JSON.parse(r.responseText);
              var c = j.choices && j.choices[0] && j.choices[0].message;
              resolve(c ? c.content : '');
            } catch (e) { reject(new Error('返回不是 JSON')); }
          } else {
            var msg = '';
            try { msg = ((JSON.parse(r.responseText) || {}).error || {}).message || ''; } catch (e) { }
            reject(new Error(r.status + (msg ? ' ' + msg : '')));
          }
        },
        onerror: function () { reject(new Error('网络错误')); },
        ontimeout: function () { reject(new Error('超时')); }
      });
    });
  }

  /** 只有能转成有限数字的才算有效；模型偶尔会吐 "high" 或空串，那些按缺失处理 */
  function aiValidNum(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string' && v.trim() === '') return false;
    return isFinite(Number(v));
  }

  /** 合成为 0-1 总分 + 各维度明细（缺失的维度不计入分母） */
  function aiScore(obj) {
    var total = 0, wsum = 0, missing = [];
    AI_DIMS.forEach(function (d) {
      var v = obj ? obj[d.k] : undefined;
      if (!aiValidNum(v)) { missing.push(d.k); return; }
      total += clamp01(v) * d.w;
      wsum += d.w;
    });
    return {
      score: wsum > 0 ? Math.round((total / wsum) * 100) / 100 : 0,
      dims: AI_DIMS.map(function (d) {
        var has = aiValidNum(obj && obj[d.k]);
        return { k: d.k, name: d.name, v: has ? Math.round(clamp01(obj[d.k]) * 100) / 100 : null };
      }),
      missing: missing,
      model: cfg.llm.model
    };
  }

  /** 对外入口：Promise<{score, dims, missing, model} | {error} | null> */
  function aiAnalyze(token, texts) {
    if (!cfg.llm.enabled || !cfg.llm.baseUrl || !cfg.llm.model) return Promise.resolve(null);
    if (!texts || !texts.length) return Promise.resolve(null);
    var e = aiCache[token];
    if (aiValid(e)) return Promise.resolve(Object.assign({ fromCache: true }, e.result));
    if (aiInflight.has(token)) return aiInflight.get(token);

    var p = aiRequest(texts).then(function (txt) {
      var obj = parseAiJson(txt);
      if (!obj) throw new Error('返回无法解析');
      var r = aiScore(obj);
      aiCache[token] = { ts: Date.now(), result: r };
      aiSave();
      return r;
    }).catch(function (err) {
      return { error: (err && err.message) || '失败' };
    }).then(function (r) {
      aiInflight.delete(token);
      return r;
    });
    aiInflight.set(token, p);
    return p;
  }

  /* ==================== 内联标注 ==================== */

  var ITEM_SEL = '.ContentItem, .AnswerItem, .List-item, .Post, .Profile-answerItem, article';
  // 注意：不要用 .Card 之类的泛化类名——知乎的作者小卡片也用 Card，
  // closest() 会就近命中窄的作者列，导致面板被塞进 360px 的框里
  var CONTENT_SEL = '.RichText, .RichContent, .Post-RichText, .AnswerItem-content, [class*="RichText"]';
  var SKIP_SEL = '.Comments-container, .CommentItem, .Comments, .zvi-inline, .zvi-bar, #zvi-panel, #zvi-fab, header, nav, aside';
  var PAGE_SEL = 'html, body, main, [role="main"], #root, #app, #js-client-mount, .App, .App-main, .QuestionPage, .Question-main, .Question-mainColumn, .Topstory-container, .Topstory-mainColumn, .Profile-main';
  var cardStates = new Map(); // 只处理从作者链接验证过的具体卡片，不再从标记向上猜祖先
  var shownTokens = new Set();
  var scanGeneration = 0;

  function cardContent(root) {
    if (!root || !root.isConnected || !root.matches(ITEM_SEL) || root.matches(PAGE_SEL) ||
      root.querySelector('main, [role="main"], #root, #app, #js-client-mount')) return null;
    var blocks = [].slice.call(root.querySelectorAll(CONTENT_SEL)).filter(function (c) {
      if (c.closest(SKIP_SEL)) return false;
      var parent = c.parentElement && c.parentElement.closest(CONTENT_SEL);
      return !parent || !root.contains(parent);
    });
    if (blocks.length !== 1) return null;
    var content = blocks[0];
    // 外层 article/List-item 可能是整条信息流。存在另一张独立卡片时拒绝处理。
    var nested = [].slice.call(root.querySelectorAll(ITEM_SEL));
    if (nested.some(function (c) { return !c.contains(content) && !content.contains(c) && !c.closest(SKIP_SEL); })) return null;
    return content;
  }

  /** 只认最近的明确内容卡片；识别失败时不标注、不折叠，绝不向页面祖先兜底。 */
  function locate(a) {
    var root = a && a.closest ? a.closest(ITEM_SEL) : null;
    var content = cardContent(root);
    if (a && !notAuthorLink(a) && content && (content.compareDocumentPosition(a) & 2)) {
      return { item: root, content: content };
    }
    return { item: null, content: null };
  }

  /** 只在已确认卡片的正文之前挂载；不再向作者行或页面容器兜底。 */
  function mount(a, panel) {
    var loc = locate(a);
    if (loc.item && loc.content && loc.content.parentElement) {
      loc.content.insertAdjacentElement('beforebegin', panel);
      return true;
    }
    return false;
  }

  function restoreCard(root) {
    root.classList.remove('zvi-collapsed', 'zvi-hidden', 'zvi-marked');
    [].slice.call(root.children).forEach(function (child) {
      if (child.classList.contains('zvi-bar')) child.remove();
    });
  }

  function validCard(root, state) {
    return root.isConnected && locate(state.anchor).item === root &&
      tokenFromHref(state.anchor.getAttribute('href')) === state.token;
  }

  function applyAction(token, verdict) {
    var manual = cfg.blocklist.indexOf(token) >= 0;
    var action = manual && cfg.action === 'mark' ? 'collapse' : cfg.action;
    if (cfg.whitelist.indexOf(token) >= 0 || shownTokens.has(token)) action = 'mark';
    var shouldAct = cfg.mode === 'inline' && (manual || (cfg.burst.enabled && verdict.hit));
    cardStates.forEach(function (state, c) {
      if (state.token !== token) return;
      restoreCard(c);
      if (!validCard(c, state)) return;
      if (!shouldAct || action === 'mark') {
        if (verdict.hit && cfg.mode === 'inline') c.classList.add('zvi-marked');
        return;
      }
      if (action === 'hide') { c.classList.add('zvi-hidden'); return; }
      if (action !== 'collapse') return;
      var bar = document.createElement('div');
      bar.className = 'zvi-bar';
      bar.setAttribute('data-zvi-owner', token);
      bar.innerHTML = '<div class="zvi-barline"><span>已折叠 · <b>' + esc(state.data.profile.name || token) +
        '</b>：' + esc(verdict.reasons.join('；') || '手动屏蔽') +
        '</span><button type="button" class="zvi-btn" data-zvi-act="unfold">显示此人回答</button>' +
        '<button type="button" class="zvi-btn" data-zvi-act="wl">不再屏蔽</button></div>' +
        renderBurstEvidence(state.data, verdict, token);
      c.insertBefore(bar, c.firstChild);
      c.classList.add('zvi-collapsed');
    });
    updateFab();
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function durationText(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (!seconds) return '同一秒';
    if (seconds < 60) return seconds + ' 秒';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
    return Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分';
  }

  function timeWithSeconds(ts) { return fmtTime(ts) + ':' + pad(new Date(ts * 1000).getSeconds()); }

  function renderBurstEvidence(data, verdict, token) {
    var windows = verdict.windows || [];
    if (!windows.length && !verdict.frequent) return '';
    if (!windows.length) {
      var samples = (data.stats.samples || []).slice().reverse();
      windows = [{ key: 'gap', label: '样本平均间隔 ' + data.stats.avgGapText,
        count: samples.length, items: samples, start: samples[0] && samples[0].ts,
        end: samples.length && samples[samples.length - 1].ts }];
    }
    // 多条规则命中完全相同的一组记录时，合并展示，避免重复铺满面板。
    var groups = [];
    windows.forEach(function (w) {
      var key = w.items.map(function (it) { return it.kind + ':' + it.id + ':' + it.ts; }).join('|');
      var group = groups.find(function (g) { return g.key === key; });
      if (group) { group.labels.push(w.label); return; }
      groups.push({ key: key, window: w, labels: [w.label] });
    });
    return '<details class="zvi-evidence" data-evidence-key="' + esc(token + ':proof') + '">' +
      '<summary>查看高频发言 · ' + groups.length + ' 组记录</summary>' +
      '<p class="zvi-proof-note">以下是本次采样中各规则最密集的一段，并非完整发言历史。</p>' +
      groups.map(function (group) {
        var w = group.window;
        return '<section class="zvi-window"><b>' + esc(group.labels.join(' / ')) + '：' + w.count + ' 条</b>' +
          '<div class="zvi-proof-note">' + esc(timeWithSeconds(w.start)) + ' — ' + esc(timeWithSeconds(w.end)) +
          ' · 跨度 ' + esc(durationText(w.end - w.start)) + '</div><ol class="zvi-proof-list">' +
          w.items.map(function (it, index) {
            var gap = index ? '距上一条 ' + durationText(it.ts - w.items[index - 1].ts) : '本组首条';
            return '<li><div class="zvi-proof-time">' + esc(timeWithSeconds(it.ts)) + ' · ' + esc(gap) +
              '</div><a href="' + esc(it.url || '#') + '" target="_blank" rel="noopener">' + esc(it.title) +
              '</a><span class="zvi-proof-note"> · ' + (it.kind === 'art' ? '文章' : '回答') + ' · ' +
              (it.approx ? '≈' : '') + it.len + ' 字</span>' +
              (it.snip ? '<p class="zvi-snip">' + esc(it.snip) + '</p>' : '') + '</li>';
          }).join('') + '</ol></section>';
      }).join('') + '</details>';
  }

  function pageAuthors() {
    var authors = new Map();
    cardStates.forEach(function (state, root) {
      if (!validCard(root, state)) {
        restoreCard(root);
        if (state.panel) state.panel.remove();
        root.removeAttribute('data-zvi');
        root.removeAttribute('data-zvi-card');
        cardStates.delete(root);
        return;
      }
      var entry = authors.get(state.token);
      if (!entry) {
        entry = { token: state.token, data: state.data, verdict: evaluate(state.data), count: 0, blocked: 0 };
        authors.set(state.token, entry);
      }
      entry.count++;
      if (root.classList.contains('zvi-hidden') || root.classList.contains('zvi-collapsed')) entry.blocked++;
    });
    return Array.from(authors.values());
  }

  function updateAuthors(authors) {
    if (!panel) return;
    var list = panel.querySelector('[data-zvi-authors]');
    if (!list) return;
    var entries = authors.filter(function (entry) {
      return entry.verdict.frequent || entry.blocked || cfg.blocklist.indexOf(entry.token) >= 0;
    });
    var html = entries.length ? entries.map(function (entry) {
      var token = entry.token;
      var status = entry.blocked ? '已折叠/隐藏 ' + entry.blocked + ' 条' : '本页 ' + entry.count + ' 条';
      return '<details class="zvi-author-entry" data-zvi-owner="' + esc(token) + '" data-evidence-key="' + esc(token) + '">' +
        '<summary><b>' + esc(entry.data.profile.name || token) + '</b><span>' + esc(status) + '</span></summary>' +
        '<p class="zvi-proof-note">' + esc(entry.verdict.reasons.join('；') || '手动屏蔽') + '</p>' +
        renderBurstEvidence(entry.data, entry.verdict, token) +
        '<div class="zvi-author-actions"><button type="button" data-zvi-act="unfold">显示此人回答</button>' +
        '<button type="button" data-zvi-act="wl">' + (cfg.whitelist.indexOf(token) >= 0 ? '已在白名单' : '不再屏蔽') + '</button>' +
        (cfg.blocklist.indexOf(token) >= 0 ? '<button type="button" data-zvi-act="block">取消手动屏蔽</button>' : '') +
        '</div></details>';
    }).join('') : '<p class="hint">暂未发现高频作者。浏览更多回答后会自动更新；只统计本页已读取的作者。</p>';
    if (list._zviHtml === html) return;
    var open = new Set([].slice.call(list.querySelectorAll('details[open]')).map(function (el) { return el.getAttribute('data-evidence-key'); }));
    list.innerHTML = html;
    list._zviHtml = html;
    list.querySelectorAll('details').forEach(function (el) { el.open = open.has(el.getAttribute('data-evidence-key')); });
  }

  function renderInline(anchor, token, data) {
    var s = data.stats, p = data.profile || {};
    var verdict = evaluate(data);
    var panel = document.createElement('div');
    panel.className = 'zvi-inline' + (verdict.hit ? ' is-warn' : '');
    panel.setAttribute('data-zvi-inline', token);
    panel.setAttribute('data-zvi-owner', token);

    var sep = '<span class="zvi-sep">\u00b7</span>';
    var main = [
      '样本内近 7 天 <b>' + s.d7 + '</b> 条',
      '30 \u5929 <b>' + s.d30 + '</b> \u6761',
      '\u95f4\u9694 <b>' + esc(s.avgGapText) + '</b>',
      '均 <b>' + (s.lengthReliable ? '' : '≈') + s.avgLen + '</b> 字'
    ].join(sep);

    var chips = verdict.reasons.map(function (r) {
      return '<span class="zvi-chip">' + esc(r) + '</span>';
    }).join('');

    var aiSlot = cfg.llm.enabled ? '<span class="zvi-ai" data-zvi-ai hidden></span>' : '';

    // 每条一行：标题（单行省略） + 字数 + 相对时间，摘要放进 title 里悬停看
    var detail = s.recent.map(function (it) {
      var tip = (it.title || '') + '\n' +
        (it.kind === 'art' ? '\u6587\u7ae0' : '\u56de\u7b54') + ' \u00b7 ' + fmtTime(it.ts) +
        ' \u00b7 ' + (it.approx ? '\u7ea6' : '') + it.len + ' \u5b57' +
        (it.excerpt ? '\n' + it.excerpt : '');
      return '<li>' +
        '<div class="zvi-row">' +
        '<a class="zvi-ttl" href="' + esc(it.url || '#') + '" target="_blank" rel="noopener" title="' + esc(tip) + '">' +
        esc(it.title) + '</a>' +
        '<span class="zvi-len">' + (it.approx ? '\u2248' : '') + it.len + '\u5b57</span>' +
        '<span class="zvi-time">' + esc(fmtShort(it.ts)) + '</span>' +
        '</div>' +
        (it.snip ? '<p class="zvi-snip">' + esc(it.snip) + '</p>' : '') +
        '</li>';
    }).join('');

    var foot = ['\u6837\u672c ' + s.totalFetched + ' \u6761'];
    if (data.partial) foot.push('接口受限，仅展示已核对作者的部分记录');
    if (s.lastTime) foot.push('\u6700\u65b0 ' + s.lastTime);
    if (s.medLen) foot.push('\u4e2d\u4f4d ' + s.medLen + ' \u5b57');
    if (s.maxLen) foot.push('\u6700\u957f ' + s.maxLen);
    if (s.accountDays !== null) foot.push('\u6ce8\u518c ' + s.accountDays + ' \u5929');
    if (s.perDayText && s.perDayText !== '\u2014') foot.push('\u65e5\u5747 ' + s.perDayText);
    if (s.totalPosts > 0) foot.push('\u7d2f\u8ba1 ' + s.totalPosts + ' \u6761');

    panel.innerHTML =
      '<div class="zvi-line">' + main + chips + aiSlot +
      '<span class="zvi-act">' +
      '<button class="zvi-lnk" data-zvi-act="detail">\u6700\u8fd1 ' + s.recent.length + ' \u6761 \u25be</button>' +
      '</span>' +
      '</div>' + renderBurstEvidence(data, verdict, token) +
      '<div class="zvi-detail"><ul>' +
      (detail || '<li class="zvi-meta">\u6682\u65e0\u53d1\u8a00\u8bb0\u5f55</li>') + '</ul>' +
      '<div class="zvi-note"><span>' + esc(foot.join(' \u00b7 ')) + '</span>' +
      '<span class="zvi-act"><button class="zvi-lnk" data-zvi-act="block">' +
      (cfg.blocklist.indexOf(token) >= 0 ? '\u53d6\u6d88\u5c4f\u853d\u6b64\u4eba' : '\u5c4f\u853d\u6b64\u4eba') +
      '</button></span></div>' +
      '</div>';

    if (!mount(anchor, panel)) return;
    var root = locate(anchor).item;
    root.setAttribute('data-zvi-card', '');
    cardStates.set(root, { token: token, anchor: anchor, panel: panel, data: data });
    applyAction(token, verdict);
    maybeAI(panel, token, data, verdict);
  }

  /** 文本评估：默认只在命中行为规则时才调用，结果回来后回填 */
  function maybeAI(panel, token, data, verdict) {
    if (!cfg.llm.enabled) return;
    if (cfg.llm.onlySuspicious && !verdict.hit) return;
    var texts = (data.stats && data.stats.texts) || [];
    if (!texts.length) return;
    var slot = panel.querySelector('[data-zvi-ai]');
    if (!slot) return;
    slot.hidden = false;
    slot.className = 'zvi-ai is-loading';
    slot.textContent = 'AI \u8bc4\u4f30\u4e2d';
    aiAnalyze(token, texts).then(function (r) {
      if (!r) { slot.hidden = true; return; }
      renderAI(panel, slot, r);
    });
  }

  function renderAI(panel, slot, r) {
    if (r.error) {
      slot.className = 'zvi-ai is-err';
      slot.textContent = 'AI \u5931\u8d25';
      slot.title = r.error;
      return;
    }
    var s = r.score;
    slot.className = 'zvi-ai' + (s >= cfg.llm.flagAt ? ' is-hot' : '');
    slot.textContent = 'AI ' + s.toFixed(2);
    var parts = r.dims.filter(function (d) { return d.v !== null; })
      .map(function (d) { return d.name + ' ' + d.v.toFixed(2); });
    slot.title = '\u6587\u672c\u8bc4\u4f30 ' + s.toFixed(2) + ' / 1\n' + parts.join('\n') +
      (r.missing.length ? '\n\u7f3a\u5931\u7ef4\u5ea6\uff1a' + r.missing.join('\u3001') : '') +
      '\n\u5f15\u64ce ' + (r.model || '?') + (r.fromCache ? '\uff08\u7f13\u5b58\uff09' : '');

    var foot = panel.querySelector('.zvi-note');
    if (foot) {
      var line = document.createElement('span');
      line.className = 'zvi-airow';
      if (s >= cfg.llm.flagAt) line.classList.add('is-hot');
      line.textContent = '\u6587\u672c\u8bc4\u4f30 ' + s.toFixed(2) + ' \u00b7 ' + parts.join(' \u00b7 ') +
        (r.missing.length ? ' \u00b7 \u7f3a ' + r.missing.length + ' \u9879' : '');
      foot.insertBefore(line, foot.firstChild);
    }
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

  /** 一张卡片只认一个明确作者：优先作者行；有多个无法区分的账号时跳过。 */
  function pickAuthor(root, list) {
    if (!list.length) return null;
    var content = root.querySelector(CONTENT_SEL);
    var before = [];
    for (var i = 0; i < list.length; i++) {
      // 2 = DOCUMENT_POSITION_PRECEDING，即该链接在正文块之前
      if (content && (content.compareDocumentPosition(list[i].a) & 2)) before.push(list[i]);
    }
    var authors = before.filter(function (entry) {
      return !!entry.a.closest('.AuthorInfo, .Post-Author, .ArticleItem-authorInfo, [itemprop="author"]');
    });
    if (authors.length) before = authors;
    // 没有明确作者行时，只接受唯一账号；不把“谁赞同了”或推荐关注误当作者。
    var tokens = new Set(before.map(function (entry) { return entry.token; }));
    return tokens.size === 1 ? before[before.length - 1] : null;
  }

  /** 兜底：同一张卡片内若已有多条面板，只保留 DOM 顺序最靠前的那条 */
  function dedupePanels() {
    cardStates.forEach(function (state, root) {
      root.querySelectorAll('.zvi-inline').forEach(function (p) {
        if (p !== state.panel) p.remove();
      });
    });
  }

  var scanBusy = false, scanAgain = false;
  function scan() {
    if (cfg.mode !== 'inline') return;
    if (scanBusy) { scanAgain = true; return; }
    pageAuthors(); // 清理已离开页面或被 React 复用的卡片
    var anchors = document.querySelectorAll('a[href*="/people/"]');
    var groups = new Map();
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (notAuthorLink(a)) continue;
      var token = tokenFromHref(a.getAttribute('href') || a.href);
      if (!token) continue;
      var root = locate(a).item;
      if (!root) continue;
      var g = groups.get(root);
      if (!g) { g = { root: root, list: [] }; groups.set(root, g); }
      g.list.push({ a: a, token: token });
    }

    var queue = [], more = false;
    groups.forEach(function (g) {
      var pick = pickAuthor(g.root, g.list);
      if (!pick) return;
      if (g.root.getAttribute('data-zvi') === pick.token && g.root.querySelector('.zvi-inline')) return;
      if (queue.length >= cfg.maxPerPage) { more = true; return; }
      g.root.querySelectorAll('.zvi-inline').forEach(function (n) { n.remove(); });
      g.root.setAttribute('data-zvi', pick.token);
      queue.push({ anchor: pick.a, item: g.root, token: pick.token });
    });
    if (!queue.length) { dedupePanels(); return; }

    scanBusy = true;
    scanAgain = false;
    var idx = 0, generation = scanGeneration;
    function next() {
      if (generation !== scanGeneration || cfg.mode !== 'inline' || idx >= queue.length) return Promise.resolve();
      var job = queue[idx++];
      return getData(job.token).then(function (d) {
        if (generation !== scanGeneration || cfg.mode !== 'inline' ||
          locate(job.anchor).item !== job.item || !job.item.isConnected ||
          tokenFromHref(job.anchor.getAttribute('href')) !== job.token) return;
        if (d.error) { renderError(job.anchor, job.token, d.error); }
        else if (!d.stats || !d.stats.totalFetched) { renderError(job.anchor, job.token, '\u672a\u83b7\u53d6\u5230\u53d1\u8a00\u8bb0\u5f55'); }
        else { renderInline(job.anchor, job.token, d); }
      }).catch(function (err) { console.warn('[ZVI] card error', err); })
        .then(function () {
          if (generation !== scanGeneration) return;
          return new Promise(function (resolve) { setTimeout(resolve, 220); }).then(next);
        });
    }
    var start = Math.min(4, queue.length);
    var workers = [];
    for (var k2 = 0; k2 < start; k2++) workers.push(next());
    Promise.all(workers).finally(function () {
      if (generation !== scanGeneration) return;
      scanBusy = false;
      dedupePanels();
      updateFab();
      if (more || scanAgain) scheduleScan(220);
    });
  }

  /* ==================== 设置面板 ==================== */

  var fab, panel;

  function updateFab() {
    if (!fab) return;
    var authors = pageAuthors();
    var n = authors.filter(function (entry) { return entry.verdict.frequent; }).length;
    var blocked = authors.reduce(function (sum, entry) { return sum + entry.blocked; }, 0);
    var html = '<span>发言画像</span>' + (n ? '<span class="zvi-n">高频 ' + n + ' 人</span>' : '') +
      (blocked ? '<span>已折叠/隐藏 ' + blocked + ' 条</span>' : '');
    if (fab.innerHTML !== html) fab.innerHTML = html;
    updateAuthors(authors);
  }

  function buildFab() {
    if (fab) return;
    fab = document.createElement('button');
    fab.type = 'button';
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
      '<h3>本页高频与屏蔽名单</h3><div data-zvi-authors></div>' +
      '<div class="row"><button type="button" data-zvi-act="showall">恢复本页全部回答</button></div>' +
      '<h3 class="grp">发言画像 · 设置</h3>' +
      '<div class="row"><label>\u5c55\u793a\u65b9\u5f0f</label><select data-k="mode">' +
      opt('inline', '\u5934\u50cf\u4e0b\u65b9\u5185\u8054', cfg.mode) +
      opt('hover', '\u60ac\u505c\u5361\u7247', cfg.mode) +
      opt('off', '\u5173\u95ed', cfg.mode) + '</select></div>' +
      '<div class="row"><label>\u5361\u7247\u5c55\u5f00\u6761\u6570</label><input type="number" min="1" max="20" data-k="showLimit" value="' + cfg.showLimit + '"></div>' +
      '<div class="row"><label>\u53d1\u8a00\u6458\u5f55\u5b57\u6570</label><input type="number" min="0" max="600" step="20" data-k="snipChars" value="' + cfg.snipChars + '"></div>' +
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

      '<div class="grp"><div class="row"><label><b>\u6587\u672c\u8bc4\u4f30\uff08\u53ef\u9009\uff09</b></label>' +
      '<input type="checkbox" data-k="llm.enabled"' + (cfg.llm.enabled ? ' checked' : '') + '></div>' +
      '<div class="row"><label>\u63a5\u53e3\u5730\u5740</label>' +
      '<input type="text" data-k="llm.baseUrl" style="width:152px" placeholder="https://xxx/v1" value="' + esc(cfg.llm.baseUrl) + '"></div>' +
      '<div class="row"><label>API Key</label>' +
      '<input type="password" data-k="llm.apiKey" style="width:152px" value="' + esc(cfg.llm.apiKey) + '"></div>' +
      '<div class="row"><label>\u6a21\u578b\u540d</label>' +
      '<input type="text" data-k="llm.model" style="width:152px" placeholder="jev-latest" value="' + esc(cfg.llm.model) + '"></div>' +
      '<div class="row"><label>\u53d6\u6700\u8fd1\u51e0\u6761</label>' +
      '<input type="number" min="1" max="10" data-k="llm.maxItems" value="' + cfg.llm.maxItems + '"></div>' +
      '<div class="row"><label>\u6bcf\u6761\u6700\u591a\uff08\u5b57\uff09</label>' +
      '<input type="number" min="100" max="2000" step="100" data-k="llm.maxChars" value="' + cfg.llm.maxChars + '"></div>' +
      '<div class="row"><label>\u4ec5\u547d\u4e2d\u89c4\u5219\u65f6\u5206\u6790</label>' +
      '<input type="checkbox" data-k="llm.onlySuspicious"' + (cfg.llm.onlySuspicious ? ' checked' : '') + '></div>' +
      '<div class="row"><label>\u6807\u7ea2\u9608\u503c \u2265</label>' +
      '<input type="number" min="0" max="1" step="0.05" data-k="llm.flagAt" value="' + cfg.llm.flagAt + '"></div>' +
      '<div class="row"><button data-act="aitest">\u6d4b\u8bd5\u8fde\u63a5</button></div>' +
      '<p class="hint" data-aitip></p>' +
      '<p class="hint">\u5740\u7a7a\u5373\u5b8c\u5168\u4e0d\u53d1\u5916\u90e8\u8bf7\u6c42\u3002\u586b\u516c\u5f00\u7684 OpenAI \u683c\u5f0f\u63a5\u53e3\u5373\u53ef\uff1a' +
      'TypeSafe JEV\u3001OpenRouter\u3001\u5404\u5bb6\u56fd\u4ea7\u6a21\u578b\u3001\u672c\u5730 Ollama \u90fd\u884c\u3002' +
      '\u8bc4\u4f30\u7ed3\u679c\u53ea\u4f5c\u53c2\u8003\uff0c\u4e0d\u636e\u6b64\u6298\u53e0\u6216\u9690\u85cf\u4efb\u4f55\u5185\u5bb9\u3002</p></div>' +

      '<div class="grp"><div class="row"><button data-act="save">\u4fdd\u5b58\u5e76\u91cd\u65b0\u626b\u63cf</button>' +
      '<button data-act="clear">\u6e05\u7a7a\u7f13\u5b58</button></div>' +
      '<p class="hint">\u767d\u540d\u5355 ' + cfg.whitelist.length + ' \u4eba \u00b7 \u5c4f\u853d\u540d\u5355 ' + cfg.blocklist.length + ' \u4eba\u3002' +
      '\u5728\u4f5c\u8005\u65c1\u7684\u6807\u6ce8\u6761\u4e0a\u70b9\u300c\u5c4f\u853d\u300d\u5373\u53ef\u52a0\u5165\u3002</p></div>';

    document.body.appendChild(panel);
    bindPanel();
    updateAuthors(pageAuthors());
  }

  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
  }

  function readPanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-k]').forEach(function (el) {
      var k = el.getAttribute('data-k');
      var v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      if (el.type === 'number') {
        if (!isFinite(v)) return;
        if (el.min !== '') v = Math.max(Number(el.min), v);
        if (el.max !== '') v = Math.min(Number(el.max), v);
        el.value = v;
      }
      if (k.indexOf('burst.') === 0) cfg.burst[k.slice(6)] = v;
      else if (k.indexOf('llm.') === 0) cfg.llm[k.slice(4)] = v;
      else cfg[k] = v;
    });
    persistCfg();
  }

  function rescan() {
    scanGeneration++;
    scanBusy = false;
    scanAgain = false;
    clearTimeout(scanTimer);
    scanTimer = null;
    hideCard();
    document.querySelectorAll('.zvi-inline, .zvi-bar').forEach(function (n) { n.remove(); });
    document.querySelectorAll('[data-zvi]').forEach(function (n) { n.removeAttribute('data-zvi'); });
    document.querySelectorAll('.zvi-collapsed').forEach(function (n) { n.classList.remove('zvi-collapsed'); });
    document.querySelectorAll('.zvi-hidden').forEach(function (n) { n.classList.remove('zvi-hidden'); });
    document.querySelectorAll('.zvi-marked').forEach(function (n) { n.classList.remove('zvi-marked'); });
    document.querySelectorAll('[data-zvi-card]').forEach(function (n) { n.removeAttribute('data-zvi-card'); });
    cardStates.clear();
    scan();
    updateFab();
  }

  function bindPanel() {
    panel.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'save') { readPanel(); rescan(); panel.remove(); panel = null; }
      if (act === 'aitest') { readPanel(); aiTest(); return; }
      if (act === 'clear') {
        cache = {}; lenCache = {}; aiCache = {};
        try { GM.setValue(CACHE_KEY, '{}'); GM.setValue(LEN_KEY, '{}'); GM.setValue(AI_KEY, '{}'); } catch (err) { }
        rescan();
      }
    });
    panel.addEventListener('change', function () { readPanel(); });
  }

  /** 用一段假文本打一次接口，验证地址、key、模型和返回格式能不能对上 */
  function aiTest() {
    if (!panel) return;
    var tip = panel.querySelector('[data-aitip]');
    if (!tip) return;
    if (!cfg.llm.baseUrl || !cfg.llm.model) { tip.textContent = '\u5148\u586b\u63a5\u53e3\u5730\u5740\u548c\u6a21\u578b\u540d'; return; }
    tip.textContent = '\u6d4b\u8bd5\u4e2d\u2026';
    aiRequest(['\u8fd9\u662f\u4e00\u6761\u6d4b\u8bd5\u6587\u672c\u3002\u6211\u4e0a\u4e2a\u6708\u5728\u676d\u5dde\u51fa\u5dee\u65f6\u9047\u5230\u8fc7\u7c7b\u4f3c\u60c5\u51b5\uff0c' +
      '\u5f53\u65f6\u82b1\u4e86\u4e24\u5929\u624d\u628a\u95ee\u9898\u89e3\u51b3\uff0c\u5177\u4f53\u662f\u5728\u5ba2\u6237\u73b0\u573a\u8dd1\u4e86\u4e09\u8d9f\u3002'])
      .then(function (txt) {
        var obj = parseAiJson(txt);
        if (!obj) { tip.textContent = '\u8fde\u4e0a\u4e86\uff0c\u4f46\u8fd4\u56de\u65e0\u6cd5\u89e3\u6790\uff1a' + String(txt).slice(0, 90); return; }
        var r = aiScore(obj);
        var got = r.dims.filter(function (d) { return d.v !== null; }).length;
        tip.textContent = '\u53ef\u7528\u3002\u6d4b\u8bd5\u5f97\u5206 ' + r.score.toFixed(2) +
          '\uff0c\u8bc6\u522b\u5230 ' + got + '/' + AI_DIMS.length + ' \u4e2a\u7ef4\u5ea6' +
          (r.missing.length ? '\uff08\u7f3a\uff1a' + r.missing.join('\u3001') + '\uff09' : '');
      })
      .catch(function (e) { tip.textContent = '\u5931\u8d25\uff1a' + ((e && e.message) || e); });
  }

  /* ==================== 事件 ==================== */

  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-zvi-act]') : null;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-zvi-act');
    if (!act) return;
    var host = t.closest('[data-zvi-owner]');
    var token = host ? host.getAttribute('data-zvi-owner') : null;
    e.preventDefault();
    e.stopPropagation();

    if (act === 'showall') {
      cardStates.forEach(function (state, root) { shownTokens.add(state.token); restoreCard(root); });
      updateFab();
      return;
    }

    if (act === 'detail') {
      if (!host) return;
      var open = host.classList.toggle('is-open');
      if (!t.getAttribute('data-label')) t.setAttribute('data-label', t.textContent);
      t.textContent = open ? '\u6536\u8d77' : t.getAttribute('data-label');
      return;
    }
    if (act === 'block' && token) {
      var i = cfg.blocklist.indexOf(token);
      if (i >= 0) { cfg.blocklist.splice(i, 1); shownTokens.add(token); }
      else {
        cfg.blocklist.push(token);
        shownTokens.delete(token);
        cfg.whitelist = cfg.whitelist.filter(function (v) { return v !== token; });
      }
      persistCfg();
      rescan();
      return;
    }
    if (act === 'wl' && token) {
      if (cfg.whitelist.indexOf(token) < 0) cfg.whitelist.push(token);
      cfg.blocklist = cfg.blocklist.filter(function (v) { return v !== token; });
      shownTokens.add(token);
      persistCfg();
      cardStates.forEach(function (state, root) { if (state.token === token) restoreCard(root); });
      updateFab();
      return;
    }
    if (act === 'unfold' && token) {
      shownTokens.add(token);
      cardStates.forEach(function (state, root) { if (state.token === token) restoreCard(root); });
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
  function hideCard() {
    clearTimeout(showTimer);
    anchorEl = null;
    if (card) { card.style.opacity = '0'; card.style.pointerEvents = 'none'; }
  }
  function showHover(el, token) {
    ensureCard();
    anchorEl = el;
    cardBody.textContent = '\u6b63\u5728\u8bfb\u53d6\u2026';
    card.style.opacity = '1';
    card.style.pointerEvents = 'auto';
    var r = el.getBoundingClientRect();
    card.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 412)) + 'px';
    card.style.top = (r.bottom + 8) + 'px';
    getData(token).then(function (d) {
      if (anchorEl !== el || cfg.mode !== 'hover' || !el.isConnected) return;
      if (!d || d.error) { cardBody.textContent = d && d.error ? d.error : '\u672a\u83b7\u53d6\u5230\u6570\u636e'; return; }
      var s = d.stats, v = evaluate(d);
      cardBody.innerHTML = '<div style="font-weight:600;color:#14448c">' + esc(d.profile.name || token) + '</div>' +
        '<div style="margin:6px 0;color:#555">样本内近7天 <b>' + s.d7 + '</b> 条 · 近30天 <b>' + s.d30 +
        '</b> \u6761 \u00b7 \u95f4\u9694 <b>' + esc(s.avgGapText) + '</b> \u00b7 \u5747 <b>' + s.avgLen + '</b> \u5b57</div>' +
        (v.hit ? '<div style="color:#d4380d;margin-bottom:6px">' + esc(v.reasons.join('\uff1b')) + '</div>' : '') +
        '<ul style="list-style:none;margin:0;padding:0">' + s.recent.map(function (it) {
          return '<li style="padding:4px 0;border-top:1px dashed #eee">' +
            '<a style="color:#14448c;text-decoration:none" href="' + esc(it.url || '#') + '" target="_blank" rel="noopener">' + esc(it.title) + '</a> ' +
            '<span style="color:#d4380d;font-size:11px">' + (it.approx ? '\u2248' : '') + it.len + '\u5b57</span>' +
            '<div style="color:#999;font-size:11px">' + esc(fmtShort(it.ts)) + '</div></li>';
        }).join('') + '</ul>' + renderBurstEvidence(d, v, token);
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
    if (scanTimer !== null || cfg.mode !== 'inline') return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
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
            cfg.llm = Object.assign({}, DEFAULT_CFG.llm, saved.llm || {});
            cfg.whitelist = Array.isArray(saved.whitelist) ? saved.whitelist : [];
            cfg.blocklist = Array.isArray(saved.blocklist) ? saved.blocklist : [];
          } catch (e) { }
        }
        scheduleScan(600);
      }).catch(function () { scheduleScan(600); });
      GM.getValue(CACHE_KEY, '{}').then(function (v) { try { cache = JSON.parse(v) || {}; } catch (e) { cache = {}; } }).catch(function () { });
      GM.getValue(LEN_KEY, '{}').then(function (v) { try { lenCache = JSON.parse(v) || {}; } catch (e) { lenCache = {}; } }).catch(function () { });
      GM.getValue(AI_KEY, '{}').then(function (v) { try { aiCache = JSON.parse(v) || {}; } catch (e) { aiCache = {}; } }).catch(function () { });
    } catch (e) { scheduleScan(600); }

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', function () { if (cfg.mode === 'hover') hideCard(); }, true);

    var ownedSelector = '.zvi-inline, .zvi-bar, #zvi-panel, #zvi-fab';
    function owned(node) {
      var el = node.nodeType === 1 ? node : node.parentElement;
      return !!(el && el.closest && el.closest(ownedSelector));
    }
    var mo = new MutationObserver(function (records) {
      if (cfg.mode !== 'inline') return;
      var changed = records.some(function (record) {
        if (owned(record.target)) return false;
        if (record.type === 'attributes') return true;
        var nodes = [].slice.call(record.addedNodes).concat([].slice.call(record.removedNodes));
        return nodes.some(function (node) { return !owned(node); });
      });
      if (changed) scheduleScan(500);
    });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });

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
      cache = {}; lenCache = {}; aiCache = {};
      try { GM.setValue(CACHE_KEY, '{}'); GM.setValue(LEN_KEY, '{}'); GM.setValue(AI_KEY, '{}'); } catch (e) { }
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
