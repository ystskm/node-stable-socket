/***/
// StableSocket
(function(has_win, has_mod) {

  // exports
  has_win && (window.StableSocket = StableSocket);
  has_mod && (module.exports = StableSocket);

  /**
   * 
   */
  var Timeout = {
    Request: 8000
  };

  var _rid = 0, _timers = {}, _callbacks = {};
  var _connector = {};

  /**
   * @constructor
   */
  function StableSocket(WebSocket, candidates, options) {

    if(!(this instanceof StableSocket))
      return new StableSocket(WebSocket, candidates, options)

    var ss = this;

    ss._Socket = WebSocket;
    ss._actors = candidates;

    var opts = ss.options = options;
    ss.logger = opts.logger ? opts.logger: console;
    opts.timeout = opts.timeout || Timeout.Request;

    ss._index = 0, ss._conn = null, ss._waits = [];
    ss.onopen = ss.onmessage = ss.onerror = ss.onclose = Function();

  }

  var SSProtos = {
    connect: connect,
    send: send
  };
  for( var i in SSProtos)
    StableSocket.prototype[i] = SSProtos[i];

  /**
   * @prototype
   */
  function connect(rid) {

    var ss = this, WebSocket = ss._Socket;
    var logger = ss.logger, opts = ss.options;
    var _waits = ss._waits;

    var conf = ss._actors[ss._index];
    !conf && (conf = ss._actors[ss._index = 0]);

    if(conf == null) {
      onOpeningError(new Error('Actor for connect is not found.'));
      logger.error('Check your configuration!');
      logger.error(ss._actors, ss._index);
      return;
    }

    var ConnectURI = conf.ConnectURI;
    if(_connector[ConnectURI] != null) {
      onOpeningError(new Error('Duplicated connect call.'));
      return;
    }

    var ws = new WebSocket(ConnectURI + (opts.query || ''));
    ss._conn = true; // on connecting sign

    ws.onopen = onOpen;
    ws.onmessage = onMessage;
    ws.onerror = onOpeningError;
    ws.onclose = onClose;

    function onOpen() {

      // when open socket, assign as his own socket.
      // (by readyState judge, occasionally not better.)
      ss.onopen.call(ss, _connector[ConnectURI] = ss._conn = ws);

      var msg = 'WebSocket Connection is OPEN. ';
      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length);
      _reset(rid);

      var waits = _waits;
      ss._waits = [];

      while(waits.length)
        ss.send.apply(ss, waits.shift());

    }

    function onOpeningError(e) {

      var msg = 'WebSocket Connection is ERROR. ';
      logger.log(msg + '(' + (conf && conf.ConnectURI) + ') waiting: '
        + _waits.length);
      _reset(rid);

      var waits = _waits;
      ss._waits = [];

      while(waits.length) {
        var wait = waits.shift(), cb = wait.pop();
        typeof cb == 'function' ? cb(e): logger.log('Delete request: ', wait);
      }

      ss.onerror.call(ss, e);

    }

    function onMessage(m) {
      try {

        ss.onmessage(m);

      } catch(e) {

        logger.error('Error occurs on message.');
        logger.error(e, 'recieved message: ', m);
        ss.onerror(e)

      }
    }

    function onClose() {

      var msg = 'WebSocket Connection is CLOSED. ';
      var ConnectURI = (conf || '').ConnectURI;

      logger.log(msg + '(' + ConnectURI + ')');
      delete _connector[ConnectURI];

      ss.onclose.call(ss);

    }

  }

  /**
   * @prototype
   */
  function send() {

    var ss = this, WebSocket = ss._Socket;
    var logger = ss.logger, opts = ss.options;
    var _waits = ss._waits;

    var rid = ++_rid & 0xffffff;
    var args = Array.prototype.slice.call(arguments);
    var callback;

    if(typeof args[args.length - 1] == 'function') {
      callback = _callbacks[rid] = args[args.length - 1];
      _timers[rid] = setTimeout(timeout, opts.timeout);
    }

    if(ss._conn == null) {
      _waits.push(args);
      return ss.connect(rid);
    }

    if(ss._conn === true) { // on connecting
      _waits.push(args);
      return;
    }

    switch(ss._conn.readyState) {
    case WebSocket.OPEN:
      return write();

    case WebSocket.CONNECTING:
      _waits.push(args);
      return;

    case WebSocket.CLOSING:
      _waits.push(args), ss._index++;
      return ss.connect(rid);

    case WebSocket.CLOSED:
      _waits.push(args), ss._index++;
      return ss.connect(rid);

    default:
      var mes = 'Unexpected readyState: ' + ss._conn.readyState;
      _reset(rid), logger.log(mes), callback && callback(new Error(mes));
      return;
    }

    function write() {
      var conv = typeof opts.converter == 'function' && opts.converter;
      var mess = conv ? conv.apply(ss, [rid].concat(args)): String(args[0]);
      ss._conn.send(mess);
    }

    function timeout() {

      var callback = _callbacks[rid];
      _reset(rid);

      logger.error('[StableSocket] Timeout occurs.');
      logger.error(ss._actors[ss._index]);

      ss._conn = null, ss._index++;
      ss.send.apply(ss, args);

    }
  }

  /**
   * @private
   */
  function _reset(rid) {
    clearTimeout(_timers[rid]), delete _timers[rid], delete _callbacks[rid];
  }

})(typeof window != 'undefined', typeof module != 'undefined')
