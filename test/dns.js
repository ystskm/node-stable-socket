/***/
// Testing for the DNS.lookup result
// node ./test/dns.js 5000 http://google.com/
var path = require('path');
var DNS = require(path.resolve('./lib/dns.js'));

var intv = process.argv[2];
var host = process.argv[3], proxy = process.argv[4]
console.log('[Stable Socket] DNS test starting with interval: ' + intv);
console.log('  host:' + host + ', proxy:' + proxy);

setInterval(function() {
  var n = Date.now();
  DNS.lookup(host, {
    proxy: proxy
  }, function(e, r) {

    var rap = Date.now() - n;
    console.log('[Stable Socket] DNS test response: ' + rap + ' ms');
    console.log('error:', e);
    console.log('resut:', r);

  });
}, intv);
