# Stub

Turn a ticket into a pass on your phone.

Drop in a boarding pass, a rail ticket or an event confirmation — a PDF, an
email, a photo of a barcode — and Stub reads it, works out what it is, and
builds a pass you can keep offline.

Everything happens in the browser. Nothing is uploaded, nothing is stored on a
server, and there is no server: the page works with the network switched off
once it has loaded.

## Use it

**<https://itstejaswi.github.io/stub/>**

## What it reads

- **Boarding passes** — the IATA BCBP barcode carried by every airline
- **Rail tickets** — including the UK's RSP barcode format
- **Events and everything else** — QR and Aztec codes, plus text on the page

It recognises the airline or operator where it can, and colours the pass to
match rather than shipping a wall of grey rectangles.

## Why it exists

Wallet apps want an account. Airline apps want an install, a login, and
permission to notify you about seat upgrades. A ticket is a barcode and a few
lines of text; none of that should be necessary to look at one on a phone.

## Running it locally

```bash
npm install
npm run dev      # http://localhost:8080
npm test
```

No build step. The dependencies are vendored, so the page is served as it
ships.

## Licence

Copyright (C) 2026 Tejaswi C.

Released under the [GNU AGPL v3](LICENSE). You may use, study, modify and share
it freely. If you run a modified version and let others use it over a network,
section 13 requires you to offer them your source as well — rehosting it
unchanged is welcome, rehosting it changed and silent is not.
