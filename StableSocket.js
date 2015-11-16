/***/
// StableSocket
(function(has_win, has_mod) {

  var global;
  if(has_win) {
    // browser, emulated window
    global = window;
  } else {
    // raw Node.js, web-worker
    global = typeof self == 'undefined' ? this: self;
  }

  // exports
  global.StableSocket = StableSocket;

  // module.exports (require)
  !has_mod || (module.exports = StableSocket);

  /**
   * 
   */
  var Default = {

    Host: {
      DNSLookup: 'google.com'
    },

    Limit: {
      OpenRetry: 5,
      RequestRetry: 3,
      MaxWait: 8 * 1024
    },

    Timeout: {
      Request: 8 * 1000,
      DNSLookup: 10 * 1000
    },

    Term: {
      Silent: 60 * 60 * 1000
    },

    Interval: {
      Open: 1 * 1000,
      DNSLookup: 10 * 1000
    }

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
    opts.callback = opts.callback == null ? true: opts.callback;

    opts.timeout = opts.timeout || Default.Timeout.Request;
    opts.retry = opts.retry || Default.Limit.RequestRetry;
    opts.max_wait = opts.max_wait || Default.Limit.MaxWait;

    ss.logger = opts.logger ? opts.logger: console;

    // care for non-enough object
    ['log', 'error'].forEach(function(k) {
      if(typeof ss.logger[k] == 'function') {
        return;
      }
      ss.logger[k] = function() {
        console.log.apply(console, arguments);
      };
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
    var opts_retry = opts.open_retry || '';
    ss._open_retry0 = opts_retry.times || Default.Limit.OpenRetry;
    ss._open_retryi = opts_retry.interval || Default.Interval.Open;
    _initRetry(ss);

    // silent circumstances
    ss._silent_term = opts_retry.silent || Default.Term.Silent;
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

      // re-send the waiting requests
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
        // This request may re-send via the opening socket.
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

      // If reconnecting, wait more error
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
        if(typeof cb == 'function') {
          cb.requestError(e)
        } else {
          logger.log('Delete request: ', wait);
        }
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

        // Data analyzed by analyzer.
        // "WebSocket" => raw message, "EventSource" => wrapped event object
        var raw = ss._host.indexOf('ws') == 0 ? m: m.data;
        var data = (opts.analyzer || Analyzer)(raw) || '';

        // and callback if exist.
        var h = data[0] || '', b = data[1] || '', rid = h.rid;
        (_callbacks[rid] || Function())(b), _reset(rid);

        // Get raw message.
        ss.onmessage(m, data);

      } catch(e) {

        // Get raw message. (unparsable message)
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
    var _waits = ss._waits, max_wait = opts.max_wait;

    var args = Array.prototype.slice.call(arguments);
    var callback = null, _cb = args[args.length - 1];
    if(opts.callback) {
      // If opts.callback available, set callback with RETRY parameter
      // (Default:true)
      if(typeof _cb == 'function') {

        // Set RETRY parameter for each request callback
        callback = _cb.RETRY == null ? function() {
          _cb.apply(this, arguments);
        }: _cb;
        args[args.length - 1] = callback;

      }
    }

    // at the silent mode, "send" method immediately end.
    // in this case, all commands are disposed.
    if(ss._silent_timer) {
      return (callback || Function)();
    }

    // request identifier
    var rid = ++_rid & 0xffffff;

    if(callback) {
      callback.RETRY == null ? (callback.RETRY = opts.retry): callback.RETRY--;
      callback.requestError = requestError;
      _timers[rid] = setTimeout(requestError, opts.timeout);
      _callbacks[rid] = callback;
    }

    if(ss._conn == null) {
      if(!pushQueue(args)) {
        return;
      }
      return ss.connect(rid);
    }

    if(ss.isConnecting()) {
      pushQueue(args);
      return;
    }

    //    console.log('send.readyState: ' + ss._conn.readyState, args);
    //    console.log(Socket.OPEN, Socket.CONNECTING, Socket.CLOSING, Socket.CLOSED);

    switch(ss.readyState()) {
    case Socket.OPEN:
      return write();

    case Socket.CONNECTING:
      pushQueue(args);
      return;

    case Socket.CLOSING:
      if(!pushQueue(args)) {
        return;
      }
      ss._index++;
      return ss.connect(rid);

    case Socket.CLOSED:
      if(!pushQueue(args)) {
        return;
      }
      ss._index++;
      return ss.connect(rid);

    default:
      mes = 'Unexpected readyState: ' + ss._conn.readyState;
      requestError(mes, false);
      return;

    }

    function pushQueue() {
      if(_waits.length < max_wait) {
        return _waits.push(args), true;
      }
      mes = 'Too many wait more than ' + max_wait;
      requestError(mes, false);
      return false;
    }

    function write() {

      var conv = (opts.converter || Converter);
      var rurl, mess;

      if(typeof args[0] == 'string' && args[1] == callback) {
        // send single raw string
        mess = args[0];
      } else {
        // multiple arguments
        mess = conv.apply(ss, [rid].concat(args));
      }

      // console.log('REQUEST:', mess, callback);
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

    function requestError(e, retry) {

      var callback = _callbacks[rid] || Function();
      _reset(rid);

      mes = '[StableSocket] request error occurs.'
      mes += '(' + (e ? e.message || e: 'timeout?') + ')';

      logger.error(mes);
      logger.error(ss._actors[ss._index]);

      if(ss.isConnecting()) {

        // One more retry => maybe queuing
        setTimeout(function() {
          ss.send.apply(ss, args);
        }, 80);
        return;

      }

      if(callback.RETRY > 0) {

        if(retry === false) {
          callback(new Error(mes));
          return;
        }

        // Open, but not reachable for the network reason.
        // Then, force reconnect.
        logger.log('[StableSocket] request error occurs. readyState: '
          + ss.readyState() + ', retry remains: ' + callback.RETRY);

        ss.onLine = false, ss._conn = null, ss._index++;
        ss.send.apply(ss, args);
        return;

      }

      callback(new Error(mes));

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

    var opts_lup = opts.lookup || '';
    var lup_intv = opts_lup.interval || Default.Interval.DNSLookup;
    var lup_timo = opts_lup.timeout || Default.Timeout.DNSLookup;

    var lookup = opts_lup.browsing || browsing ? nsBrowserLookup: nsNodeLookup;
    var host = opts_lup.host || opts.host || (global.location || '').host
      || Default.Host.DNSLookup;

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

      var ptcl = opts.protocol || (global.location || '').protocol;
      xhr.open('GET', [ptcl, host].join('//'), true);
      xhr.send(null);

    }
    function nsNodeLookup() {

      setNgTimer();

      var DNS = require(__dirname + '/lib/dns.js');
      DNS.lookup(host, function(e, r) {
        if(LookupTimer === false) {
          return;
        }
        clearNgTimer();
        e ? ng(): ok();
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
