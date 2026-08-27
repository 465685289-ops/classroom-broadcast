(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClassroomPointsQueue = api;
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultRandomId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'score-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function createClassroomPointsQueue(options) {
    options = options || {};
    var storage = options.storage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new Error('积分队列需要可用的本地存储');
    }
    var storageKey = 'shixing_classroom_points_' + String(options.key || 'default');
    var now = typeof options.now === 'function' ? options.now : function() { return new Date().toISOString(); };
    var randomId = typeof options.randomId === 'function' ? options.randomId : defaultRandomId;

    function read() {
      var raw = storage.getItem(storageKey);
      if (!raw) return [];
      try {
        var parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        if (typeof storage.removeItem === 'function') storage.removeItem(storageKey);
        else storage.setItem(storageKey, '[]');
        return [];
      }
    }

    function write(items) {
      if (!items.length && typeof storage.removeItem === 'function') {
        storage.removeItem(storageKey);
        return;
      }
      storage.setItem(storageKey, JSON.stringify(items));
    }

    function enqueue(payload) {
      payload = payload || {};
      var clientOperationId = String(payload.client_operation_id || randomId());
      var items = read();
      var existing = items.find(function(item) { return item.client_operation_id === clientOperationId; });
      if (existing) return clone(existing);
      var item = clone(payload);
      item.client_operation_id = clientOperationId;
      item.client_created_at = item.client_created_at || now();
      item.status = 'pending';
      item.error = '';
      items.push(item);
      write(items);
      return clone(item);
    }

    function pending() {
      return clone(read().filter(function(item) { return item.status !== 'failed'; }));
    }

    function failed() {
      return clone(read().filter(function(item) { return item.status === 'failed'; }));
    }

    function all() {
      return clone(read());
    }

    function markSynced(clientOperationId) {
      var id = String(clientOperationId || '');
      write(read().filter(function(item) { return item.client_operation_id !== id; }));
    }

    function markFailed(clientOperationId, message) {
      var id = String(clientOperationId || '');
      var items = read().map(function(item) {
        if (item.client_operation_id !== id) return item;
        return Object.assign({}, item, { status: 'failed', error: String(message || '同步失败') });
      });
      write(items);
    }

    function clearFailure(clientOperationId) {
      var id = String(clientOperationId || '');
      var items = read().map(function(item) {
        if (item.client_operation_id !== id) return item;
        return Object.assign({}, item, { status: 'pending', error: '' });
      });
      write(items);
    }

    return {
      enqueue: enqueue,
      pending: pending,
      failed: failed,
      all: all,
      markSynced: markSynced,
      markFailed: markFailed,
      clearFailure: clearFailure
    };
  }

  return { createClassroomPointsQueue: createClassroomPointsQueue };
});
