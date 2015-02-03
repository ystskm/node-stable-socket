# stable-socket
  
[![Version](https://badge.fury.io/js/stable-socket.png)](https://npmjs.org/package/stable-socket)
[![Build status](https://travis-ci.org/ystskm/stable-socket-js.png)](https://travis-ci.org/ystskm/stable-socket-js)  
  

## Install

Install with [npm](http://npmjs.org/):

    npm install stable-socket
    
## API - Set functions by args

```js
    var socket = new StableSocket(require('websockets').WebSocket, 
      ['http://localhost:8000/', 'http://localhost:8001/']
      {});
    socket.onopen = function() { console.log('Socket opened!') };
    // => 'Socket opened!'
```

### also use on browser

```html
<script type="text/javascript" src="StableSocket.js"></script>
<script type="text/javascript">

    var socket = new StableSocket(WebSocket, 
      ['http://localhost:8000/', 'http://localhost:8001/']
      {});
    socket.onopen = function() { console.log('Socket opened!') };
    // => 'Socket opened!'

</script>
```
