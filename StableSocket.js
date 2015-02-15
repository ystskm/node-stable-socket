/***/
// StableSocket
(function(has_win, has_mod) {

  // exports
  has_win && (window.StableSocket = StableSocket);
  has_mod && (module.exports = StableSocket);

  /**
   * 
   */
  var Default = {
    OpenRetryTime: 5,
    OpenRetryInterval: 1000,
    SilentTerm: 60 * 60 * 1000
  };

  var Timeout = {
    Request: 8000
  };

  var Converter = function(rid, obj) {
    return [{
      rid: rid
    }, obj];
  };

  var Analyzer = function(msg) {
    return JSON.parse(msg);
  };

  var _rid = 0, _timers = {}, _callbacks = {};
  var _connector = {};

  /**
   * @constructor
   */
  function StableSocket(Socket, candidates, options) {

    if(!(this instanceof StableSocket))
      return new StableSocket(Socket, candidates, options);

    var ss = this;

    ss._Socket = Socket;
    ss._actors = candidates;

    var opts = ss.options = options || {};
    ss.logger = opts.logger ? opts.logger: console;
    opts.timeout = opts.timeout || Timeout.Request;

    ss._index = 0, ss._conn = null, ss._waits = [];
    ss.onopen = ss.onmessage = ss.onerror = ss.onclose = Function();

  }

  var SSProtos = {
    connect: connect,
    status: status,
    send: send
  };
  for( var i in SSProtos)
    StableSocket.prototype[i] = SSProtos[i];

  /**
   * @prototype
   */
  function connect(rid) {

    var ss = this, Socket = ss._Socket;
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

    var so = new Socket(ConnectURI + (opts.query || ''), {
      rejectUnauthorized: false
    });

    ss._host = ConnectURI.split('/').slice(0, 3).join('/');
    ss._conn = true; // on connecting sign

    // retry status when OpenError occurs.
    var opts_retry = opts.retry || '';
    ss._open_retry0 = opts_retry.time || Default.OpenRetryTime;
    ss._open_retryi = opts_retry.interval || Default.OpenRetryInterval;

    ss._open_retry = ss._open_retry0;
    ss._open_error = null;

    ss._slient_term = opts_retry.silent || Default.SilentTerm;
    ss._slient_timer = null;

    so.onopen = onOpen;
    so.onmessage = onMessage;

    so.onerror = function(e) {
      onOpeningError(e), so.close();
    };
    so.onclose = function(e) {
      !ss._open_error && onClose(e);
    };

    function onOpen() {

      // off opening error.
      onOpeningError = Function();

      // when open socket, assign as his own socket.
      // (by readyState judge, occasionally not better.)
      ss.onopen.call(ss, _connector[ConnectURI] = ss._conn = so);

      var msg = 'StableSocket Connection is OPEN. ';
      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length);
      _reset(rid);

      var waits = _waits;
      ss._waits = [];

      while(waits.length)
        ss.send.apply(ss, waits.shift());

      // refresh open error status
      ss._open_error = null;
      ss._open_retry = ss._open_retry0;

    }

    function onOpeningError(e) {

      var msg = 'StableSocket Connection is ERRORED. ';
      logger.log(msg + '(' + (conf && conf.ConnectURI) + ') waiting: '
        + _waits.length);

      // if reconnecting, wait more error
      // until sleeping mode
      if(--ss._open_retry > 0) {
        setTimeout(function() {
          ss.connect(rid)
        }, ss._open_retryi);
        return;
      }

      _reset(rid)

      ss._open_error = {
        error: e,
        stamp: new Date()
      };

      var waits = _waits;
      ss._waits = [];

      while(waits.length) {
        var wait = waits.shift(), cb = wait.pop();
        typeof cb == 'function' ? cb(e): logger.log('Delete request: ', wait);
      }

      if(!ss._silent_term)
        ss.onerror.call(ss, e);

      var term = ss._silent_term;
      if(typeof term == 'function')
        term = term();

      if(typeof term != 'number')
        return;

      ss._silent_timer = setTimeout(function() {

        // sign of mode change
        delete ss._silent_timer;

        // parameter initialize
        ss._open_error = null;
        ss._open_retry = ss._open_retry0;

      }, term);

    }

    function onMessage(m) {
      try {

        // data analyzed by analyzer.
        var data = (opts.analyzer || Analyzer)(m) || '';

        // and callback if exist.
        var h = data[0] || '', b = data[1] || '', rid = h.rid;
        (_callbacks[rid] || Function())(b), _reset(rid);

        // get raw message.
        ss.onmessage(m);

      } catch(e) {

        // get raw message. (unparsable)
        ss.onmessage(m, false);

      }
    }

    function onClose() {

      var msg = 'StableSocket Connection is CLOSED. ';
      var ConnectURI = (conf || '').ConnectURI;

      logger.log(msg + '(' + ConnectURI + ')');
      delete _connector[ConnectURI];

      ss.onclose.call(ss);

    }

  }

  function status() {
    var ss = this;
    return (ss._conn || '').readyState;
  }

  /**
   * @prototype
   */
  function send() {

    var ss = this, Socket = ss._Socket;
    var logger = ss.logger, opts = ss.options;
    var _waits = ss._waits;

    var args = Array.prototype.slice.call(arguments);
    var callback;

    // at the silent mode, "send" method immediately end.
    if(ss._silent_timer) {
      callback = args[args.length - 1];
      typeof callback == 'function' && callback();
      return;
    }

    var rid = ++_rid & 0xffffff;
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
    case Socket.OPEN:
      return write();

    case Socket.CONNECTING:
      _waits.push(args);
      return;

    case Socket.CLOSING:
      _waits.push(args), ss._index++;
      return ss.connect(rid);

    case Socket.CLOSED:
      _waits.push(args), ss._index++;
      return ss.connect(rid);

    default:
      var mes = 'Unexpected readyState: ' + ss._conn.readyState;
      _reset(rid), logger.log(mes), callback && callback(new Error(mes));
      return;
    }

    function write() {

      var conv = (opts.converter || Converter);
      var rurl, mess;

      if(typeof args[0] == 'string') {
        mess = args[0];
      } else {
        mess = conv.apply(ss, [rid].concat(args));
      }

      if(ss._conn.send) {
        // type: WebSocket
        ss._conn.send(typeof mess == 'string' ? mess: JSON.stringify(mess));
      } else {
        // type: EventSource
        (typeof process == 'undefined' ? xmlPost: nodePost)(mess);
      }

    }

    function nodePost(mess) {

      var host = ss._host, body = mess[1];
      var prtc = host.indexOf('https') === 0 ? 'https': 'http';

      var headers = body.headers || {};
      headers['Content-Type'] = 'application/json';

      var options = {
        hostname: host.replace(prtc + '://', ''),
        path: body.url,
        method: 'POST',
        headers: headers,
        rejectUnauthorized: false
      };

      //      console.log('MESSAGE!', mess, options);

      delete body.url, delete body.headers;
      var r = require(prtc).request(options, function(res) {
        //        console.log('nodePost returns.', res.statusCode);
        // TODO
        // res.statusCode == 200 ? dfd.resolve(): dfd.reject();
      });

      r.on('error', ss.onerror.bind(ss));
      r.write(JSON.stringify(mess));
      r.end();

    }

    function xmlPost(mess) {

      var k, xhr = new XMLHttpRequest(), body = mess[1];
      xhr.open('POST', body.url, true);

      var headers = body.headers || {};
      headers['Content-Type'] = 'application/json';

      xhr.withCredentials = true;
      for(k in headers)
        xhr.setRequestHeader(k, heaaders[k]);

      xhr.addEventListener('readystatechange', function() {
        //        console.log('xmlPost returns.', xhr.status);
        switch(xhr.readyState) {
        case 4:
          // TODO
          // xhr.status == 200 ? dfd.resolve(): dfd.reject();
        }
      });

      xhr.addEventListener('error', onerror);
      xhr.addEventListener('abort', onerror);

      delete body.url, delete body.headers;
      xhr.send(JSON.stringify(mess));

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

})(typeof window != 'undefined', typeof module != 'undefined');
