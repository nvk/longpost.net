/***************************************************
 * Global variables
 ***************************************************/
let pubkey = null;           // User's pubkey once connected
let currentSlug = null;      // Slug (d-tag) used for the current post
let userRelays = {};         // Relay definitions from extension (URL -> {read: bool, write: bool})
let relayConnections = {};   // WebSocket connections to each relay URL

// We'll store the current "prepared" event in memory before signing.
let preparedEvent = null;    // The raw event (unsigned) that we display in the JSON modal

/***************************************************
 * Utility: generate random slug
 ***************************************************/
function generateRandomSlug() {
  return "post-" + Math.random().toString(36).substring(2, 10);
}

/***************************************************
 * Connect with NIP-07
 *  - getPublicKey()
 *  - getRelays() if available
 ***************************************************/
document.getElementById("connect-nostr-btn").onclick = async function () {
  if (!window.nostr) {
    alert("NIP-07 extension not found. Please install Alby or another wallet extension.");
    return;
  }
  try {
    // 1) Get public key
    pubkey = await window.nostr.getPublicKey();
    document.getElementById("pubkey-label").innerText = "Connected: " + pubkey;

    // 2) Get user relays (if extension supports it)
    if (typeof window.nostr.getRelays === "function") {
      userRelays = await window.nostr.getRelays();
      console.log("User's published relays:", userRelays);
      connectToUserRelays();
    } else {
      alert("This extension does not support getRelays(). No custom relays fetched.");
      // Optionally define a fallback if you want:
      // userRelays = {
      //   "wss://relay.damus.io": { read: true, write: true },
      // };
      // connectToUserRelays();
    }
  } catch (err) {
    console.error(err);
    alert("Failed to retrieve pubkey or relays. Check console logs.");
  }
};

/***************************************************
 * Connect to each user relay (with read/write)
 ***************************************************/
function connectToUserRelays() {
  Object.entries(userRelays).forEach(([url, policy]) => {
    // Only connect if at least read or write is true
    if (!policy.read && !policy.write) return;

    // Create WebSocket for this relay
    const ws = new WebSocket(url);
    ws.onopen = () => {
      console.log("Connected to relay:", url);
    };
    ws.onerror = (err) => {
      console.error("Relay error:", url, err);
    };
    ws.onclose = () => {
      console.log("Relay closed:", url);
    };

    // Store connection info
    relayConnections[url] = {
      ws,
      policy,
      isOpen: false
    };

    // Track open/closed state
    ws.addEventListener("open", () => {
      relayConnections[url].isOpen = true;
    });
    ws.addEventListener("close", () => {
      relayConnections[url].isOpen = false;
    });
  });
}

/***************************************************
 * Markdown Preview
 ***************************************************/
function previewMarkdown() {
  const mdText = document.getElementById("markdown-input").value;
  const previewArea = document.getElementById("preview-area");
  previewArea.innerHTML = marked.parse(mdText);
}

/***************************************************
 * Step 1: Prepare the event object (un-signed)
 *         Then show the Raw JSON modal for confirmation
 ***************************************************/
function prepareNote(isEdit) {
  if (!pubkey) {
    alert("Please connect with Nostr first.");
    return;
  }

  const markdownContent = document.getElementById("markdown-input").value.trim();
  if (!markdownContent) {
    alert("No markdown content to publish.");
    return;
  }

  // Use or generate slug
  let slugInput = document.getElementById("slug-input").value.trim();
  if (isEdit && currentSlug) {
    slugInput = currentSlug;
  }
  if (!slugInput) {
    slugInput = generateRandomSlug();
  }
  currentSlug = slugInput;

  // Create the raw event (un-signed)
  const now = Math.floor(Date.now() / 1000);
  preparedEvent = {
    kind: 30023, // NIP-23 Long-form note
    pubkey: pubkey,
    created_at: now,
    tags: [
      // 'd' tag for parameterized replaceable events
      ["d", slugInput],
    ],
    content: markdownContent
  };

  // Show JSON in modal
  const jsonPreviewEl = document.getElementById("jsonPreview");
  jsonPreviewEl.textContent = JSON.stringify(preparedEvent, null, 2);

  // Show the modal (Bootstrap 5)
  const modalEl = document.getElementById('jsonModal');
  const bsModal = new bootstrap.Modal(modalEl, {
    keyboard: false
  });
  bsModal.show();

  // Attach event listener to confirm button
  const confirmBtn = document.getElementById('confirmPublishBtn');
  // Remove old listeners to avoid stacking
  confirmBtn.replaceWith(confirmBtn.cloneNode(true));
  // Re-select the new confirm button
  const newConfirmBtn = document.getElementById('confirmPublishBtn');
  newConfirmBtn.addEventListener('click', () => {
    bsModal.hide();
    publishNote(); // proceed to sign & send
  });
}

/***************************************************
 * Step 2: Confirm & Publish (Sign event, then broadcast)
 ***************************************************/
async function publishNote() {
  if (!preparedEvent) {
    alert("No prepared event found. Please try again.");
    return;
  }

  // Sign the event
  let signedEvent;
  try {
    signedEvent = await window.nostr.signEvent(preparedEvent);
  } catch (err) {
    console.error("Failed to sign event:", err);
    alert("Could not sign the event. Check console logs.");
    return;
  }

  // Replace preparedEvent with the signed version
  signedEvent.id = signedEvent.id;
  signedEvent.sig = signedEvent.sig;

  // Broadcast to all open relays with write permission
  let publishedCount = 0;
  Object.entries(relayConnections).forEach(([url, conn]) => {
    if (conn.isOpen && conn.policy.write) {
      conn.ws.send(JSON.stringify(["EVENT", signedEvent]));
      publishedCount++;
    }
  });

  if (publishedCount > 0) {
    document.getElementById("info-area").innerHTML = `
      <div class="alert alert-success mt-3">
        <strong>Event published to ${publishedCount} relays!</strong><br/>
        Event ID: <code>${signedEvent.id}</code><br/>
        Slug (d-tag): <code>${getSlugFromEvent(signedEvent)}</code>
      </div>
    `;
    // Show the edit button now that we've published at least once
    document.getElementById("edit-btn").classList.remove("hidden");
  } else {
    document.getElementById("info-area").innerHTML = `
      <div class="alert alert-danger mt-3">
        No open relays with write permission found. Event not sent.
      </div>
    `;
  }
}

/***************************************************
 * Helper to grab the 'd' tag from the event (if any)
 ***************************************************/
function getSlugFromEvent(ev) {
  const dTag = ev.tags.find(tag => tag[0] === 'd');
  return dTag ? dTag[1] : '';
}
