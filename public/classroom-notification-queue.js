(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClassroomNotificationQueue = api;
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  function routeIncomingNotification(queue, isShowing, notification) {
    if (!Array.isArray(queue)) throw new Error('通知队列不可用');
    queue.push(notification);
    return isShowing ? 'interrupt' : 'start';
  }

  return { routeIncomingNotification: routeIncomingNotification };
});
