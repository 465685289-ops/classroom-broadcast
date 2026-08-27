(function () {
  'use strict';

  if (/\/(?:admin|dashboard|screen)\.html$/i.test(location.pathname)) return;

  var STORAGE_KEY = 'shixing_analytics_visitor';
  var endpoint = '/api/analytics/event';
  var products = ['shixing', 'broadcast', 'comment', 'essay', 'english', 'roundtable', 'edulab', 'learning'];
  var authWasVisible = false;

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  function visitorId() {
    var value = '';
    try { value = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(value)) {
      value = uuid();
      try { localStorage.setItem(STORAGE_KEY, value); } catch (e) {}
    }
    return value;
  }

  function productFromLocation() {
    var host = location.hostname.toLowerCase();
    var path = location.pathname.toLowerCase();
    if (host.indexOf('shixing.') === 0) return 'shixing';
    if (host.indexOf('comment.') === 0 || path.indexOf('/comment') === 0) return 'comment';
    if (host.indexOf('zuowen.') === 0 || path.indexOf('/zuowen') === 0 || path.indexOf('/essay') === 0) return 'essay';
    if (host.indexOf('english.') === 0 || path.indexOf('/english') === 0) return 'english';
    if (host.indexOf('roundtable.') === 0 || path.indexOf('/roundtable') === 0) return 'roundtable';
    if (host.indexOf('xiezuo.') === 0 || path.indexOf('/xiezuo') === 0 || path.indexOf('/learning') === 0) return 'learning';
    if (path.indexOf('/edulab') === 0) return 'edulab';
    return 'broadcast';
  }

  function safeChannel(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  }

  function referrerHost(value) {
    if (!value) return '';
    try { return new URL(value).hostname.toLowerCase().slice(0, 120); } catch (e) { return ''; }
  }

  function source() {
    var params = new URLSearchParams(location.search);
    var tagged = safeChannel(params.get('utm_source') || params.get('source'));
    if (tagged) return tagged;
    var host = referrerHost(document.referrer);
    return host && host !== location.hostname.toLowerCase() ? host : 'direct';
  }

  function track(eventName, details) {
    details = details || {};
    var product = products.indexOf(details.product) >= 0 ? details.product : productFromLocation();
    var body = {
      visitor_id: visitorId(),
      event_name: eventName,
      product: product,
      path: String(details.path || location.pathname || '/').split(/[?#]/)[0].slice(0, 180),
      source: safeChannel(details.source || source()),
      referrer_host: referrerHost(document.referrer)
    };
    try {
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (e) {}
  }

  function visible(element) {
    if (!element || element.hidden || element.classList.contains('hidden')) return false;
    var style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
  }

  function scanAuthPrompt() {
    var selectors = [
      '#authOverlay',
      '#authPage',
      '.auth-overlay',
      '[role="dialog"][aria-labelledby*="auth" i]'
    ];
    var isVisible = selectors.some(function (selector) {
      return Array.from(document.querySelectorAll(selector)).some(visible);
    });
    if (isVisible && !authWasVisible) track('auth_prompt');
    authWasVisible = isVisible;
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('[data-analytics-product]');
    if (!link) return;
    var product = String(link.getAttribute('data-analytics-product') || '');
    if (products.indexOf(product) >= 0) track('product_click', { product: product, source: 'shixing' });
  }, true);

  window.ShixingAnalytics = { track: track };
  track('page_view');

  if (window.MutationObserver) {
    new MutationObserver(scanAuthPrompt).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden']
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanAuthPrompt);
  else scanAuthPrompt();
}());
