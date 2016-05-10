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

  // extra exports
  var DNS;
  if(typeof require == 'undefined') {
    DNS = global.DNS || Function();
  } else {
    DNS = require(__dirname + '/lib/dns.js');
  }
  StableSocket.DNS = DNS;

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
      DNSLookup: 8 * 1000
    },

    Delay: {
      Denied: 300
    },

    Term: {
      // 5 minute
      Silent: 5 * 60 * 1000
    },

    Interval: {
      Open: [1 * 1000, 10 * 1000, 15 * 1000, 30 * 1000, 60 * 1000],
      DNSLookup: 10 * 1000
    }

  };

  // Sending Data
  var Converter = function(rid, obj) {
    return [{
      rid: rid
    }, obj];
  };

  // Receiving Data
  var Analyzer = function(msg) {
    return JSON.parse(msg);
  };

  var browsing = typeof process == 'undefined';
  var _rid = 0, _timers = {}, _callbacks = {}, _connector = {};
  var k, stdout;

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
    ss._times = {};

    var opts = ss.options = options || {};
    opts.callback = opts.callback == null ? true: opts.callback;

    opts.timeout = opts.timeout || Default.Timeout.Request;
    opts.retry = opts.retry || Default.Limit.RequestRetry;
    opts.max_wait = opts.max_wait || Default.Limit.MaxWait;
    opts.delay_as_denied = opts.delay_as_denied || Default.Delay.Denied;

    // retry status when OpenError occurs.
    var opts_retry = opts.open_retry || '';
    ss._open_retry0 = opts_retry.times || Default.Limit.OpenRetry;
    ss._open_retryi = opts_retry.interval || Default.Interval.Open;
    _initRetry(ss);

    // silent circumstances
    ss._silent_term = opts_retry.silent || Default.Term.Silent;
    ss._silent_timer = null;

    // logger with care for non-enough object
    ss.logger = opts.logger ? opts.logger: Function();
    ['log', 'error'].forEach(function(k) {

      isFunction(ss.logger[k]) || (ss.logger[k] = function() {
        if(ss.stdout() === false) return;
        global.console.log.apply(global.console, arguments);
      });

    });

    // Initialize EventListeners
    var evts = ['open', 'message', 'error', 'close', 'denied'];
    ss._index = 0, ss._conn = null, ss._waits = [];

    // Stable Socket is NOT a event emitter.
    // Only one function can efficient for each object. ( onopen, ... )
    evts.forEach(function(evt_n) {
      ss['on' + evt_n] = Function();
    });

    // kick lookup checker if not exists
    if(!DNS.lookup) {
      return;
    }
    if(opts.lookup_check !== false && IntervalTimer == null) {
      startDNSInterval(opts);
    }

  }

  var proto = {

    connect: connect,
    isConnecting: isConnecting,

    readyState: readyState,
    status: status,

    send: send,
    close: close,

    // addListeners: addListeners,
    removeListeners: removeListeners,

    toSilentMode: toSilentMode,
    toActiveMode: toActiveMode,
    redefineCandidates: redefineCandidates,
    startDNSInterval: startDNSInterval,

    stdout: function(v) {
      v == null || (stdout = v);
      return stdout;
    }

  };
  for(k in proto) {
    StableSocket.prototype[k] = proto[k];
  }

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
      logger.log('[StableSocket] ' + new Date().toGMTString() + ' - ');
      logger.log('  Overwrite connector before close for: ' + ConnectURI);
      onClose();
    }

    var so = new Socket(ConnectURI + (opts.query || ''), {
      rejectUnauthorized: false
    });

    ss._host = ConnectURI.split('/').slice(0, 3).join('/');
    ss._conn = true; // on connecting sign

    var evts_map = so.EventHandler = {
      open: onOpen,
      data: onMessage,
      message: onMessage,
      close: onClose
    };

    if(isFunction(so.addEventListener)) {
      Object.keys(evts_map).forEach(function(evt_ty) {
        so.addEventListener(evt_ty, evts_map[evt_ty]);
      });
    } else {
      Object.keys(evts_map).forEach(function(evt_ty) {
        so['on' + evt_ty] = evts_map[evt_ty];
      });
    }

    function onOpen(evt) {

      ss.onLine = true, ss._times['LastOpen'] = Date.now();
      if(ss._silent_timer) {
        return;
      }

      // Off opening event handler and opening error handler.
      onOpeningError = Function();
      ss.removeListeners(so, ['open']);

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
        ss.close();

      }

      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length);
      _reset(rid);

      var waits = _waits;
      ss._waits = [];

      // re-send the waiting requests
      while (waits.length) {
        ss.send.apply(ss, waits.shift());
      }

      // refresh open error status
      _initRetry(ss);

    }

    function onOpeningError(e, keep) {

      // Off opening error.
      onOpeningError = Function();
      ss.removeListeners(so);

      try {
        // Destroy the creating socket 
        // to avoid automatic reconnecting.
        so.close();
      } catch(e) {
        msg = 'StableScoket close error on "onOpeningError" close.'
        logger.log(msg + (e ? e.message || e: 'unknown'));
      }

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
      console.error(e);

      var retryConnect = function() {

        logger.log('retryConnect remains: ', ss._open_retry, ss._open_retrya);

        var intv = ss._open_retrya[0];
        if(!is('number', intv)) return false;
        setTimeout(function() {

          if(ss.isConnecting()) ss._conn = null;
          ss.connect(rid);

        }, ss._open_retrya[0]);
        return true;

      };
      // If reconnecting, wait more error
      // until sleeping mode
      if(--ss._open_retry > 0 && retryConnect()) {
        return;
      }

      // Now, _open_retry === 0
      ss._open_retry = ss._open_retry0;
      ss._open_retrya.shift();

      if(retryConnect()) {
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
      logger.log('Goto removing ' + waits.length + ' requests.');

      try {
        while (waits.length) {
          wait = waits.shift();
          cb = wait.pop();
          !isFunction(cb) || cb.requestError(e, false);
        }
      } catch(e) {

      }

      ss.onerror.call(ss, e);
      ss.toSilentMode();

    }

    function onMessage(evt) {

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
        var raw = ss._host.indexOf('ws') == 0 ? evt: evt.data;
        var data = (opts.analyzer || Analyzer)(raw) || '';

        // and callback if exist.
        var h = data[0] || '', b = data[1] || '', rid = h.rid;
        var cb = _callbacks[rid];

        // callback with 1st argument treat as "SUCCESSFULLY" 
        // for the function(data, callback){ ... } type.
        !isFunction(cb) || cb(b);
        _reset(rid);

        // Get raw message.
        ss.onmessage(evt, data);

      } catch(e) {

        // Get raw message. (exparsable message)
        ss.onmessage(evt, false);

      }
    }

    function onClose(evt) {

      if(ss._open_error) return;

      // Should always remove all listeners.
      ss.removeListeners(so);
      msg = '[StableSocket.onClose] ';

      var pre_co = ss._conn;
      if(so !== pre_co) {
        switch(pre_co) {

        case null:
          msg += 'Detects reconnect.';
          break;

        case true:
          msg += 'Detects connecting socket error.';
          break;

        default:
          msg += 'Detects not-primary socket close.';

        }
        return logger.log(msg);
      }

      ss.onLine = false, ss._times['LastClose'] = new Date();
      msg += 'Connection is CLOSED. ';

      var ConnectURI = (conf || '').ConnectURI;
      logger.log(msg + '(' + ConnectURI + ')');

      // If arbitrary close is detected, emit event "ondenied"
      if(ss._times['LastClose'] - ss._times['LastOpen'] < opts.delay_as_denied) {
        ss.ondenied.call(ss, ConnectURI);
      }

      var _so = _connector[ConnectURI];
      if(_so == null) return;

      if(_so.readyState != Socket.CLOSED) {
        try {
          logger.log('Unexpected readyState: ' + _so.readyState);
          _so.close();
        } catch(e) {
          logger.log('Closing error: ' + e.message);
        }
      }

      delete _connector[ConnectURI];
      ss.onclose.call(ss);

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

    var args = casting(arguments);
    var callback = null, options = {}, _cb = args[args.length - 1];

    if(!isFunction(_cb)) {
      args.push(_cb = Function());
    }
    if(args.length >= 3) {
      options = args[args.length - 2] || {};
    }

    var _cbOpcd;
    if(opts.callback) {

      // If opts.callback available, set callback with RETRY parameter
      // (Default:true)

      // The "_cb" occasionally options
      // "opcodeCallback" for the easy check
      _cbOpcd = !!options.opcodeCallback;

      // Set RETRY parameter for each request callback
      callback = _cb.RETRY == null ? function() {
        _cb.apply(this, arguments);
      }: _cb;
      args[args.length - 1] = callback;

    }

    // at the silent mode, "send" method immediately end.
    // in this case, all commands are disposed.
    if(ss._silent_timer) {
      return (callback || Function)();
    }

    // request identifier
    var rid = ++_rid & 0xffffff;
    if(callback) {

      if(callback.RETRY == null) {
        callback.RETRY = options.retry || opts.retry
      } else {
        callback.RETRY--;
      }

      callback.requestError = requestError;
      _timers[rid] = setTimeout(requestError, opts.timeout);
      _callbacks[rid] = callback;

    }

    if(ss._conn == null) {
      if(!pushQueue(args, rid)) return;
      return ss.connect(rid);
    }

    if(ss.isConnecting()) {
      pushQueue(args, rid);
      return;
    }

    //    console.log('send.readyState: ' + ss._conn.readyState, args);
    //    console.log(Socket.OPEN, Socket.CONNECTING, Socket.CLOSING, Socket.CLOSED);

    switch(ss.readyState()) {
    case Socket.OPEN:
      return write();

    case Socket.CONNECTING:
      pushQueue(args, rid);
      return;

    case Socket.CLOSING:
      if(!pushQueue(args, rid)) return;
      return ss._index++, ss.connect(rid);

    case Socket.CLOSED:
      if(!pushQueue(args, rid)) return;
      return ss._index++, ss.connect(rid);

    default:
      mes = 'Unexpected readyState: ' + ss._conn.readyState;
      return requestError(mes, false);

    }

    function pushQueue(args, rid) {
      _reset(rid);
      if(_waits.length < max_wait) return _waits.push(args), true;
      requestError('Too many wait more than ' + max_wait, false);
      return false;
    }

    function stringMessage(mess) {
      return is('string', mess) ? mess: JSON.stringify(mess);
    }

    function write() {

      var conv = (opts.converter || Converter);
      var rurl, mess;

      if(is('string', args[0]) && args[1] == callback) {
        // send single raw string
        mess = args[0];
      } else {
        // Multiple arguments
        mess = conv.apply(ss, [rid].concat(args));
      }

      var so = ss._conn;
      if(so.send) {

        // type: WebSocket
        so.send(stringMessage(mess));

      } else {

        // type: EventSource
        (browsing ? xmlPost: nodePost)(mess);

      }

    }

    function nodePost(mess) {

      var host = ss._host;
      var body = Array.isArray(mess) ? mess[1]: mess;
      var url = body.url, headers = body.headers || {};
      var prtc = host.indexOf('https') === 0 ? 'https': 'http';

      headers['Content-Type'] = 'application/json';
      var options = {
        hostname: host.replace(prtc + '://', ''),
        path: url,
        method: 'POST',
        headers: headers,
        rejectUnauthorized: false
      };

      //      console.log('MESSAGE!', mess, options);

      // DON'T SEND URL and HEADERS, and DON'T FORGET "REVERT"!!
      delete body.url, delete body.headers;
      var r = require(prtc).request(options, function(res) {

        // TODO check ok
        if(!_cbOpcd) return;

        var t = '';
        res.on('data', function(buf) {
          t += buf.toString();
        }).on('end', function() {
          response(res.statusCode == 200, t, r);
        });

      });

      r.on('error', requestError);
      r.write(stringMessage(mess));
      r.end();

      body.url = url;
      body.headers = headers;

    }

    function xmlPost(mess) {

      var k, xhr = new XMLHttpRequest();
      var body = Array.isArray(mess) ? mess[1]: mess;
      var url = body.url, headers = body.headers || {};
      xhr.open('POST', body.url, true);

      headers['Content-Type'] = 'application/json';
      xhr.withCredentials = true;
      for(k in headers) {
        xhr.setRequestHeader(k, headers[k]);
      }

      xhr.addEventListener('readystatechange', function() {
        if(xhr.readyState != 4 || !_cbOpcd) return;
        response(xhr.status == 200, xhr.responseText, xhr.response);
      });

      xhr.addEventListener('error', requestError);
      xhr.addEventListener('abort', requestError);

      // DON'T SEND URL and HEADERS, and DON'T FORGET "REVERT"!!
      delete body.url, delete body.headers;
      xhr.send(stringMessage(mess));

      body.url = url;
      body.headers = headers;

    }

    function response(ok, xhr_t, xhr_x) {

      var callback = _callbacks[rid] || Function();
      if(ok) {

        _reset(rid);
        callback({
          ok: 1,
          message: xhr_t || xhr_x
        });

        // Callback immediately occurs on "opcodeCallback" response.
        return;
      }

      requestError(xhr_t || xhr_x, false);

    }

    function requestError(e, retry) {

      var callback = _callbacks[rid] || Function();
      _reset(rid);

      mes = '[StableSocket] request error occurs.'
      mes += '(' + (e ? e.message || e: 'timeout?') + ')';

      logger.error(mes);
      logger.error(ss._actors[ss._index]);

      e = new Error(mes);
      if(callback.RETRY === false) return callback(e);

      if(ss.isConnecting()) {
        // One more retry => maybe queuing
        setTimeout(function() {
          ss.send.apply(ss, args);
        }, 80);
        return;
      }

      var so = ss._conn;
      if(callback.RETRY > 0) {

        // Open, but not reachable for the network reason.
        // Then, force reconnect.
        logger.log('[StableSocket] request error occurs. readyState: '
          + ss.readyState() + ', retry remains: ' + callback.RETRY);

        // Don't forget remove listeners and close socket.
        // Old socket no longer be used.
        ss.removeListeners(so), !so || so.close();

        // Set reconnect condition and re-open new socket.
        ss.onLine = false, ss._conn = null, ss._index++;
        ss.send.apply(ss, args);
        return;

      }

      callback(e);

    }

  }

  function close() {

    var ss = this, logger = ss.logger;
    var so = ss._conn;

    try {
      ss._conn = null;
      so.close();
    } catch(e) {
      logger.log('[StableSocket] close error.', e);
    }

  }

  function removeListeners(so, evts, evts_map) {

    var ss = this;
    so = so || ss._conn || {};
    evts_map = evts_map || so.EventHandler || {};
    evts = Array.isArray(evts) ? evts: Object.keys(evts_map);

    switch(true) {

    case isFunction(so.removeEventListener):
      evts.forEach(function(evt_ty) {
        so.removeEventListener(evt_ty, evts_map[evt_ty] || Function());
      });
      break;

    case isFunction(so.off):
      evts.forEach(function(evt_ty) {
        so.off(k, evts_map[evt_ty] || Function());
      });
      break;

    }

    // always overwrite ' on ... ' for avoid illegal handling.
    evts.forEach(function(evt_ty) {
      so['on' + evt_ty] = null;
      delete evts_map[evt_ty];
    });

  }

  function toSilentMode() {

    var ss = this;
    if(ss._silent_timer) return;

    var term = ss._silent_term;
    if(isFunction(term)) term = term();
    if(!is('number', term)) return;

    // sign of mode change
    ss._silent_timer = setTimeout(function() {
      ss.toActiveMode();
    }, term);

    // readyState change
    if(ss.readyState()) {
      ss.close();
    }

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
   * @returns <Object> StableSocket
   */
  function redefineCandidates(candidates) {
    var ss = this;

    var _actors = ss._actors;
    ss._actors = candidates;

    return ss;
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
        if(xhr.readyState != xhr.DONE) return;
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
    clearTimeout(_timers[rid]);
    delete _timers[rid], delete _callbacks[rid];
  }

  function casting(x) {
    return Array.prototype.slice.call(x);
  }
  function is(ty, x) {
    return typeof x == ty;
  }
  function isFunction(x) {
    return typeof x == 'function';
  }

})(typeof window != 'undefined', typeof module != 'undefined');
