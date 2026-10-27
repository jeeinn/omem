// review --ui 的页面模板：单文件 HTML，内联 CSS 与 JS。
//
// 为什么内联而不是放 src/web/*.html：`npm run build` 只是 tsc，不会把非 TS 文件
// 复制进 dist/，独立 .html 在发布包里会丢失。模板里所有 JS 都用 + 拼接字符串，
// 不使用反引号字面量，以便整个模板可以安全地放在 TS 模板字符串里。
//
// 页面不引入任何外部资源（字体、脚本、CDN），离线可用，也不会被 CSP 拦。
import type { ReviewItem } from './review-data.js';

export interface PageParams {
  token: string;
  items: ReviewItem[];
  timeoutMs: number;
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omem review</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3;
  --panel: #fafafa; --hover: #f0f0f0; --ok: #0f6e56; --warn: #a34a1f; --bad: #a32d2d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161616; --fg: #e8e8e8; --muted: #9a9a9a; --line: #2e2e2e;
    --panel: #1e1e1e; --hover: #262626; --ok: #5dcaa5; --warn: #ef9f27; --bad: #f09595;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column;
}
header {
  display: flex; align-items: center; gap: 16px;
  padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
}
.brand { font-weight: 500; font-size: 14px; }
.brand small { color: var(--muted); font-weight: 400; margin-left: 8px; }
.spacer { flex: 1; }
#stats { color: var(--muted); font-size: 12px; }
button {
  font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 14px; cursor: pointer;
}
button:hover:not(:disabled) { background: var(--hover); }
button:disabled { opacity: .45; cursor: default; }
#apply { border-color: var(--ok); color: var(--ok); font-weight: 500; }
main { flex: 1; display: grid; grid-template-columns: 340px 1fr; min-height: 0; }
#list { list-style: none; margin: 0; padding: 8px 0; overflow-y: auto; border-right: 1px solid var(--line); }
.row {
  display: flex; gap: 10px; padding: 9px 14px; cursor: pointer;
  border-left: 2px solid transparent;
}
.row:hover { background: var(--hover); }
.row.selected { background: var(--hover); border-left-color: var(--ok); }
.mark {
  flex: none; width: 20px; height: 20px; padding: 0; line-height: 1; border-radius: 5px;
  display: flex; align-items: center; justify-content: center; font-size: 12px;
  border: 1px solid var(--line); background: var(--bg); cursor: pointer;
}
.mark.confirm { border-color: var(--ok); color: var(--ok); }
.mark.dismiss { border-color: var(--bad); color: var(--bad); }
.mark.stale { border-color: var(--warn); color: var(--warn); }
.body { min-width: 0; flex: 1; }
.title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { color: var(--muted); }
.tag.warn { color: var(--warn); }
#detail { padding: 20px 24px; overflow-y: auto; }
#detail h2 { font-size: 14px; font-weight: 500; margin: 0 0 4px; }
.kv { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
.section { margin: 18px 0; }
.section h3 {
  font-size: 11px; font-weight: 500; color: var(--muted); text-transform: uppercase;
  letter-spacing: .06em; margin: 0 0 8px;
}
pre.bodytext {
  margin: 0; white-space: pre-wrap; word-break: break-word; font: 13px/1.75 ui-monospace, "Cascadia Code", Consolas, monospace;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;
}
.evidence, .sessions { margin: 0; padding: 0; list-style: none; }
.evidence li { border-left: 2px solid var(--line); padding: 4px 0 4px 12px; color: var(--muted); margin-bottom: 6px; }
.sessions li { padding: 4px 0; border-bottom: 1px solid var(--line); }
.sessions .meta { color: var(--muted); font-size: 11px; }
.hint { color: var(--muted); }
footer {
  display: flex; align-items: center; gap: 12px; padding: 10px 20px;
  border-top: 1px solid var(--line); background: var(--panel); font-size: 12px; color: var(--muted);
}
#confirmbar { display: none; align-items: center; gap: 10px; color: var(--fg); }
#confirmbar.on { display: flex; }
.result { margin: 0; padding: 0; list-style: none; }
.result li { padding: 6px 0; border-bottom: 1px solid var(--line); }
.result .ok { color: var(--ok); }
.result .skipped { color: var(--muted); }
.result .err { color: var(--bad); }
kbd {
  font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 4px;
  padding: 1px 5px; background: var(--bg);
}
</style>
</head>
<body>
<header>
  <div class="brand">omem review<small id="pending"></small></div>
  <div class="spacer"></div>
  <div id="stats">Select entries, then Apply.</div>
  <button id="apply" disabled>Apply</button>
</header>
<main>
  <ul id="list"></ul>
  <section id="detail"><p class="hint">Select an entry to read it. Expanding a detail is what unlocks <code>verified</code>.</p></section>
</main>
<footer>
  <span>Click the box to cycle: <b>&#10003;</b> confirm / <b>&#10005;</b> archive / <b>&#8722;</b> cool / blank skip</span>
  <span class="spacer"></span>
  <span id="confirmbar"><span id="confirmtext"></span><button id="confirmyes">Yes, apply</button><button id="confirmno">Cancel</button></span>
  <span id="kbdhint"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> mark &middot; <kbd>j</kbd><kbd>k</kbd> move &middot; <kbd>Enter</kbd> apply</span>
</footer>
<script>
(function () {
  var PAYLOAD = __PAYLOAD__;
  var TOKEN = "__TOKEN__";
  var items = PAYLOAD.items || [];
  var marks = {};
  var readIds = {};
  var selected = null;
  var submitted = false;

  var listEl = document.getElementById('list');
  var detailEl = document.getElementById('detail');
  var statsEl = document.getElementById('stats');
  var applyEl = document.getElementById('apply');
  var pendingEl = document.getElementById('pending');
  var confirmbar = document.getElementById('confirmbar');
  var confirmtext = document.getElementById('confirmtext');

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function pct(n) { return (Math.round(n * 100) / 100).toFixed(2); }

  function label(item) {
    return item.topic || item.title || item.id;
  }

  function versionText(item) {
    var n = item.versionChain.length + 1;
    return n > 1 ? 'v' + n : '';
  }

  function renderList() {
    listEl.innerHTML = '';
    items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'row' + (selected === item.id ? ' selected' : '');
      li.setAttribute('data-id', item.id);

      var mark = document.createElement('button');
      mark.className = 'mark ' + (marks[item.id] || '');
      mark.textContent = marks[item.id] === 'confirm' ? '\\u2713'
        : marks[item.id] === 'dismiss' ? '\\u2715'
        : marks[item.id] === 'stale' ? '\\u2212' : '';
      mark.addEventListener('click', function (ev) { ev.stopPropagation(); cycle(item.id); });

      var body = document.createElement('div');
      body.className = 'body';
      var t = document.createElement('div');
      t.className = 'title';
      t.textContent = label(item);
      var sub = document.createElement('div');
      sub.className = 'sub';
      var parts = [item.id, pct(item.confidence), item.source];
      var vt = versionText(item);
      if (vt) parts.push(vt);
      if (item.sessionCount) parts.push(item.sessionCount + ' session(s)');
      if (item.flags.length) parts.push(item.flags.join(','));
      sub.textContent = parts.join(' \\u00b7 ');
      if (item.flags.length) sub.className = 'sub tag warn';
      body.appendChild(t);
      body.appendChild(sub);

      li.appendChild(mark);
      li.appendChild(body);
      li.addEventListener('click', function () { select(item.id); });
      listEl.appendChild(li);
    });
  }

  function renderStats() {
    var c = 0, d = 0, s = 0;
    Object.keys(marks).forEach(function (id) {
      if (marks[id] === 'confirm') c++;
      else if (marks[id] === 'dismiss') d++;
      else if (marks[id] === 'stale') s++;
    });
    var total = c + d + s;
    var unread = 0;
    Object.keys(marks).forEach(function (id) {
      if (marks[id] === 'confirm' && !readIds[id]) unread++;
    });
    statsEl.textContent = total === 0
      ? 'Select entries, then Apply.'
      : c + ' confirm' + (unread ? ' (' + unread + ' unread \\u2192 assent)' : '') + ' \\u00b7 ' + d + ' archive \\u00b7 ' + s + ' cool';
    applyEl.textContent = total === 0 ? 'Apply' : 'Apply (' + total + ')';
    applyEl.disabled = total === 0 || submitted;
    pendingEl.textContent = items.length + ' pending';
  }

  function cycle(id) {
    if (submitted) return;
    var cur = marks[id] || '';
    var next = cur === '' ? 'confirm' : cur === 'confirm' ? 'dismiss' : cur === 'dismiss' ? 'stale' : '';
    if (next) marks[id] = next; else delete marks[id];
    renderList();
    renderStats();
  }

  var detailCache = {};
  var lastDetail = null;

  function select(id) {
    selected = id;
    renderList();
    var item = null;
    for (var i = 0; i < items.length; i++) if (items[i].id === id) item = items[i];
    if (!item) return;
    if (detailCache[id]) {
      lastDetail = detailCache[id];
      renderDetail(lastDetail);
      return;
    }
    detailEl.innerHTML = '<p class="hint">Loading\\u2026</p>';
    fetch('/api/detail/' + encodeURIComponent(id) + '?token=' + encodeURIComponent(TOKEN))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (detail) {
        detailCache[id] = detail;
        lastDetail = detail;
        readIds[id] = true;
        renderDetail(detail);
        renderStats();
      })
      .catch(function (e) {
        detailEl.innerHTML = '<p class="hint">Could not load detail: ' + esc(e.message) + '</p>';
      });
  }

  function section(title, inner) {
    return '<div class="section"><h3>' + esc(title) + '</h3>' + inner + '</div>';
  }

  function renderDetail(d) {
    var html = '';
    html += '<h2>' + esc(d.topic || d.title) + '</h2>';
    var kv = [d.id, pct(d.confidence), d.source, d.type, d.domain];
    if (d.versionChain.length) kv.push('v' + (d.versionChain.length + 1));
    if (d.verified) kv.push('verified');
    html += '<div class="kv">' + esc(kv.join(' \\u00b7 ')) + '</div>';
    html += section('Body', '<pre class="bodytext">' + esc(d.body) + '</pre>');

    if (d.evidence && d.evidence.length) {
      var ev = '<ul class="evidence">';
      d.evidence.forEach(function (e) { ev += '<li>' + esc(e) + '</li>'; });
      ev += '</ul>';
      html += section('Evidence (' + d.evidence.length + ')', ev);
    } else {
      html += section('Evidence', '<p class="hint">None. This entry is not anchored to a user message.</p>');
    }

    if (d.sessions && d.sessions.length) {
      var ss = '<ul class="sessions">';
      d.sessions.forEach(function (s) {
        ss += '<li>' + esc(s.title) + '<div class="meta">'
          + esc(s.agent) + ' \\u00b7 ' + esc(s.sessionId)
          + (s.started ? ' \\u00b7 ' + esc(s.started.slice(0, 16).replace('T', ' ')) : '')
          + (s.messages ? ' \\u00b7 ' + s.messages + ' msg' : '')
          + '</div></li>';
      });
      ss += '</ul>';
      html += section('Source sessions (' + d.sessions.length + ')', ss);
    }

    if (d.supersedes && d.supersedes.length) {
      html += section('Supersedes', '<p class="hint">' + esc(d.supersedes.join(', ')) + '</p>');
    }
    if (d.supersededBy) {
      html += section('Superseded by', '<p class="hint">' + esc(d.supersededBy) + '</p>');
    }

    var mark = marks[d.id] || '';
    var note = mark === 'confirm' && !readIds[d.id]
      ? '<p class="hint">Marked confirm but not read yet \\u2014 it will be recorded as assent (0.8).</p>'
      : '';
    detailEl.innerHTML = html + note;
  }

  function askConfirm() {
    var c = 0, d = 0, s = 0, unread = 0;
    Object.keys(marks).forEach(function (id) {
      if (marks[id] === 'confirm') { c++; if (!readIds[id]) unread++; }
      else if (marks[id] === 'dismiss') d++;
      else if (marks[id] === 'stale') s++;
    });
    var parts = [];
    if (c) parts.push(c + ' confirm' + (unread ? ' (' + unread + ' unread will be assent)' : ''));
    if (d) parts.push(d + ' archive');
    if (s) parts.push(s + ' cool');
    confirmtext.textContent = parts.join(' \\u00b7 ') + ' \\u2014 apply now?';
    confirmbar.className = 'on';
  }

  function apply() {
    if (submitted) return;
    var decisions = [];
    Object.keys(marks).forEach(function (id) { decisions.push({ id: id, action: marks[id] }); });
    if (!decisions.length) return;
    if (confirmbar.className !== 'on') { askConfirm(); return; }
    submitted = true;
    applyEl.disabled = true;
    confirmbar.className = '';
    fetch('/api/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, decisions: decisions })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body && res.body.error ? res.body.error : 'HTTP error');
        renderResult(res.body.outcomes || []);
      })
      .catch(function (e) {
        submitted = false;
        detailEl.innerHTML = '<p class="hint">Submit failed: ' + esc(e.message) + '. You can retry.</p>';
        applyEl.disabled = false;
      });
  }

  function renderResult(outcomes) {
    var html = '<h2>Applied</h2><ul class="result">';
    outcomes.forEach(function (o) {
      var cls = o.status === 'ok' ? 'ok' : o.status === 'missing' ? 'err' : 'skipped';
      var tail = o.status === 'ok'
        ? o.applied + (o.verified ? ' \\u00b7 verified' : (o.confidence != null ? ' \\u00b7 ' + pct(o.confidence) : ''))
        : (o.reason || o.status);
      html += '<li><span class="' + cls + '">' + esc(o.id) + '</span> \\u2014 ' + esc(tail) + '</li>';
    });
    html += '</ul><p class="hint">You can close this tab. The terminal has the full log.</p>';
    detailEl.innerHTML = html;
    document.getElementById('kbdhint').textContent = 'Done.';
  }

  applyEl.addEventListener('click', apply);
  document.getElementById('confirmyes').addEventListener('click', apply);
  document.getElementById('confirmno').addEventListener('click', function () {
    confirmbar.className = '';
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName)) return;
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i].id === selected) idx = i;
    if (ev.key === 'j' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (idx < items.length - 1) select(items[idx + 1].id);
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (idx > 0) select(items[idx - 1].id);
    } else if (ev.key === '1' && selected) { setMark(selected, 'confirm'); }
    else if (ev.key === '2' && selected) { setMark(selected, 'dismiss'); }
    else if (ev.key === '3' && selected) { setMark(selected, 'stale'); }
    else if (ev.key === '0' && selected) { setMark(selected, ''); }
    else if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
  });

  function setMark(id, action) {
    if (submitted) return;
    if (action) marks[id] = action; else delete marks[id];
    renderList();
    renderStats();
    if (lastDetail && lastDetail.id === id) renderDetail(lastDetail);
  }

  renderList();
  renderStats();
  if (items.length) select(items[0].id);
})();
</script>
</body>
</html>`;

export function renderReviewPage(p: PageParams): string {
  const payload = JSON.stringify({ items: p.items, timeoutMs: p.timeoutMs })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return HTML.replace('__PAYLOAD__', payload).replace('__TOKEN__', p.token);
}
