# Vaani Remote Server

Apna private server + website: kahin se bhi browser kholo, Vaani phone ko text ya awaaz se control karo.

```
Browser (website)  <--HTTPS-->  ye server  <--HTTPS (phone khud juda rehta hai)-->  Vaani phone
```

Zero dependencies, sirf Node 18+. Koi database nahi (chat memory mein rehti hai, restart par saaf).

## Do secret chahiye (aap khud banao)
- `ADMIN_PASSWORD` — website login, kam se kam 8 akshar (lamba rakho)
- `DEVICE_TOKEN` — phone ka secret, kam se kam 16 akshar (random lamba text)

## Free hosting (sirf Android se ho jata hai)
### Option A: Render.com (sabse aasan)
1. Is poore Vaani project ko apne GitHub repo mein rakho (aapka `.github` build wala repo hi chalega).
2. render.com par GitHub se login -> New -> Web Service -> apna repo chuno.
3. Root Directory: `remote_server` · Runtime: Node · Build Command: khali · Start Command: `node server.js`
4. Environment mein `ADMIN_PASSWORD` aur `DEVICE_TOKEN` daalo.
5. Deploy ke baad URL milega, jaise `https://vaani-xxxx.onrender.com`.
Note: free plan par server idle hone par so sakta hai; phone har 25 second mein connect rehta hai, isliye aam taur par jaga rehta hai. Pehli request par kabhi 30-50 second lag sakte hain.

### Option B: Apna VPS / Oracle Cloud Free
`ADMIN_PASSWORD=... DEVICE_TOKEN=... PORT=8080 node server.js` chalao aur HTTPS ke liye Caddy ya Nginx ke peeche rakho. Ya Docker: `docker build -t vaani-remote . && docker run -p 8080:8080 -e ADMIN_PASSWORD=... -e DEVICE_TOKEN=... vaani-remote`.

## Phone mein
Vaani -> Settings -> REMOTE ACCESS:
- Server URL: `https://vaani-xxxx.onrender.com`
- Device token: wahi `DEVICE_TOKEN`
- SAVE dabao, phir Vaani 24h mode band karke dobara ON karo.
- Battery optimization Vaani ke liye OFF rakho, taaki phone sone par connection na tute.

Check: Vaani mein "brain status" bolo, "Remote access: juda hai" dikhna chahiye. Website par upar "Phone online" hara dikhega.

## Website
`https://<aapka-url>` kholo -> password -> chat box. Mic button bolkar bhejta hai (Chrome/Edge/Safari). "Awaaz" button jawab bolkar sunata hai. Risky kaam (payment, delete, send) par Vaani pehle poochhegi, aap "haan" bhejo.

## Security
- Session cookie HttpOnly + SameSite=Strict, galat password 5 baar par 15 minute block.
- Phone ka token alag hai; website ka password server par hi rehta hai.
- App sirf `https://` se connect karta hai (ghar ke LAN ke alawa).
- Website par login karne wala phone par wahi kaam kar sakta hai jo aap bol kar karwa sakte ho, isliye password mazboot rakho aur kisi ke saath share mat karo.
