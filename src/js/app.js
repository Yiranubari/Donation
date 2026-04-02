const BLINK_GRAPHQL_URL = "https://api.blink.sv/graphql";
const POLL_INTERVAL_MS = 3000;
const INVOICE_EXPIRES_MINUTES = 10;
const CREATE_COOLDOWN_MS = 8000;
const HISTORY_KEY = "blinkDonationHistory";
const HISTORY_LIMIT = 10;

const donateButton = document.getElementById("donateButton");
const regenerateButton = document.getElementById("regenerateButton");
const copyButton = document.getElementById("copyButton");
const shareLinkButton = document.getElementById("shareLinkButton");
const viewQrButton = document.getElementById("viewQrButton");
const downloadQrButton = document.getElementById("downloadQrButton");
const closeQrModalButton = document.getElementById("closeQrModalButton");
const updateUsernameButton = document.getElementById("updateUsernameButton");
const blinkUsernameInput = document.getElementById("blinkUsername");
const recipientUsername = document.getElementById("recipientUsername");
const amountSatsInput = document.getElementById("amountSats");
const paymentRequestInput = document.getElementById("paymentRequest");
const status = document.getElementById("status");
const invoiceQr = document.getElementById("invoiceQr");
const invoiceQrLarge = document.getElementById("invoiceQrLarge");
const qrModal = document.getElementById("qrModal");
const paymentState = document.getElementById("paymentState");
const invoiceCountdown = document.getElementById("invoiceCountdown");
const paymentHash = document.getElementById("paymentHash");
const paidAt = document.getElementById("paidAt");
const historyList = document.getElementById("historyList");
const donationCard = document.getElementById("donationCard");

let pollTimer = null;
let countdownTimer = null;
let cooldownTimer = null;
let activePaymentRequest = null;
let activePollToken = 0;
let invoiceExpiresAt = null;
let currentUsername = "";
let lastKnownInvoiceStatus = "";
let lastInvoiceAmount = 21;
let lastCreateAt = 0;
let currentInvoiceHash = "";

async function blinkGraphQL(query, variables) {
  const response = await fetch(BLINK_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) throw new Error(`Blink API HTTP ${response.status}`);

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }

  return payload.data;
}

function normalizeBlinkUsername(value) {
  const raw = value.trim();
  if (!raw) return "";
  const stripped = raw.includes("@") ? raw.split("@")[0] : raw;
  return stripped.toLowerCase();
}

function isValidUsername(username) {
  return /^[a-z0-9_]{3,50}$/.test(username);
}

function sanitizeAmount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 1 || parsed > 10000000) return null;
  return parsed;
}

function setStatusMessage(message, kind = "neutral") {
  status.textContent = message;
  status.classList.remove("ok", "error");
  if (kind === "ok") status.classList.add("ok");
  if (kind === "error") status.classList.add("error");
}

function setPaymentState(state) {
  paymentState.textContent = `Status: ${state}`;
}

function setCountdownText(value) {
  invoiceCountdown.textContent = `Expires in: ${value}`;
}

function updateDonateButtonText() {
  const amount = sanitizeAmount(amountSatsInput.value);
  donateButton.textContent = amount ? `Donate ${amount} sats` : "Donate";
}

function clearVisualStatus() {
  donationCard.classList.remove("paid", "expired");
  invoiceQr.classList.remove("paid", "expired");
}

function clearInvoiceQr() {
  invoiceQr.innerHTML =
    '<p class="qr-placeholder">QR appears after invoice generation</p>';
  clearVisualStatus();
}

