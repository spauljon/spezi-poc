## To generate a keycloak jwt (10-minute duration)

```javascript
const r = await fetch('/realms/poc/protocol/openid-connect/token', {
  method: 'POST',
  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({grant_type: 'password', client_id: 'poc-devtest',
                             username: 'capture-user', password: prompt('capture-user password')})});
const body = await r.json();
console.log(r.status, body.error ?? 'ok');
window.token = body.access_token;
console.log(window.token);
```
