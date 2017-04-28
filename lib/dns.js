/**
 *
 * StableSocket - dns.js
 *   (Synquery RSD - DEVELOP:#,RELEASE:#)
 *
 * (c) Yoshitaka Sakamoto, East Cloud Inc., Startup Cloud Inc.
 *  all right reserved.
 *
 * principal contributor: 
 *    Yoshitaka Sakamoto <sakamoto@startup-cloud.co.jp>
 *
 **/
(function(has_win, has_self, has_mod) {

  var NULL = null, TRUE = true, FALSE = false;
  var g;
  if(has_win) {
    // browser, emulated window
    g = window;
    browserInstall();
  } else {
    // raw Node.js, web-worker
    g = typeof self == 'undefined' ? this: self;
    typeof GLOBAL == 'undefined' ? browserInstall(): serverInstall();
  }

  /**
   * 
   */
  function browserInstall() {

    g.DNS = DNS;
    DNS.lookup = lookup;

    function DNS() {
    }

    /**
     * Support "http.get" only on browser.
     */
    function lookup(host, options, cb) {
      if(typeof options == 'function') {
        cb = options, options = {};
      }
      if(options == NULL) {
        options = {};
      }
      var mtc = host.match(/^(https?):/);
      if(mtc) {

        // Use http - https request for lookup.
        var xhr;
        return new Promise(function(rsl, rej) {

          var method = options.method || 'GET';
          var timeout = options.timeout || 3000;
          setTimeout(function() {
            rej('HTTP lookup timeout. (' + timeout + 'ms)');
          }, timeout);

          xhr = new XMLHttpRequest();
          xhr.open(method, host, TRUE);
          xhr.onabort = xhr.onerror = rej;
          xhr.onreadystatechange = function(evt) {
            if(xhr.readyState === XMLHttpRequest.DONE) {
              xhr.statusCode === 0 ? rej(0): rsl(xhr);
            }
          };
          xhr.send();

        }).then(function(xhr) { // incomingMessage

          cb.call(xhr, NULL, {
            headers: xhr.headers,
            statusCode: xhr.status
          });
          cb = Function();
          // closeSocket();

        })['catch'](function(e) {

          cb.call(xhr, e);
          cb = Function();
          // closeSocket();

        });

      } else {

        // Use DNS module, simply.
        return new Promise(function(rsl, rej) {
          console.warn('Domain lookup is not supported on browser.');
          rej();
        });

      }
    }

  }

  /**
   * 
   */
  function serverInstall() {

    var util = require('util');
    var url = require('url');
    var cp = require('child_process');

    if(typeof module != 'undefined') {
      module.exports = DNS;
      DNS.lookup = lookup;
      DNS.lookupByCp = lookupByCp;
      DNS.pingByCp = pingByCp;
    }

    var HttpsProxyAgent;
    var proxy, createProxyAgent = function() {
      if(!HttpsProxyAgent || !proxy) {
        return;
      }
      var proxy_opts = url.parse(proxy);
      proxy_opts.secureEndpoint = TRUE;
      return new HttpsProxyAgent(proxy_opts);
    };
    try {
      proxy = process.env.http_proxy;
      HttpsProxyAgent = require('https-proxy-agent');
    } catch(e) {
      util.log('[dns.js] Proxy is not supported on this version.');
    }

    function DNS() {
    }

    /**
     * Dual support "http.get" and "dns.lookup"
     */
    function lookup(host, options, cb) {
      if(typeof options == 'function') {
        cb = options, options = {};
      }
      if(options == NULL) {
        options = {};
      }
      var mtc = host.match(/^(https?):/);
      var req, opts = url.parse(host);
      if(mtc) {
        // Use http - https request for lookup.
        var socket;
        var closeSocket = function() {
          setImmediate(function() {
            if(socket == NULL || typeof socket.destroy != 'function') return;
            if(!socket.destroyed) socket.destroy();
          });
        };
        return new Promise(function(rsl, rej) {

          if(options.proxy) {
            proxy = options.proxy;
          }
          if(!(opts.agent = createProxyAgent())) {
            // DONNOT USE http.globalAgent
            opts.agent = FALSE;
          }
          if(options.timeout) {
            opts.timeout = options.timeout;
          }

          var timeout = options.timeout || 3000;
          setTimeout(function() {
            rej('HTTP lookup timeout. (' + timeout + 'ms)');
          }, timeout);
          req  = require(mtc[1]).get(opts, rsl).on('socket', function(s) {
            socket = s;
          }).on('error', rej);

        }).then(function(inc) { // incomingMessage

          cb.call(req, NULL, {
            headers: inc.headers,
            statusCode: inc.statusCode
          });
          cb = Function();
          closeSocket();

        })['catch'](function(e) {

          cb.call(req, e);
          cb = Function();
          closeSocket();

        });
      } else {
        // Use DNS module, simply.
        return new Promise(function(rsl, rej) {

          var timeout = options.timeout || 3000;
          setTimeout(function() {
            rej('DNS lookup timeout. (' + timeout + 'ms)');
          }, timeout);
          req = require('dns').lookup(host, function(er, rslt) {
            er ? rej(er): rsl(rslt);
          });

        }).then(function(rslt) {

          cb.call(req, NULL, rslt);
          cb = Function();

        })['catch'](function(e) {

          cb.call(req, e);
          cb = Function();

        });
      }
    }

    /**
     * 
     */
    function lookupByCp(host, opts, cb) {

      opts = opts || {};
      var rsl_l = opts.ok, rej_l = opts.ng, throwUnr = function(ext) {
        throw new Error('Unreachable host "' + host + '" (' + ext + ')');
      };

      var n = cp.fork(__dirname + '/dns.js', [], {
        env: {
          http_proxy: opts.proxy || String('')
        }
      // DONNOT USE "undefined" to be a string.
      });

      var er, rslt;
      n.on('message', function(data) {

        rslt = data.result || '';
        try {

          if(data.errmsg) {
            throw new Error(data.errmsg);
          }
          typeof rslt == 'object' ? httpj(): dnsj();

        } catch(e) {
          er = e;
        }
        cb(er, rslt);

      });
      n.send(host);

      function dnsj() {

        var adrs = [].concat(rslt).filter(function(adr) {
          return !!adr;
        });

        // If reject, throw error immediately
        if(rej_l) {
          if(Array.isArray(rej_l)) {
            rej_l = rej_l.map(unesc).join('|');
          }
          rej_r = new RegExp(rej_l);
          adrs.forEach(function(adr) {
            !rej_r.test(adr) || throwUnr('DNS.reject');
          });
        }

        // If resolve, filter-out the address
        if(rsl_l) {
          if(Array.isArray(rsl_l)) {
            rsl_l = rsl_l.map(unesc).join('|');
          }
          rsl_r = new RegExp(rsl_l);
          adrs = adrs.filter(function(adr) {
            return rsl_r.test(adr);
          });
        }

        if(!adrs.length) {
          throwUnr('DNS.0');
        }

      }

      function httpj() {

        var k, v, r;

        // Check the IncomingMessage key string. (e.g. headers)
        if(rej_l) for(k in rej_l) {
          v = getValue(k), r = rej_l[k];
          switch(typeof r) {

          case 'string':
            if(!new RegExp(r).test(v)) continue;
            throwUnr('HTTP.rej');

          default:
            // r:
            //  true  => should "NOT" exist
            //  false => should be exist
            if(!(v == null) === !r) continue;
            throwUnr('HTTP.rej');

          }
        } // <-- for(k in rej_l) { ... } <--

        if(rsl_l) for(k in rsl_l) {
          v = getValue(k), r = rsl_l[k];
          switch(typeof r) {

          case 'string':
            if(new RegExp(r).test(v)) continue;
            throwUnr('HTTP.rsl');

          default:
            // r:
            //  true  => should be exist
            //  false => should "NOT" exist
            if(!(v == null) === r) continue;
            throwUnr('HTTP.rsl');

          }
        } // <-- for(k in rsl_l) { ... } <--

      }

      function unesc() {
        return t.replace(/\./, '\\.');
      }

      function getValue(k) {
        var v = rslt;
        k.split('.').forEach(function(ch_k) {
          if(v == null) return;
          v = v[ch_k];
        });
        return v;
      }

    }

    /**
     * 
     */
    function pingByCp(host, cb) {
      require('child_process').exec('ping ' + host, {
        timeout: 1500
      }, function(er, sto, ste) {
        var resl = (sto || '').split('\n').filter(function(t) {
          return t.indexOf('time=') != -1;
        });
        cb(resl.length > 1 ? null: ste ? new Error(ste): er);
      });
    }

    if(typeof process.send != 'function') {
      return;
    }

    // child_process mode.
    process.on('message', function(host) {
      lookup(host, function(er, rslt) {

        process.send({
          errmsg: (er || '').message,
          result: rslt
        });
        setTimeout(function() {
          process.exit();
        }, 80);

      });
    });

  }

}).call(this, typeof window != "undefined", typeof module != "undefined")
