# mock-promise
  
[![Version](https://badge.fury.io/js/mock-promise.png)](https://npmjs.org/package/mock-promise)
[![Build status](https://travis-ci.org/ystskm/mock-promise-js.png)](https://travis-ci.org/ystskm/mock-promise-js)  
  

## Install

Install with [npm](http://npmjs.org/):

    npm install mock-promise
    
## API - Set functions by args

```js
    new Promise(function(res, rej) {
      res('x');
    }).chain(function() {
      return new Promise(function(res, rej) {
        res('y');
      });
    }).then(function(r) {
      console.log('All promise has done.(' + r + ')');
    }, function() {
      console.log('Something failed...');
    }); // => 'All promise has done.(y)'
```

### also use on browser

```html
<script type="text/javascript" src="MockPromise.js"></script>
<script type="text/javascript">

    new Promise(function(res, rej) {
      res('x');
    }).chain(function() {
      return new Promise(function(res, rej) {
        res('y');
      });
    }).then(function(r) {
      console.log('All promise has done.(' + r + ')');
    }, function() {
      console.log('Something failed...');
    }); // => 'All promise has done.(y)'

</script>
```

## if you want to inherit Emitter to another *class*, use prototype chain.

```js
    // for Factory
    var SubClass = function(){
      NoleakEmitter.call(this);
    }
    for(var i in NoleakEmitter.prototype)
      SubClass.prototype[i] = NoleakEmitter.prototype[i];

    // for Singleton (not recommended)
    var SubClass = function(){
      this.__proto__.__proto__ = new NoleakEmitter();
    }
```
