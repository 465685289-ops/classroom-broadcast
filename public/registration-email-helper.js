(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShixingRegistrationEmail = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function suggestedDomain(email) {
    var value = String(email || '');
    var at = value.lastIndexOf('@');
    return at >= 0 ? value.slice(at + 1) : value;
  }

  function showFailure(options) {
    options = options || {};
    var data = options.data || {};
    var input = options.input;
    var message = options.message;
    if (!message) return false;
    message.textContent = data.error || '验证码发送失败';
    if (!data.suggested_email || !input) return false;

    var doc = message.ownerDocument || document;
    var actions = doc.createElement('span');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:10px';

    var accept = doc.createElement('button');
    accept.type = 'button';
    accept.textContent = '改为 ' + suggestedDomain(data.suggested_email);
    accept.style.cssText = 'border:0;border-radius:8px;padding:8px 12px;background:#8a6228;color:#fff;font:inherit;font-weight:700;cursor:pointer';
    accept.addEventListener('click', function () {
      input.value = data.suggested_email;
      var EventClass = doc.defaultView && doc.defaultView.Event;
      if (EventClass) input.dispatchEvent(new EventClass('input', { bubbles: true }));
      input.focus();
      message.textContent = '已修改为 ' + data.suggested_email + '，请确认后再次点击获取验证码。';
    });

    var edit = doc.createElement('button');
    edit.type = 'button';
    edit.textContent = '返回修改';
    edit.style.cssText = 'border:1px solid currentColor;border-radius:8px;padding:8px 12px;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer';
    edit.addEventListener('click', function () {
      input.focus();
      if (typeof input.select === 'function') input.select();
    });

    actions.appendChild(accept);
    actions.appendChild(edit);
    message.appendChild(actions);
    return true;
  }

  return { showFailure: showFailure };
});
