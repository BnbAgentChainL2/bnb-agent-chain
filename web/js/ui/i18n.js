/* Local UI catalogs. Original text is retained so live DOM updates and language
   changes never rewrite application data, hashes, identifiers, or user content. */
(function (root) {
  'use strict';
  var messages = Object.create(null), rules = [];
  var textSources = new WeakMap(), attributeSources = new WeakMap();
  var attributes = ['title', 'placeholder', 'aria-label', 'alt', 'content'];
  var excluded = 'script,style,noscript,textarea,[translate="no"],[data-i18n-ignore],.sym,.f-x,.hexbox,.logrow dt,.logrow dd,.lg-n';
  var storageKey = 'bac.language';
  var observer, started = false;
  var observerOptions = { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: attributes };

  function normalize(s) { return String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
  function languageCode(s) {
    if (/^en(?:-|$)/i.test(s || '')) return 'en';
    if (/^zh(?:-|$)/i.test(s || '')) return 'zh-CN';
    return null;
  }
  function preferredLanguage() {
    var requested = languageCode(new URL(root.location.href).searchParams.get('lang'));
    if (requested) return requested;
    try {
      var saved = languageCode(root.localStorage.getItem(storageKey));
      if (saved) return saved;
    } catch (_) { /* Private mode/storage restrictions do not disable switching. */ }
    return 'en';
  }
  var language = preferredLanguage();
  document.documentElement.lang = language;

  function addMessages(entries) {
    Object.keys(entries).forEach(function (key) { messages[normalize(key)] = entries[key]; });
  }
  function addRules(entries) {
    entries.forEach(function (entry) {
      // Full-node templates avoid changing substrings in names or identifiers.
      if (entry[0] instanceof RegExp && entry[0].source[0] === '^' && /\$$/.test(entry[0].source)) rules.push(entry);
    });
  }
  function english(source, key) {
    var normalized = normalize(source);
    if (key && Object.prototype.hasOwnProperty.call(messages, key)) return messages[key];
    if (Object.prototype.hasOwnProperty.call(messages, normalized)) return messages[normalized];
    if (!/[\u3400-\u9fff]/.test(normalized)) return null;
    for (var i = 0; i < rules.length; i++) {
      rules[i][0].lastIndex = 0;
      if (rules[i][0].test(normalized)) {
        rules[i][0].lastIndex = 0;
        return normalized.replace(rules[i][0], rules[i][1]);
      }
    }
    return null;
  }
  function translated(source, key) {
    if (language !== 'en') return source;
    var result = english(source, key);
    if (result === null) return source;
    // English fragments may intentionally include a space next to inline tags.
    return (source.match(/^\s*/) || [''])[0] + result + (source.match(/\s*$/) || [''])[0];
  }
  function ignored(el) { return el && el.closest && el.closest(excluded); }
  function translateText(node) {
    if (!node.parentElement || ignored(node.parentElement)) return;
    var record = textSources.get(node);
    var source = record && node.data === record.rendered ? record.source : node.data;
    var key = node.parentElement.getAttribute('data-i18n');
    var result = translated(source, key);
    if (result !== source || record) {
      textSources.set(node, { source: source, rendered: result });
      if (node.data !== result) node.data = result;
    }
  }
  function translateAttribute(el, attr) {
    if (ignored(el) || !el.hasAttribute(attr)) return;
    if (attr === 'content' && (el.tagName !== 'META' || el.name !== 'description')) return;
    var value = el.getAttribute(attr);
    var records = attributeSources.get(el) || Object.create(null);
    var record = records[attr];
    var source = record && value === record.rendered ? record.source : value;
    var result = translated(source);
    if (result !== source || record) {
      records[attr] = { source: source, rendered: result };
      attributeSources.set(el, records);
      if (value !== result) el.setAttribute(attr, result);
    }
  }
  function translateTree(node) {
    if (node.nodeType === 3) { translateText(node); return; }
    if (node.nodeType !== 1 || ignored(node)) return;
    attributes.forEach(function (attr) { translateAttribute(node, attr); });
    for (var child = node.firstChild; child; child = child.nextSibling) translateTree(child);
  }
  function withoutObserver(fn) {
    if (observer) observer.disconnect();
    try { fn(); } finally {
      if (observer) observer.observe(document.documentElement, observerOptions);
    }
  }
  function refresh() {
    if (!started) return;
    withoutObserver(function () { translateTree(document.documentElement); });
  }
  function setLanguage(value, persist) {
    var next = languageCode(value);
    if (!next) return;
    language = next;
    document.documentElement.lang = next;
    var picker = document.getElementById('languageSelect');
    if (picker) picker.value = next;
    if (persist !== false) {
      try { root.localStorage.setItem(storageKey, next); } catch (_) {}
      var url = new URL(root.location.href);
      url.searchParams.set('lang', next === 'en' ? 'en' : 'zh');
      try { root.history.replaceState(root.history.state, '', url.href); } catch (_) {}
    }
    refresh();
    root.dispatchEvent(new CustomEvent('bac:languagechange', { detail: { language: next } }));
  }
  function untranslated() {
    var remaining = new Set();
    var walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (ignored(node.parentElement)) continue;
      var value = normalize(node.data);
      if (/[\u3400-\u9fff]/.test(value)) remaining.add(value);
    }
    return Array.from(remaining);
  }
  function start() {
    started = true;
    observer = new MutationObserver(function (records) {
      if (language !== 'en') return;
      withoutObserver(function () {
        var changed = new Set();
        records.forEach(function (record) {
          if (record.type === 'attributes') translateAttribute(record.target, record.attributeName);
          else if (record.type === 'characterData') changed.add(record.target);
          else record.addedNodes.forEach(function (node) { changed.add(node); });
        });
        changed.forEach(translateTree);
      });
    });
    var picker = document.getElementById('languageSelect');
    if (picker) {
      picker.value = language;
      picker.addEventListener('change', function () { setLanguage(picker.value); });
    }
    refresh();
  }
  root.BACI18N = { addMessages: addMessages, addRules: addRules, setLanguage: setLanguage,
    getLanguage: function () { return language; }, refresh: refresh, untranslated: untranslated,
    t: function (source) { return translated(source); } };
  addMessages({
    'nav.overview': 'Overview', 'nav.blocks': 'Blocks', 'nav.txs': 'Transactions',
    'nav.agents': 'Agents', 'nav.tokens': 'Tokens', 'nav.pairs': 'Pairs',
    'nav.epochs': 'Epochs', 'nav.treasury': 'Treasury', 'nav.validators': 'Validators',
    'metric.latestBlock': 'Latest block', 'metric.validators': 'Validators'
  });
  root.addEventListener('storage', function (event) {
    if (languageCode(new URL(root.location.href).searchParams.get('lang'))) return;
    if (event.key === storageKey && languageCode(event.newValue)) setLanguage(event.newValue, false);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}(window));
