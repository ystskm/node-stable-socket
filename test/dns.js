/***/
// Testing for the DNS.lookup result
// node ./test/dns.js 5000 http://google.com/
var path = require('path');
var DNS = require(path.resolve('./lib/dns.js'));

var i_ofs = 2;
var l_ty = process.argv[i_ofs];
var l_fn;
switch(l_ty) {
case 'bycp':
  l_fn = 'lookupByCp';
  i_ofs = 3;
  break;
default:
  l_fn = 'lookup';
}

var intv = process.argv[0 + i_ofs];
var host = process.argv[1 + i_ofs], proxy = process.argv[2 + i_ofs];
console.log('[Stable Socket] DNS test starting with interval: ' + intv);
console.log('  type: ' + l_ty + ', host:' + host + ', proxy:' + proxy);

setInterval(function() {
  var n = Date.now();
  DNS[l_fn](host, {
    proxy: proxy
  }, function(e, r) {

    var rap = Date.now() - n;
    consoel.log(' - ' + new Date().toGMTString());
    console.log('[Stable Socket] DNS test response: ' + rap + ' ms');
    console.log('error (' + (typeof e) + '):', e);
    console.log('result(' + (typeof r) + '):', r);

  });
}, intv);
