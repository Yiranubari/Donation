const BLINK_GRAPHQL_URL = "https://api.blink.sv/graphql";
const POLL_INTERVAL_MS = 3000;

const donateButton = document.getElementById("donateButton");
const copyButton = document.getElementById("copyButton");
const blinkUsernameInput = document.getElementById("blinkUsername");
const amountSatsInput = document.getElementById("amountSats");
const paymentRequestInput = document.getElementById("paymentRequest");
const status = document.getElementById("status");
const invoiceQr = document.getElementById("invoiceQr");
const paymentState = document.getElementById("paymentState");
const donationCard = document.getElementById("donationCard");

let qrCode = null;
let pollTimer = null;
let activePaymentRequest = null;

async function blinkGraphQL(query, variables) {
  const response = await fetch(BLINK_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Blink API HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }

  return payload.data;
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
  if (!result) {
    throw new Error("No invoice response from Blink API.");
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }

  return result.invoice?.paymentRequest;
}

function normalizeBlinkUsername(value) {
  const raw = value.trim();
  if (!raw) return "";
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

function renderInvoiceQr(paymentRequest) {
  invoiceQr.innerHTML = "";

  if (!window.QRCode) {
    throw new Error("QR library not loaded.");
  }

  qrCode = new window.QRCode(invoiceQr, {
    text: `lightning:${paymentRequest}`,
    width: 220,
    height: 220,
    colorDark: "#ecf2ff",
    colorLight: "#0d1529",
    correctLevel: window.QRCode.CorrectLevel.M,
  });

  return qrCode;
}

function clearInvoiceQr() {
  invoiceQr.innerHTML =
    '<p class="qr-placeholder">Generate an invoice to show QR</p>';
  invoiceQr.classList.remove("paid", "expired");
}

function setPaymentState(state) {
  paymentState.textContent = `Status: ${state}`;
}

function stopPaymentStatusPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function setStatusMessage(message, kind = "neutral") {
  status.textContent = message;
  status.classList.remove("ok", "error");
  if (kind === "ok") status.classList.add("ok");
  if (kind === "error") status.classList.add("error");
}

async function getInvoicePaymentStatus(paymentRequest) {
  const query = `
    query InvoiceStatus($input: LnInvoicePaymentStatusByPaymentRequestInput!) {
      lnInvoicePaymentStatusByPaymentRequest(input: $input) {
        status
        errors {
          code
          message
        }
      }
    }
  `;

  const data = await blinkGraphQL(query, { input: { paymentRequest } });
  const result = data?.lnInvoicePaymentStatusByPaymentRequest;
  if (!result) {
    throw new Error("No payment status response from Blink API.");
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }

  return result.status;
}

async function checkAndHandlePaymentStatus(paymentRequest) {
  const currentStatus = await getInvoicePaymentStatus(paymentRequest);
  if (!currentStatus) return;

  setPaymentState(currentStatus);

  if (currentStatus === "PAID") {
    stopPaymentStatusPolling();
    invoiceQr.classList.remove("expired");
    invoiceQr.classList.add("paid");
    donationCard.classList.add("paid");
    setStatusMessage("Payment received. Thank you!", "ok");
    return;
  }

  if (currentStatus === "EXPIRED") {
    stopPaymentStatusPolling();
    invoiceQr.classList.remove("paid");
    invoiceQr.classList.add("expired");
    donationCard.classList.remove("paid");
    setStatusMessage("Invoice expired. Generate a new invoice.", "error");
    return;
  }

  invoiceQr.classList.remove("paid", "expired");
  donationCard.classList.remove("paid");
  setStatusMessage("Waiting for payment...", "neutral");
}

function startPaymentStatusPolling(paymentRequest) {
  stopPaymentStatusPolling();
  activePaymentRequest = paymentRequest;
  setPaymentState("PENDING");

  checkAndHandlePaymentStatus(paymentRequest).catch((error) => {
    setStatusMessage(`Status check failed: ${error.message}`, "error");
  });

  pollTimer = window.setInterval(async () => {
    try {
      if (!activePaymentRequest || activePaymentRequest !== paymentRequest) {
        stopPaymentStatusPolling();
        return;
      }
      await checkAndHandlePaymentStatus(paymentRequest);
    } catch (error) {
      stopPaymentStatusPolling();
      setStatusMessage(`Status check failed: ${error.message}`, "error");
    }
  }, POLL_INTERVAL_MS);
}

donateButton.addEventListener("click", async () => {
  const username = normalizeBlinkUsername(blinkUsernameInput.value);
  const amount = Number.parseInt(amountSatsInput.value, 10);

  if (!username) {
    status.textContent = "Enter a Blink username.";
    status.classList.remove("ok");
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    status.textContent = "Enter a valid amount in sats.";
    status.classList.remove("ok");
    return;
  }

  donateButton.disabled = true;
  donateButton.textContent = "Generating...";
  stopPaymentStatusPolling();
  activePaymentRequest = null;
  paymentRequestInput.value = "";
  clearInvoiceQr();
  donationCard.classList.remove("paid");
  setPaymentState("—");
  setStatusMessage("Getting recipient wallet...");

  try {
    const recipientWalletId = await getRecipientWalletId(username);
    if (!recipientWalletId) {
      throw new Error("Recipient wallet not found.");
    }

    setStatusMessage("Creating invoice...");
    const paymentRequest = await createInvoiceOnBehalfOfRecipient(
      recipientWalletId,
      amount,
    );

    if (!paymentRequest) {
      throw new Error("Invoice was created without paymentRequest.");
    }

    paymentRequestInput.value = paymentRequest;
    renderInvoiceQr(paymentRequest);
    setStatusMessage(
      "Invoice generated. Polling payment status every 3 seconds.",
    );
    startPaymentStatusPolling(paymentRequest);
  } catch (error) {
    setStatusMessage(`Invoice generation failed: ${error.message}`, "error");
    setPaymentState("—");
    clearInvoiceQr();
  } finally {
    donateButton.disabled = false;
    donateButton.textContent = "Generate Lightning Invoice";
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
    setStatusMessage("Copied payment request.", "ok");
  } catch {
    setStatusMessage(
      "Could not copy automatically. Please copy manually.",
      "error",
    );
  }
});

clearInvoiceQr();
