/***/
// StableSocket
(function(has_win, has_mod) {

  var exports;
  if(has_win) {
    // browser, emulated window
    exports = window;
  } else {
    // raw Node.js, web-worker
    exports = typeof self == 'undefined' ? this: self;
  }

  // exports
  exports.StableSocket = StableSocket;

  // module.exports (require)
  !has_mod || (module.exports = StableSocket);

  /**
   * 
   */
  var Default = {

    OpenRetryTime: 5,
    OpenRetryInterval: 1000,

    DNSLookupTimeout: 10000,
    DNSLookupInterval: 10000,

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

  var browsing = typeof process == 'undefined';
  var _rid = 0, _timers = {}, _callbacks = {}, _connector = {};

  // necessary for DNS lookup
  var Sockets = [];
  var IntervalTimer = null, LookupTimer = null;

  /**
   * @constructor
   */
  function StableSocket(Socket, candidates, options) {

    if(!(this instanceof StableSocket)) {
      return new StableSocket(Socket, candidates, options);
    }

    var ss = this;
    Sockets.push(ss);

    ss._Socket = Socket;
    ss._actors = candidates;

    var opts = ss.options = options || {};
    opts.timeout = opts.timeout || Timeout.Request;
    ss.logger = opts.logger ? opts.logger: console;

    // care for non-enough object
    ['log', 'error'].forEach(function(k) {

      typeof ss.logger[k] == 'function' || (ss.logger[k] = function() {
        console.log.apply(console, arguments);
      });

    });

    ss._index = 0, ss._conn = null, ss._waits = [];
    ss.onopen = ss.onmessage = ss.onerror = ss.onclose = Function();

    // kick lookup checker if not exists
    if(opts.lookup_check !== false && IntervalTimer == null) {
      startDNSInterval(opts);
    }

  }

  var SSProtos = {

    connect: connect,
    isConnecting: isConnecting,

    readyState: readyState,
    status: status,

    send: send,
    close: close,
    toSilentMode: toSilentMode,
    toActiveMode: toActiveMode

  };
  for( var i in SSProtos)
    StableSocket.prototype[i] = SSProtos[i];

  /**
   * @prototype
   */
  function connect(rid) {

    var ss = this, Socket = ss._Socket;
    var msg, logger = ss.logger, opts = ss.options;
    var _waits = ss._waits;

    var conf = ss._actors[ss._index];
    conf || (conf = ss._actors[ss._index = 0]);

    if(conf == null) {
      onOpeningError(new Error('Actor for connect is not found.'));
      logger.error('Check your configuration!');
      logger.error(ss._actors, ss._index);
      return;
    }

    var ConnectURI = conf.ConnectURI;

    if(_connector[ConnectURI] != null) {
      // reconnecting warning
      console.log('[StableSocket] ' + new Date().toGMTString() + ' - ');
      console.log('Overwrite connector before close for: ' + ConnectURI);
      onClose();
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
    _initRetry(ss);

    // silent circumstances
    ss._silent_term = opts_retry.silent || Default.SilentTerm;
    ss._silent_timer = null;

    so.onopen = onOpen;
    so.onmessage = onMessage;

    so.onerror = function(e) {
      onOpeningError(e), so.close(); // close to stop reconnecting
    };
    so.onclose = function(e) {
      ss._open_error || onClose(e);
    };

    function onOpen() {

      ss.onLine = true;
      if(ss._silent_timer) {
        return;
      }

      // off opening error.
      onOpeningError = Function();

      // when open socket, assign as his own socket.
      // (by readyState judge, occasionally not better.)
      var rs = ss.readyState();
      if(rs != Socket.OPEN) {

        msg = 'StableSocket Connection is OPEN. \n';
        ss.onopen.call(ss, _connector[ConnectURI] = ss._conn = so);

      } else {

        msg = 'StableSocket Connection is ALREADY OPEN. \n';
        msg += 'Use another socket readyState:' + rs;
        msg += ', silently close the open socket. \n';
        so.onmessage = so.onerror = so.onclose = Function();
        so.close();

      }

      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length);
      _reset(rid);

      var waits = _waits;
      ss._waits = [];

      while(waits.length) {
        ss.send.apply(ss, waits.shift());
      }

      // refresh open error status
      _initRetry(ss);

    }

    function onOpeningError(e) {

      var rs = ss.readyState();
      if(rs == Socket.OPEN) {
        msg = 'StableSocket detects another opened socket on error.';
        return logger.log(msg);
      }

      ss.onLine = false;
      if(ss._silent_timer) {
        return;
      }

      msg = 'StableSocket Connection is ERRORED. ';
      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length);

      ss._conn === true && delete ss._conn;
      console.error(e);

      // if reconnecting, wait more error
      // until sleeping mode
      if(--ss._open_retry > 0 && typeof ss._open_retrya[0] == 'number') {
        setTimeout(function() {
          ss.connect(rid);
        }, ss._open_retrya[0]);
        return;
      }

      // ss._open_retry == 0
      ss._open_retry = ss._open_retry0;
      ss._open_retrya.shift();

      if(ss._open_retrya.length) {
        setTimeout(function() {
          ss.connect(rid);
        }, ss._open_retrya[0]);
        return;
      }

      _reset(rid);

      ss._open_error = {
        error: e,
        stamp: new Date()
      };

      var waits = _waits;
      ss._waits = [];

      var wait, cb;
      while(waits.length) {
        wait = waits.shift(), cb = wait.pop();
        typeof cb == 'function' ? cb(e): logger.log('Delete request: ', wait);
      }

      ss.onerror.call(ss, e);
      ss.toSilentMode();

    }

    function onMessage(m) {

      if(so !== ss._conn) {
        msg = 'StableSocket detects not-primary socket message.';
        msg += 'This socket will be closed silently.';
        return logger.log(msg), so.close();
      }

      ss.onLine = true;
      if(ss._silent_timer) {
        return;
      }

      //      console.log('[StableSocket] (' + ss._host + ') onMessage: ');
      //      console.log(m);
      try {

        // data analyzed by analyzer.
        // WebSocket => raw message 
        // EventSource => wrapped event object
        var raw = ss._host.indexOf('ws') == 0 ? m: m.data;
        var data = (opts.analyzer || Analyzer)(raw) || '';

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

      if(so !== ss._conn) {
        msg = 'StableSocket detects not-primary socket close.';
        return logger.log(msg);
      }

      ss.onLine = false;
      msg = 'StableSocket Connection is CLOSED. ';

      var ConnectURI = (conf || '').ConnectURI;
      logger.log(msg + '(' + ConnectURI + ')');

      var so = _connector[ConnectURI];
      if(so) {

        if(so.readyState != Socket.CLOSED) {
          try {
            logger.log('Unexpected readyState: ' + so.readyState);
            so.close();
          } catch(e) {
            logger.log('Closing error: ' + e.message);
          }
        }

        delete _connector[ConnectURI];
        ss.onclose.call(ss);

      }

    }

  }

  /**
   * 
   */
  function isConnecting() {
    return this._conn === true;
  }

  /**
   * 
   */
  function readyState() {
    return this.status();
  }

  /**
   * 
   */
  function status() {
    var ss = this;
    return (ss._conn || '').readyState;
  }

  /**
   * @prototype
   */
  function send() {

    var ss = this, Socket = ss._Socket;
    var mes, logger = ss.logger, opts = ss.options;
    var _waits = ss._waits;

    var args = Array.prototype.slice.call(arguments);
    var callback = args[args.length - 1];
    typeof callback == 'function' || (callback = null);

    // at the silent mode, "send" method immediately end.
    // in this case, all commands are disposed.
    if(ss._silent_timer) {
      return (callback || Function)();
    }

    // request identifier
    var rid = ++_rid & 0xffffff;

    if(callback) {
      callback.RETRY == null ? (callback.RETRY = 3): callback.RETRY--;
      _timers[rid] = setTimeout(requestTimeout, opts.timeout);
      _callbacks[rid] = callback;
    }

    if(ss._conn == null) {
      _waits.push(args);
      return ss.connect(rid);
    }

    if(ss.isConnecting()) {
      _waits.push(args);
      return;
    }

    //    console.log('send.readyState: ' + ss._conn.readyState, args);
    //    console.log(Socket.OPEN, Socket.CONNECTING, Socket.CLOSING, Socket.CLOSED);

    switch(ss.readyState()) {
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
      mes = 'Unexpected readyState: ' + ss._conn.readyState;
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
        (browsing ? xmlPost: nodePost)(mess);
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

        // debuglog
        //        console.log('nodePost returns for: ', options.path);
        //        console.log(res.statusCode, body);
        //
        //        res.on('data', function(buf) {
        //          console.log('nodePost.data: ' + buf.toString());
        //        });
        //        res.on('end', function() {
        //          console.log('nodePost.end.');
        //        });

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

    function requestTimeout() {

      var callback = _callbacks[rid];
      _reset(rid);

      mes = '[StableSocket] Timeout occurs.';
      logger.error(mes);
      logger.error(ss._actors[ss._index]);

      if(ss.isConnecting()) {
        // one more retry 
        ss.send.apply(ss, args);
      } else if(callback.RETRY) {

        // Open, but not reachable for the network reason.
        // Then, force reconnect.
        logger.log('[StableSocket] Open, but timeout occurs, remains retry: '
          + callback.RETRY);
        ss.onLine = false, ss._conn = null, ss._index++;
        ss.send.apply(ss, args);

      } else {
        callback(new Error(mes));
      }

    }

  }

  function close() {
    var ss = this, _conn = ss._conn;
    try {
      ss._conn = null;
      _conn.close();
    } catch(e) {
      console.log(new Date() + ' - ');
      console.log('[StableSocket] close error.', e);
    }
  }

  function toSilentMode() {

    var ss = this;
    if(ss._silent_timer) {
      return;
    }

    var term = ss._silent_term;
    if(typeof term == 'function') {
      term = term();
    }
    if(typeof term != 'number') {
      return;
    }

    // sign of mode change
    ss._silent_timer = setTimeout(function() {
      ss.toActiveMode();
    }, term);

    // readyState change
    !ss._conn || ss.close();

  }

  function toActiveMode() {

    var ss = this;
    if(!ss._silent_timer) {
      return;
    }

    // sign of mode change
    delete ss._silent_timer;

    // parameter initialize
    _initRetry(ss);

  }

  /**
   * @private
   */
  function startDNSInterval(opts) {

    opts = opts || {};

    var lup_intv = opts.interval || Default.DNSLookupInterval;
    var lup_timo = opts.timeout || Default.DNSLookupTimeout;

    var host = opts.host || (exports.location || '').host || 'google.com';
    var lookup = browsing ? nsBrowserLookup: nsNodeLookup;

    IntervalTimer = setImmediate(lookup);

    function nsBrowserLookup() {

      var xhr;
      xhr = new XMLHttpRequest();

      xhr.onreadystatechange = function() {
        if(xhr.readyState != xhr.DONE)
          return;
        clearNgTimer();
        (parseInt(String(xhr.status).charAt(0)) < 4 ? ok: ng)();
      };

      setNgTimer();

      var ptcl = opts.protocol || (exports.location || '').protocol;
      xhr.open('GET', [ptcl, host].join('//'), true);
      xhr.send(null);

    }
    function nsNodeLookup() {

      setNgTimer();

      require('dns').lookup(host, function(e, r) {
        if(LookupTimer === false)
          return;
        clearNgTimer(), e ? ng(): ok();
      });

    }

    function setNgTimer() {
      LookupTimer = setTimeout(ng, lup_timo);
    }
    function clearNgTimer() {
      clearTimeout(LookupTimer);
    }

    function ok() {
      Sockets.forEach(function(ss) {
        ss.onLine = true, ss.toActiveMode();
      });
      LookupTimer = false;
      IntervalTimer = setTimeout(lookup, lup_intv);
    }
    function ng() {
      Sockets.forEach(function(ss) {
        ss.onLine = false, ss.toSilentMode();
      });
      LookupTimer = false;
      IntervalTimer = setTimeout(lookup, lup_intv);
    }

  }

  /**
   * @private
   */
  function _initRetry(ss) {
    ss._open_error = null, ss._open_retry = ss._open_retry0;
    ss._open_retrya = [].concat(ss._open_retryi);
  }

  /**
   * @private
   */
  function _reset(rid) {
    clearTimeout(_timers[rid]), delete _timers[rid], delete _callbacks[rid];
  }

})(typeof window != 'undefined', typeof module != 'undefined');
