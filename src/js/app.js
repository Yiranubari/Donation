const BLINK_GRAPHQL_URL = "https://api.blink.sv/graphql";
const POLL_INTERVAL_MS = 3000;

const donateButton = document.getElementById("donateButton");
const copyButton = document.getElementById("copyButton");
const updateUsernameButton = document.getElementById("updateUsernameButton");
const blinkUsernameInput = document.getElementById("blinkUsername");
const recipientUsername = document.getElementById("recipientUsername");
const amountSatsInput = document.getElementById("amountSats");
const paymentRequestInput = document.getElementById("paymentRequest");
const status = document.getElementById("status");
const invoiceQr = document.getElementById("invoiceQr");
const paymentState = document.getElementById("paymentState");
const donationCard = document.getElementById("donationCard");

let pollTimer = null;
let activePaymentRequest = null;
let currentUsername = "";
let lastKnownInvoiceStatus = "";

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
  return raw.includes("@") ? raw.split("@")[0] : raw;
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

function updateDonateButtonText() {
  const amount = Number.parseInt(amountSatsInput.value, 10);
  donateButton.textContent =
    Number.isInteger(amount) && amount > 0 ? `Donate ${amount} sats` : "Donate";
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

function renderInvoiceQr(paymentRequest) {
  invoiceQr.innerHTML = "";
  if (!window.QRCode) throw new Error("QR library not loaded.");

  new window.QRCode(invoiceQr, {
    text: `lightning:${paymentRequest}`,
    width: 220,
    height: 220,
    colorDark: "#111111",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

function stopPaymentStatusPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll() {
  if (!activePaymentRequest) return;
  pollTimer = window.setTimeout(() => {
    pollPaymentStatus().catch(() => {
      // handled in pollPaymentStatus
    });
  }, POLL_INTERVAL_MS);
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
    input: { recipientWalletId, amount },
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
      }
    }
  `;

  const data = await blinkGraphQL(query, { input: { paymentRequest } });
  const result = data?.lnInvoicePaymentStatusByPaymentRequest;

  if (!result) throw new Error("No payment status response from Blink API.");

  return result.status;
}

async function pollPaymentStatus() {
  if (!activePaymentRequest) return;

  try {
    const currentStatus = await getInvoicePaymentStatus(activePaymentRequest);
    if (!activePaymentRequest) return;

    if (!currentStatus) {
      scheduleNextPoll();
      return;
    }

    if (currentStatus !== lastKnownInvoiceStatus) {
      lastKnownInvoiceStatus = currentStatus;
      setPaymentState(currentStatus);
    }

    if (currentStatus === "PAID") {
      stopPaymentStatusPolling();
      donationCard.classList.remove("expired");
      donationCard.classList.add("paid");
      invoiceQr.classList.remove("expired");
      invoiceQr.classList.add("paid");
      setStatusMessage("Payment received. Thank you!", "ok");
      activePaymentRequest = null;
      return;
    }

    if (currentStatus === "EXPIRED") {
      stopPaymentStatusPolling();
      donationCard.classList.remove("paid");
      donationCard.classList.add("expired");
      invoiceQr.classList.remove("paid");
      invoiceQr.classList.add("expired");
      setStatusMessage("Invoice expired. Generate a new one.", "error");
      activePaymentRequest = null;
      return;
    }

    clearVisualStatus();
    setStatusMessage("Waiting for payment...", "neutral");
    scheduleNextPoll();
  } catch (error) {
    setStatusMessage(
      `Status check failed. Retrying... (${error.message})`,
      "error",
    );
    scheduleNextPoll();
  }
}

updateUsernameButton.addEventListener("click", () => {
  const username = normalizeBlinkUsername(blinkUsernameInput.value);
  if (!username) {
    setStatusMessage("Enter a valid Blink username.", "error");
    return;
  }

  currentUsername = username;
  recipientUsername.textContent = username;
  setStatusMessage("Recipient updated.", "ok");
});

amountSatsInput.addEventListener("input", updateDonateButtonText);

donateButton.addEventListener("click", async () => {
  const username =
    currentUsername || normalizeBlinkUsername(blinkUsernameInput.value);
  const amount = Number.parseInt(amountSatsInput.value, 10);

  if (!username) {
    setStatusMessage("Set recipient username first.", "error");
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    setStatusMessage("Enter a valid sats amount.", "error");
    return;
  }

  currentUsername = username;
  recipientUsername.textContent = username;

  donateButton.disabled = true;
  donateButton.textContent = "Creating invoice...";
  stopPaymentStatusPolling();
  activePaymentRequest = null;
  lastKnownInvoiceStatus = "";
  paymentRequestInput.value = "";
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
    renderInvoiceQr(paymentRequest);
    activePaymentRequest = paymentRequest;
    setStatusMessage("Invoice created. Checking payment every 3 seconds.");
    await pollPaymentStatus();
  } catch (error) {
    setPaymentState("—");
    setStatusMessage(`Invoice generation failed: ${error.message}`, "error");
  } finally {
    donateButton.disabled = false;
    updateDonateButtonText();
  }
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

clearInvoiceQr();
setPaymentState("—");
updateDonateButtonText();
