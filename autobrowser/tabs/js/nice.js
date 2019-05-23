(() => {
  // ensure we can not be trapped by alerts etc
  Object.defineProperty(window, 'onbeforeunload', {
    configurable: false,
    writeable: false,
    value: function() {},
  });
  Object.defineProperty(window, 'onunload', {
    configurable: false,
    writeable: false,
    value: function() {},
  });

  window.alert = function() {};
  window.confirm = function() {};
  window.prompt = function() {};
})();
