/**
 *
 * StableSocket
 *
 * (c) Yoshitaka Sakamoto, East Cloud Inc., Startup Cloud Inc.
 *  all right reserved.
 * Synquery RSD - DEVELOP: #Sav8kEvx ,RELEASE: # 
 * principal contributor: 
 *    Yoshitaka Sakamoto <sakamoto@startup-cloud.co.jp>
 *
 **/
// StableSocket
(function(has_win, has_mod) {

  var NULL = null, TRUE = true, FALSE = false;
  var g;
  if(has_win) {
    // browser, emulated window
    g = window;
  } else {
    // raw Node.js, web-worker
    g = typeof self == 'undefined' ? this: self;
  }

  // exports
  g.StableSocket = StableSocket;

  // module.exports (require)
  !has_mod || (module.exports = StableSocket);

  // extra exports
  var DNS, setImmediate;
  if(typeof require == 'undefined') {

    DNS = g.DNS || Function();
    setImmediate = g.setImmediate || function(fn) {
      return setTimeout(fn, 4);
    };

  } else {

    DNS = require(__dirname + '/lib/dns.js');
    setImmediate = g.setImmediate;

  }
  StableSocket.DNS = DNS;

  /**
   * 
   */
  var DNS_OK, DNS_URL = 'https://raw.githubusercontent.com/ystskm/stable-socket-js/master/LICENSE';
  var Default = {

    Host: {
      DNSLookup: DNS_URL
    },

    Limit: {
      OpenRetry: 5,
      RequestRetry: 3,
      MaxWait: 50
    },

    Timeout: {
      Request: 8 * 1000,
      DNSLookup: 3 * 1000
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
      DNSLookup: 8 * 1000
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
    switch(msg) {
    case 'PING':
    case 'PONG':
      return msg;
    }
    return JSON.parse(msg);
  };

  var browsing = typeof process == 'undefined';
  var _rid = 0, _timers = {}, _callbacks = {}, _connector = {};
  var k, stdout;

  // Necessary for DNS lookup
  var Sockets = [];
  var IntervalTimer = NULL, LookupTimer = NULL;
  var ActiveSocketTime = Date.now();

  var wakeup = function() {
    DNS_OK = TRUE;
    Sockets.forEach(function(ss) {

      // DONNOT "toActivateMode" at status online.
      var Socket = ss._Socket || {};
      if(ss.onLine && ss.readyState() == Socket.OPEN) {
        return;
      }

      // ss.onLine = true; => occasionally bad AP exists.
      ss.toActiveMode(TRUE);

    });
  };
  var quiet = function() {
    DNS_OK = FALSE;
    Sockets.forEach(function(ss) {

      ss.onLine = FALSE;
      ss.toSilentMode(TRUE);

    });
  };

  var online = function() {
    Sockets.forEach(function(ss) {

      ss.onLine = TRUE;

    });
  };
  var offline = function() {
    Sockets.forEach(function(ss) {

      ss.onLine = FALSE;

    });
  };

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
    opts.callback = opts.callback == NULL ? TRUE: opts.callback;
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
    ss._silent_timer = NULL;

    // logger with care for non-enough object
    if(isFunction(opts.logger)) {
      ss.logger = {
        log: opts.logger,
        debug: opts.logger,
        info: opts.logger,
        warn: opts.logger,
        error: opts.logger,
      };
    } else {
      ss.logger = opts.logger || {};
    }
    ['log', 'debug', 'info', 'warn', 'error'].forEach(function(k) {
      
      if(isFunction(ss.logger[k])) {
        return;
      }
      ss.logger[k] = function() {
        if(ss.stdout() === FALSE) {
          return; 
        } // => Logging is disabled
        g.console.log.apply(g.console, arguments);
      };

    });

    // Initialize EventListeners
    var evts = ['open', 'message', 'error', 'close', 'denied'];
    ss._index = 0, ss._conn = NULL, ss._waits = [];

    // Stable Socket is NOT a event emitter.
    // Only one function can efficient for each object. ( onopen, ... )
    evts.forEach(function(evt_n) {
      ss['on' + evt_n] = Function();
    });

    // kick lookup checker if not exists
    if(!DNS.lookup || IntervalTimer != NULL) {
      return;
    }
    if(opts.lookup_check !== FALSE) {
      startDNSInterval(ss.logger, opts);
    }

  }

  var proto = {

    connect: connect,
    isConnecting: isConnecting,
    connectingTime: connectingTime,

    readyState: readyState,
    status: status,

    send: send,
    close: close,
    pinger: pinger,

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
    if(conf == NULL) {
      conf = ss._actors[ss._index = 0];
    }
    if(conf == NULL) {
      onOpeningError(new Error('Actor for connect is not found.'));
      logger.error('Check your configuration!');
      logger.error(ss._actors, ss._index);
      return;
    }

    var ConnectURI = conf.ConnectURI;
    if(_connector[ ConnectURI ] != NULL) {
      // reconnecting warning
      logger.log('[StableSocket] ' + new Date().toGMTString() + ' - ');
      logger.log('  Overwrite connector before close for: ' + ConnectURI);
      onClose();
    }

    var so_opts = {};
    so_opts.rejectUnauthorized = FALSE;
    so_opts.agent = opts.agent || FALSE; // DON'T USE gloablAgent

    var so = new Socket(ConnectURI + (opts.query || ''), so_opts);
    var so_stamp = ss._conn_stamp = Date.now(); // On connecting sign
    ss._host = ConnectURI.split('/').slice(0, 3).join('/');
    ss._conn = TRUE;
    
    var notPrimaryTime = 0;
    var evts_map = so.EventHandler = {
      open: onOpen,
      data: onMessage,
      message: onMessage,
      error: function(e) { 
        onOpeningError(e); // For care duplicated "onOpeningError" call.
      },
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

      ss._conn_stamp = NULL;
      ss._times.LastOpen = ActiveSocketTime = Date.now();
      online(), _clearSilentMode(ss);

      // Off opening event handler and opening error handler.
      onOpeningError = Function();
      ss.removeListeners(so, [ 'open' ]);

      // When open socket, ALWAYS assign as his own socket.
      // (for why the readyState judge, occasionally not better.)
      var rs = ss.readyState(), curr_so = ss._conn;
      if(rs != Socket.OPEN) {
        msg = 'StableSocket Connection is OPEN. \n';
      } else {

        msg = 'StableSocket Connection is ALREADY OPEN. \n';
        msg += 'Current socket readyState:' + rs;
        msg += ', silently close the current socket. \n';
        
        ss._conn = NULL; // For onClose event
        try { curr_so == NULL || curr_so == TRUE || curr_so.close(); } catch(e) { }

      }

      ss.onopen.call(ss, _connector[ ConnectURI ] = ss._conn = so);
      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length);
      _reset(rid);

      // laundering waits box
      var waits = _waits; ss._waits = [ ];

      // re-send the waiting requests
      while (waits.length) { ss.send.apply(ss, waits.shift()); }

      // refresh open error status
      _initRetry(ss);

    }

    function onOpeningError(e, keep) {

      var isPrimaryOpen = so_stamp == ss._conn_stamp;
      if(isPrimaryOpen) {
        ss._conn = NULL;
      }
      
      // Off opening error.
      ss._conn_stamp = NULL;
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

      ss.onLine = FALSE;
      if(ss._silent_timer) {
        return;
      }

      msg = 'StableSocket Connection is ERRORED. ';
      logger.log(msg + '(' + ConnectURI + ') waiting: ' + _waits.length + ', readyState: ' + ss.readyState() + ', isPrimaryOpen: ' + isPrimaryOpen);
      console.error(e);
      
      // If not primary process, wait another event
      if(!isPrimaryOpen) {
        return;
      }

      var retryConnect = function() {

        logger.log('retryConnect remains: ', ss._open_retry, ss._open_retrya);

        var intv = ss._open_retrya[0];
        if(!is('number', intv)) { 
          return FALSE; 
        }
        setTimeout(function() {

          ss.connect(rid);

        }, ss._open_retrya[0]);
        return TRUE;

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
          !isFunction(cb) || cb.requestError(e, FALSE);
        }
      } catch(e) {}

      ss.onerror.call(ss, e);
      ss.toSilentMode();

    }

    function onMessage(evt) {

      if(so !== ss._conn) {
        msg = '[StableSocket] Detects not-primary socket message.';
        msg += 'This socket will be closed silently. (' + evt + ')';
        return logger.log(msg), !so || so.close();
      }

      // Change to online mode when receiving a message.
      ActiveSocketTime = Date.now();
      online(), _clearSilentMode(ss);

      var h, b, rid;
      var cb;
      try {

        // Data analyzed by analyzer.
        // "WebSocket" => raw message, "EventSource" => wrapped event object
        var raw = ss._host.indexOf('ws') == 0 ? evt: evt.data;
        var data;
        switch(TRUE) {
        
        case isFunction(opts.analyzer):
          data = opts.analyzer(raw);
          break;
          
        case opts.analyzer === FALSE:
          data = raw;
          break;
          
        default:
          data = Analyzer(raw);
        
        }

        // And callback if exist.
        if(isArray(data)) {
          h = data[0] || {}, b = data[1], rid = h.rid;
          cb = _callbacks[rid];
        }

        // Callback with 1st argument treat as "SUCCESSFULLY" 
        // for the function(data, callback){ ... } type.
        var rep, pos, rd;
        if(isFunction(cb)) {
          
          rd = [];
          rep = cb.reply || {}; // (Default) { val_i: 1, err_i: 2, pos_i: 0, ini_v: undefined }
          pos = rep.pos_i || 0;

          var setOkInit = function() {
            rd[2] = 'ok';
            if(rd[pos] || is('undefined', rep.ini_v)) {
              return;
            }
            rd[pos] = rep.ini_v;
          };

          // Detect error
          if(rep.err_i != NULL) {
            rd[0] = data[rep.err_i];
          }

          // Detect reply value
          switch(TRUE) {

          case rd[0] != NULL:
            rd[2] = 'ng';
            break;

          case is('number', rep.val_i):
            rd[pos] = data[rep.val_i];
            setOkInit();
            break;

          default:
            rd[pos] = data;
            setOkInit();

          } // <-- switch(TRUE) { ... } <--
          
          // Execute callback!
          cb(rd[0], rd[1], rd[2]);
          
        } // <-- if(isFunction(cb)) { ... } <--
        
        // Cleanup request memories
        if(rid) {
          _reset(rid);
        }

        // Get raw message.
        ss.onmessage(evt, data);

      } catch(e) {

        // Cleanup request memories
        if(rid) {
          _reset(rid);
        }
        
        // Get raw message. 
        // (Default: ex-parsable message, except "PING" and "PONG")
        ss.logger.error(e);
        ss.onmessage(evt, FALSE);

      }
    }

    function onClose(evt) {

      if(ss._open_error) return;

      // Should always remove all listeners.
      ss.removeListeners(so);
      msg = '[StableSocket.onClose](DNS=' + DNS_OK + ') ';

      // Get ConnectURI
      var ConnectURI = (conf || '').ConnectURI;

      // "so" always an instance of Socket.
      var pre_co = ss._conn;
      if(so !== pre_co) {
        switch(pre_co) {

        case NULL:
          // On create new socket after closing old socket.
          logger.log(msg + 'Detects reconnect.');
          break;

        case TRUE:
          logger.log(msg + 'Detects connecting socket error.');
          break;

        default:
          logger.log(msg + 'Detects not-primary socket close.');

        }
        if(pre_co == NULL || !DNS_OK) { return; }
        // It's NOT good condition, so that, emit event "ondenied"
        ss.ondenied.call(ss, ConnectURI);
        return;
      }

      ss.onLine = FALSE, ss._times.LastClose = Date.now();
      msg += 'Connection is CLOSED. ';
      logger.log(msg + '(' + ConnectURI + ')');

      // If arbitrary close is detected, emit event "ondenied"
      if(ss._times.LastClose - ss._times.LastOpen < opts.delay_as_denied) {
        ss.ondenied.call(ss, ConnectURI);
      }

      var _so = _connector[ ConnectURI ];
      if(_so == NULL) return;
      if(_so.readyState != Socket.CLOSED) {
        try {
          logger.log('Unexpected readyState: ' + _so.readyState);
          !_so || _so.close();
        } catch(e) {
          logger.log('Closing error: ' + e.message);
        }
      }

      delete _connector[ ConnectURI ];
      ss.onclose.call(ss);

    }

  }

  /**
   * 
   */
  function isConnecting() {
    return this._conn === TRUE;
  }

  /**
   * 
   */
  function connectingTime() {
    return this._conn_stamp ? Date.now() - this._conn_stamp: NULL;
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
    var msg, logger = ss.logger, opts = ss.options;
    var _waits = ss._waits, max_wait = opts.max_wait;

    var args = casting(arguments);
    var callback = NULL, options = {}, _cb = args[args.length - 1];

    // Setup timeout checker if callback is given
    var hasCb = isFunction(_cb);
    
    // PING, PONG and any signal message => DISABLE callback preferences
    var is_sig = is('string', args[0]) && !hasCb;
    
    if(!is_sig && !hasCb) {
      args.push(_cb = Function());
    }
    if(args.length >= 3) {
      options = args[args.length - 2] || {};
    }

    var _cbOpcd;
    // If opts.callback available, set callback with RETRY parameter
    // (Default:true)
    if(opts.callback) {

      // The "_cb" occasionally options
      // "opcodeCallback" for the easy check (=> callback on response)
      _cbOpcd = !!options.opcodeCallback;
      if(hasCb || _cbOpcd) {

        // Now, always set "_cbOpcd" truly
        // for when has truly callback, timeout occurs 
        // if "_cbOpcd" is falsy.
        _cbOpcd = TRUE;

        // Set RETRY parameter for each request callback
        // with wrapping.
        callback = _cb.RETRY != NULL ? _cb: function() {
          _cb.apply(this, arguments);
        };
        args[args.length - 1] = callback;

      }

    }
    var closeProc = function(ty) {
      
      var cb = callback || {};
      // Open, but not reachable for the network reason.
      // Then, force reconnect.
      logger.log('[StableSocket] request error occurs. (readyState: '
        + ss.readyState() + ', ' + ty + ', retry remains: ' + cb.RETRY) + ')';

      var waits, w_ar, w_cb;
      if(ty == 'BAD SOCKET CONDITION') {
        // All waiting response is disposed like as silent mode.
        // Current process callback will closed after closeProc, then DONNOT THROW ERROR!
        waits = ss._waits || [ ];
        while(waits.length) {
          try {
            w_ar = waits.shift();
            if( !isArray(w_ar) ) continue;
            if( isFunction(w_cb = w_ar[w_ar.length - 1]) ) { w_cb(ty); }
          } catch(e) { ss.logger.error(e); }
        }
        ss._waits = [ ];
      }
      
      // Don't forget remove listeners and close socket.
      // Old socket no longer be used.
      ss.removeListeners(ss._conn);
      ss.close();

      // Set reconnect condition and re-open new socket.
      ss.onLine = FALSE, ss._conn = NULL, ss._index++;
      
    };
    // FOR DEBUGGING LOG
    // logger.log('[StableSocket] Method "send" is called with:');
    // logger.log('  _conn        : ' + String(ss._conn));
    // logger.log('  _silent_timer: ' + ss._silent_timer);
    // logger.log('  isConnecting : ' + ss.isConnecting());
    // logger.log('  readyState   : ' + ss.readyState());

    // At the silent mode, "send" method immediately end.
    // in this case, all commands are disposed.
    if(ss._silent_timer) {
      return (callback || Function)();
    }
    
    // When the connecting time is TOO LONG, may in some network-suspicious
    // illegal state.
    if(ss.isConnecting() && ss.connectingTime() > opts.timeout) {
      closeProc('SEND');
    }

    // request identifier
    var rid = ++_rid & 0xffffff;
    if(!is_sig && callback) {

      if(callback.RETRY == NULL) {
        callback.RETRY = options.retry || opts.retry;
      } else {
        callback.RETRY--;
      }

      // fix the callback return value ([ [data|body|head], falsy value ])
      callback.reply = options.reply || opts.reply || {
        val_i: 1, // where the value exists in reply message from socket
        err_i: 2, // where the error exists in reply message from socket
        pos_i: 0, // index to set value for callback reply (now, error always set to 0)
      // ini_v: undefined
      };
      callback.requestError = requestError;

      // register the callback
      _timers[rid] = setTimeout(requestError, opts.timeout);
      _callbacks[rid] = callback;

    }

    if(ss._conn == NULL) {
      pushQueue(args, rid);
      ss.connect(rid); // reconnect even if the queuing was failed.
      return;
    }

    if(ss.isConnecting()) {
      pushQueue(args, rid);
      return;
    }

    var rs = ss.readyState();
    switch(rs) {
    
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
      msg = 'Unexpected readyState: ' + rs;
      return requestError(msg, FALSE);

    }

    function pushQueue(args, rid) {
      _reset(rid);
      if(_waits.length < max_wait) {
        return _waits.push(args), TRUE;
      }
      msg = 'Too many wait more than ' + max_wait;
      requestError(msg, FALSE);
      return FALSE;
    }

    function stringMessage(mess) {
      return is('string', mess) ? mess: JSON.stringify(mess);
    }

    function write() {

      var conv = (opts.converter || Converter);
      var rurl, mess;

      if(is_sig) {
        // send single raw string
        // e.g. PING, PONG and any signal message
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
        headers: headers
      };

      options.rejectUnauthorized = FALSE;
      options.agent = opts.agent || FALSE; // DON'T USE gloablAgent

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
      xhr.open('POST', body.url, TRUE);

      headers['Content-Type'] = 'application/json';
      xhr.withCredentials = TRUE;
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
        online();
        callback({
          ok: 1,
          message: xhr_t || xhr_x
        });

        // Callback immediately occurs on "opcodeCallback" response.
        return;

      }
      requestError(xhr_t || xhr_x, FALSE);

    }

    function requestError(e, retry) {

      var callback = _callbacks[rid] || Function();
      _reset(rid);

      msg = '[StableSocket] request error (type:' + (e ? e.type: 'unknown') + ') occurs.'
      msg += ' (' + (e ? e.message || e: 'timeout?');
      msg += ', readyState: ' + ss.readyState() + ', connecting: ' + ss.isConnecting() + ', connectingTime: ' + ss.connectingTime() + ')';

      logger.log(msg);
      logger.error(ss._actors[ss._index]);
      
      e = new Error(msg);
      if(retry !== FALSE) {
        
        if(ss.isConnecting() && ss.connectingTime() <= opts.timeout) {
          // One more retry => maybe queuing
          setTimeout(function() {
            ss.send.apply(ss, args);
          }, 80 + parseInt( 3600 * Math.random() ));
          return;
        }
        
        // Socket condition may TOO BAD!!!
        if(callback.RETRY !== FALSE && callback.RETRY > 0) {
          closeProc('RETRY:' + callback.RETRY);
          setTimeout(function() {
            ss.send.apply(ss, args);
          }, 80 + parseInt( 3600 * Math.random() ));
          return;
        }
        
      }

      // Socket condition may TOO BAD!!! + NO RETRY!!!
      closeProc('BAD SOCKET CONDITION');
      callback(e);
      return;

    }

  }

  function close() {

    var ss = this, logger = ss.logger;
    var so = ss._conn;
    try {
      ss.onLine = FALSE, ss._conn = NULL;
      !so || so.close();
      logger.log('[StableSocket] Close connection: ' + ss._host);
    } catch(e) {
      logger.log('[StableSocket] Close error. ' + (e || {}).message);
    }

  }
  function pinger(intv) {

    var ss = this, ss_opts = ss.options;
    if(isFunction(ss_opts.ping)) setTimeout(ss_opts.ping, intv || 1000);

  }
  function removeListeners(so, evts, evts_map) {

    var ss = this;
    so = so || ss._conn || {};
    evts_map = evts_map || so.EventHandler || {};
    evts = Array.isArray(evts) ? evts: Object.keys(evts_map);

    switch(TRUE) {

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
      so['on' + evt_ty] = NULL; delete evts_map[evt_ty];
    });

  }

  function toSilentMode(lup_op) {

    var ss = this;
    if(ss._silent_timer) return;

    var term = ss._silent_term;
    if(isFunction(term)) term = term();
    if(!is('number', term)) return;

    // Buffer time before silent mode (ActiveSocketTime + 1 min)
    if(Date.now() < ActiveSocketTime + 60 * 1000) return;

    // Sign of mode change
    // Challenge to online with interval timer
    ss._silent_timer = setTimeout(function() { ss.toActiveMode(); }, term);

  }

  function toActiveMode(lup_op) {

    var ss = this;

    // Sign of mode change
    _clearSilentMode(ss);

    // Challenge reconnect immediately.
    ss.pinger(); // => try reconnect

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
  function startDNSInterval(logger, opts) {

    // Inherits StableSocket options
    opts = opts || {};

    var opts_lup = opts.lookup || '';
    var lup_intv = opts_lup.interval || Default.Interval.DNSLookup;
    var lup_timo = opts_lup.timeout || Default.Timeout.DNSLookup;

    var lookup = opts_lup.browsing || browsing ? nsBrowserLookup: nsNodeLookup;
    var host = opts_lup.host || opts.host || (g.location || '').host
      || Default.Host.DNSLookup;

    var msg = '[StableSocket] Starting DNS lookup to:' + host;
    msg += ' (interval:' + lup_intv + ', timeout:' + lup_timo + ')';
    logger.log(msg);

    // The first lookup timer
    IntervalTimer = setImmediate(lookup);

    function nsBrowserLookup() {

      var xhr, ptcl;
      setNgTimer();

      xhr = new XMLHttpRequest();
      xhr.onreadystatechange = function() {
        if(xhr.readyState != xhr.DONE) return;
        if(LookupTimer === FALSE) return;
        clearNgTimer();
        (parseInt(String(xhr.status).charAt(0)) < 4 ? ok: ng)();
      };

      ptcl = opts.protocol || (g.location || '').protocol;
      xhr.open('GET', [ptcl, host].join('//'), TRUE);
      xhr.send(NULL);

    }
    function nsNodeLookup() {

      setNgTimer();

      DNS.lookup(host, {
        proxy: opts.proxy,
        timeout: lup_timo
      }, function(e, r) {
        if(LookupTimer === FALSE) return;
        clearNgTimer();
        e ? ng(e): ok();
      });

    }

    function setNgTimer() {
      LookupTimer = setTimeout(ng, lup_timo);
    }
    function clearNgTimer() {
      clearTimeout(LookupTimer);
    }

    function ok() {
      // Be careful that DNS result is not always correct.
      // logger.log('Lookup ok!');
      if(LookupTimer == FALSE) return;
      wakeup();
      LookupTimer = FALSE;
      IntervalTimer = setTimeout(lookup, lup_intv);
    }
    function ng(e) {
      // Be careful that DNS result is not always correct.
      // logger.log('Lookup ng!');
      if(LookupTimer == FALSE) return;
      logger.log(e);
      quiet();
      LookupTimer = FALSE;
      IntervalTimer = setTimeout(lookup, lup_intv);
    }

  }

  /**
   * @private
   */
  function _clearSilentMode(ss) {

    // Initialize parameter 
    _initRetry(ss);

    var timer = ss._silent_timer;
    if(timer == NULL) return;

    clearTimeout(timer);
    ss._silent_timer = NULL;

  }

  /**
   * @private
   */
  function _initRetry(ss) {
    ss._open_error = NULL, ss._open_retry = ss._open_retry0;
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
  function isArray(x) {
    return Array.isArray(x);
  }

})(typeof window != 'undefined', typeof module != 'undefined');
