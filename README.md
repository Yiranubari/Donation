# Lightning Donation Page (Blink API)

Static donation page using Blink no-auth invoice flow plus QR rendering.

## Project structure

- [index.html](index.html) — page markup
- [src/css/styles.css](src/css/styles.css) — styles
- [src/js/app.js](src/js/app.js) — Blink GraphQL + UI logic

## Blink no-key flow

1. `accountDefaultWallet(username, walletCurrency: BTC)`
2. `lnInvoiceCreateOnBehalfOfRecipient(input: { recipientWalletId, amount })`

## QR code library

Loaded from cdnjs (qrcodejs):

- `https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js`

## Run locally

Open [index.html](index.html) in a browser.

## Publish with GitHub Pages

1. Push this repository to GitHub.
2. In GitHub, open **Settings → Pages**.
3. Set **Source** to **Deploy from a branch**.
4. Choose branch `main` and folder `/ (root)`.
5. Save and wait for deployment.
