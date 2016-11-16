/***/
var url = require('url');
var cp = require('child_process');
(function() {

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
    proxy_opts.secureEndpoint = true;
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
    if(options == null) {
      options = {};
    }
    var mtc = host.match(/^(https?):/);
    var opts = url.parse(host);
    if(mtc) { // http - https request lookup
      if(options.proxy) {
        proxy = options.proxy;
      }
      if(!(opts.agent = createProxyAgent())) {
        delete opts.agent;
      }
      try {
        require(mtc[1]).get(opts, function(inc) {

          cb(null, {
            headers: inc.headers,
            statusCode: inc.statusCode
          });

        }).on('error', cb);
      } catch(e) {
        cb(e);
      }
      return;
    }
    require('dns').lookup(host, cb);
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
      env: { http_proxy: opts.proxy }
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
      if(rej_l)
        for(k in rej_l) {
          v = getValue(k), r = rej_l[k];
          switch(typeof r) {

          case 'string':
            if(!new RegExp(r).test(v))
              continue;
            throwUnr('HTTP.rej');

          default:
            // r:
            //  true  => should "NOT" exist
            //  false => should be exist
            if(!(v == null) === !r)
              continue;
            throwUnr('HTTP.rej');

          }
        } // <-- for(k in rej_l) { ... } <--

      if(rsl_l)
        for(k in rsl_l) {
          v = getValue(k), r = rsl_l[k];
          switch(typeof r) {

          case 'string':
            if(new RegExp(r).test(v))
              continue;
            throwUnr('HTTP.rsl');

          default:
            // r:
            //  true  => should be exist
            //  false => should "NOT" exist
            if(!(v == null) === r)
              continue;
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
        if(v == null) return; v = v[ch_k];
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

})();