function renderInvoiceQr(container, paymentRequest, size = 220) {
  container.innerHTML = "";
  if (!window.QRCode) throw new Error("QR library not loaded.");

  new window.QRCode(container, {
    text: `lightning:${paymentRequest}`,
    width: size,
    height: size,
    colorDark: "#111111",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function closeQrModal() {
  qrModal.classList.add("hidden");
  invoiceQrLarge.innerHTML = "";
}

function openQrModal() {
  const invoice = paymentRequestInput.value.trim();
  if (!invoice) {
    setStatusMessage("Generate an invoice first.", "error");
    return;
  }
  qrModal.classList.remove("hidden");
  renderInvoiceQr(invoiceQrLarge, invoice, 300);
}

function stopPaymentStatusPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function stopCountdown() {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function startCountdown() {
  stopCountdown();
  if (!invoiceExpiresAt) {
    setCountdownText("—");
    return;
  }

  const tick = () => {
    const remainingMs = invoiceExpiresAt - Date.now();
    if (remainingMs <= 0) {
      setCountdownText("00:00");
      stopCountdown();
      return;
    }

    const totalSec = Math.floor(remainingMs / 1000);
    const minutes = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const seconds = String(totalSec % 60).padStart(2, "0");
    setCountdownText(`${minutes}:${seconds}`);
  };

  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

function scheduleNextPoll(token) {
  if (!activePaymentRequest) return;
  pollTimer = window.setTimeout(() => {
    pollPaymentStatus(token).catch(() => {
      // handled in pollPaymentStatus
    });
  }, POLL_INTERVAL_MS);
}

function savePaidDonation(entry) {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    history.unshift(entry);
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(history.slice(0, HISTORY_LIMIT)),
    );
  } catch {
    // ignore storage failure
  }
}

function renderHistory() {
  historyList.innerHTML = "";
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    history = [];
  }

  if (history.length === 0) {
    historyList.innerHTML = "<li>No paid donations yet.</li>";
    return;
  }

  history.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${item.username} • ${item.amount} sats • ${new Date(item.paidAt).toLocaleString()} • ${item.paymentHash.slice(0, 14)}...`;
    historyList.appendChild(li);
  });
}

function updateUrlParams() {
  const username = normalizeBlinkUsername(blinkUsernameInput.value);
  const amount = sanitizeAmount(amountSatsInput.value);
  const url = new URL(window.location.href);

  if (username) {
    url.searchParams.set("u", username);
  } else {
    url.searchParams.delete("u");
  }

  if (amount) {
    url.searchParams.set("amt", String(amount));
  } else {
    url.searchParams.delete("amt");
  }

  window.history.replaceState({}, "", url);
}

function hydrateFromUrlParams() {
  const url = new URL(window.location.href);
  const u = normalizeBlinkUsername(url.searchParams.get("u") || "");
  const amt = sanitizeAmount(url.searchParams.get("amt") || "");

  if (u) {
    blinkUsernameInput.value = u;
    if (isValidUsername(u)) {
      currentUsername = u;
      recipientUsername.textContent = u;
    }
  }

  if (amt) {
    amountSatsInput.value = String(amt);
    lastInvoiceAmount = amt;
  }
}

function startCreateCooldown() {
  lastCreateAt = Date.now();
  if (cooldownTimer) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  const tick = () => {
    const remaining = CREATE_COOLDOWN_MS - (Date.now() - lastCreateAt);
    if (remaining <= 0) {
      donateButton.disabled = false;
      updateDonateButtonText();
      window.clearInterval(cooldownTimer);
      cooldownTimer = null;
      return;
    }

    donateButton.disabled = true;
    donateButton.textContent = `Please wait ${Math.ceil(remaining / 1000)}s`;
  };

  tick();
  cooldownTimer = window.setInterval(tick, 250);
}

function canCreateInvoiceNow() {
  return Date.now() - lastCreateAt >= CREATE_COOLDOWN_MS;
}

async function getRecipientWalletId(username) {
  const query = `
    query AccountDefaultWallet($username: Username!, $walletCurrency: WalletCurrency) {
      accountDefaultWallet(username: $username, walletCurrency: $walletCurrency) {
        id
      }
    }
  `;

  const data = await blinkGraphQL(query, {
    username,
    walletCurrency: "BTC",
  });

  return data?.accountDefaultWallet?.id;
}

async function createInvoiceOnBehalfOfRecipient(recipientWalletId, amount) {
  const mutation = `
    mutation CreateInvoiceOnBehalf($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
      lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
        invoice {
          paymentRequest
        }
        errors {
          code
          message
        }
      }
    }
  `;

  const data = await blinkGraphQL(mutation, {
    input: { recipientWalletId, amount, expiresIn: INVOICE_EXPIRES_MINUTES },
  });

  const result = data?.lnInvoiceCreateOnBehalfOfRecipient;
  if (!result) throw new Error("No invoice response from Blink API.");
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }

  return result.invoice?.paymentRequest;
}

async function getInvoicePaymentStatus(paymentRequest) {
  const query = `
    query InvoiceStatus($input: LnInvoicePaymentStatusByPaymentRequestInput!) {
      lnInvoicePaymentStatusByPaymentRequest(input: $input) {
        status
        paymentHash
      }
    }
  `;

  const data = await blinkGraphQL(query, { input: { paymentRequest } });
  const result = data?.lnInvoicePaymentStatusByPaymentRequest;

  if (!result) throw new Error("No payment status response from Blink API.");
  return result;
}

function setPaidDetails(hash, paidTimestamp) {
  currentInvoiceHash = hash || "";
  paymentHash.textContent = `Payment hash: ${hash || "—"}`;
  paidAt.textContent = `Paid at: ${paidTimestamp ? new Date(paidTimestamp).toLocaleString() : "—"}`;
}

async function pollPaymentStatus(token) {
  if (!activePaymentRequest || token !== activePollToken) return;

  try {
    const result = await getInvoicePaymentStatus(activePaymentRequest);
    if (!activePaymentRequest || token !== activePollToken) return;

    const currentStatus = result.status;
    if (!currentStatus) {
      scheduleNextPoll(token);
      return;
    }

    if (currentStatus !== lastKnownInvoiceStatus) {
      lastKnownInvoiceStatus = currentStatus;
      setPaymentState(currentStatus);
    }

    if (currentStatus === "PAID") {
      stopPaymentStatusPolling();
      stopCountdown();
      donationCard.classList.remove("expired");
      donationCard.classList.add("paid");
      invoiceQr.classList.remove("expired");
      invoiceQr.classList.add("paid");
      regenerateButton.classList.add("hidden");

      const paidTimestamp = Date.now();
      setPaidDetails(result.paymentHash, paidTimestamp);
      savePaidDonation({
        username: currentUsername,
        amount: lastInvoiceAmount,
        paymentHash: result.paymentHash || "",
        paidAt: paidTimestamp,
      });
      renderHistory();

      setStatusMessage("Payment received. Thank you!", "ok");
      activePaymentRequest = null;
      return;
    }

    if (currentStatus === "EXPIRED") {
      stopPaymentStatusPolling();
      stopCountdown();
      donationCard.classList.remove("paid");
      donationCard.classList.add("expired");
      invoiceQr.classList.remove("paid");
      invoiceQr.classList.add("expired");
      regenerateButton.classList.remove("hidden");
      setStatusMessage("Invoice expired. Click regenerate.", "error");
      activePaymentRequest = null;
      return;
    }

    clearVisualStatus();
    setStatusMessage("Waiting for payment...", "neutral");
    scheduleNextPoll(token);
  } catch (error) {
    setStatusMessage(
      `Status check failed. Retrying... (${error.message})`,
      "error",
    );
    scheduleNextPoll(token);
  }
}

async function createInvoiceFlow() {
  const username =
    currentUsername || normalizeBlinkUsername(blinkUsernameInput.value);
  const amount = sanitizeAmount(amountSatsInput.value);

  if (!username || !isValidUsername(username)) {
    setStatusMessage("Username must be 3-50 chars: a-z, 0-9, _.", "error");
    return;
  }

  if (!amount) {
    setStatusMessage(
      "Amount must be an integer from 1 to 10,000,000 sats.",
      "error",
    );
    return;
  }

  if (!canCreateInvoiceNow()) {
    setStatusMessage(
      "Please wait for cooldown before creating another invoice.",
      "error",
    );
    startCreateCooldown();
    return;
  }

  currentUsername = username;
  lastInvoiceAmount = amount;
  recipientUsername.textContent = username;
  updateUrlParams();

  donateButton.disabled = true;
  donateButton.textContent = "Creating invoice...";
  stopPaymentStatusPolling();
  stopCountdown();
  activePaymentRequest = null;
  lastKnownInvoiceStatus = "";
  activePollToken += 1;

  paymentRequestInput.value = "";
  setPaidDetails("", null);
  regenerateButton.classList.add("hidden");
  clearInvoiceQr();
  setPaymentState("PENDING");
  setStatusMessage("Getting recipient wallet...");

  try {
    const recipientWalletId = await getRecipientWalletId(username);
    if (!recipientWalletId) throw new Error("Recipient wallet not found.");

    setStatusMessage("Creating invoice...");
    const paymentRequest = await createInvoiceOnBehalfOfRecipient(
      recipientWalletId,
      amount,
    );
    if (!paymentRequest) throw new Error("Invoice missing paymentRequest.");

    paymentRequestInput.value = paymentRequest;
    renderInvoiceQr(invoiceQr, paymentRequest);
    activePaymentRequest = paymentRequest;
    invoiceExpiresAt = Date.now() + INVOICE_EXPIRES_MINUTES * 60 * 1000;
    startCountdown();

    setStatusMessage("Invoice created. Checking payment every 3 seconds.");
    const token = activePollToken;
    await pollPaymentStatus(token);
    startCreateCooldown();
  } catch (error) {
    setPaymentState("—");
    setStatusMessage(`Invoice generation failed: ${error.message}`, "error");
    donateButton.disabled = false;
    updateDonateButtonText();
  }
}

updateUsernameButton.addEventListener("click", () => {
  const username = normalizeBlinkUsername(blinkUsernameInput.value);
  if (!username || !isValidUsername(username)) {
    setStatusMessage("Username must be 3-50 chars: a-z, 0-9, _.", "error");
    return;
  }

  currentUsername = username;
  recipientUsername.textContent = username;
  updateUrlParams();
  setStatusMessage("Recipient updated.", "ok");
});

amountSatsInput.addEventListener("input", () => {
  updateDonateButtonText();
  updateUrlParams();
});

shareLinkButton.addEventListener("click", async () => {
  updateUrlParams();
  const shareUrl = window.location.href;
  try {
    await navigator.clipboard.writeText(shareUrl);
    setStatusMessage("Share link copied.", "ok");
  } catch {
    setStatusMessage("Could not copy share link.", "error");
  }
});

donateButton.addEventListener("click", async () => {
  await createInvoiceFlow();
});

regenerateButton.addEventListener("click", async () => {
  await createInvoiceFlow();
});

copyButton.addEventListener("click", async () => {
  const invoice = paymentRequestInput.value.trim();
  if (!invoice) {
    setStatusMessage("Generate an invoice first.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(invoice);
    setStatusMessage("Invoice copied.", "ok");
  } catch {
    setStatusMessage("Copy failed. Copy manually.", "error");
  }
});

viewQrButton.addEventListener("click", openQrModal);
invoiceQr.addEventListener("click", openQrModal);
closeQrModalButton.addEventListener("click", closeQrModal);
qrModal.addEventListener("click", (event) => {
  if (event.target === qrModal) closeQrModal();
});

downloadQrButton.addEventListener("click", () => {
  const canvas = invoiceQr.querySelector("canvas");
  const img = invoiceQr.querySelector("img");
  if (!canvas && !img) {
    setStatusMessage("Generate an invoice first.", "error");
    return;
  }

  const link = document.createElement("a");
  link.download = `invoice-${Date.now()}.png`;
  link.href = canvas ? canvas.toDataURL("image/png") : img.src;
  link.click();
  setStatusMessage("QR downloaded.", "ok");
});

hydrateFromUrlParams();
clearInvoiceQr();
setPaidDetails("", null);
setPaymentState("—");
setCountdownText("—");
updateDonateButtonText();
renderHistory();
