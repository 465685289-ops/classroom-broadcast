(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClassroomNotificationQueue = api;
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  function routeIncomingNotification(queue, isShowing, notification) {
    if (!Array.isArray(queue)) throw new Error('通知队列不可用');
    queue.push(notification);
    // 审查 F07：普通通知顺序播完不打断；仅标记 urgent 的通知才显式抢占
    if (notification && notification.urgent) return 'interrupt';
    return isShowing ? 'queued' : 'start';
  }

  return { routeIncomingNotification: routeIncomingNotification };
});
