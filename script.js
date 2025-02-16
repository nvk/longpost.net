/***************************************************
 * Global variables
 ***************************************************/
let pubkey = null;           // User's pubkey once connected
let currentSlug = null;      // Slug (d-tag) used for the current post
let userRelays = {};         // Relay definitions from extension (URL -> {read: bool, write: bool})
let relayConnections = {};   // WebSocket connections to each relay URL

// We'll store the current "prepared" event in memory before signing.
let preparedEvent = null;    // The raw event (unsigned) that we display in the JSON modal

// Outbox array (loaded from localStorage)
let outbox = [];

/***************************************************
 * On page load: load outbox from localStorage
 ***************************************************/
document.addEventListener("DOMContentLoaded", () => {
  loadOutbox();
});

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
  document.getElementById("jsonPreview").textContent = JSON.stringify(preparedEvent, null, 2);

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

/***************************************************
 * Outbox: load from localStorage
 ***************************************************/
function loadOutbox() {
  try {
    const raw = localStorage.getItem("nostrOutbox");
    outbox = raw ? JSON.parse(raw) : [];
  } catch(e) {
    console.error("Error parsing outbox from localStorage:", e);
    outbox = [];
  }
}

/***************************************************
 * Outbox: save to localStorage
 ***************************************************/
function saveOutbox() {
  localStorage.setItem("nostrOutbox", JSON.stringify(outbox));
}

/***************************************************
 * "Save to Outbox" button:
 *   Build an event object (WITHOUT signing), store it in outbox
 ***************************************************/
function saveDraftToOutbox() {
  if (!pubkey) {
    alert("Please connect with Nostr first.");
    return;
  }
  const markdownContent = document.getElementById("markdown-input").value.trim();
  if (!markdownContent) {
    alert("No markdown content to save.");
    return;
  }

  let slugInput = document.getElementById("slug-input").value.trim();
  if (!slugInput) {
    slugInput = generateRandomSlug();
  }
  currentSlug = slugInput;

  const now = Math.floor(Date.now() / 1000);
  const draftEvent = {
    kind: 30023,
    pubkey: pubkey,
    created_at: now,
    tags: [ ["d", slugInput] ],
    content: markdownContent
  };

  // Add to outbox array
  outbox.push(draftEvent);
  saveOutbox();

  document.getElementById("info-area").innerHTML = `
    <div class="alert alert-info mt-3">
      Draft saved to outbox with slug: <code>${slugInput}</code>
    </div>
  `;
}

/***************************************************
 * Show outbox modal
 ***************************************************/
document.getElementById("viewOutboxBtn").addEventListener("click", () => {
  renderOutbox();
  const modalEl = document.getElementById('outboxModal');
  const bsModal = new bootstrap.Modal(modalEl, { keyboard: false });
  bsModal.show();
});

/***************************************************
 * Render outbox in the table
 ***************************************************/
function renderOutbox() {
  const tbody = document.getElementById("outboxTableBody");
  tbody.innerHTML = "";
  outbox.forEach((ev, index) => {
    const slug = getSlugFromEvent(ev);
    const snippet = ev.content.slice(0, 40).replace(/\n/g, " ") + (ev.content.length > 40 ? "..." : "");
    const created = new Date(ev.created_at * 1000).toLocaleString();

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${slug}</td>
      <td>${snippet}</td>
      <td>${created}</td>
      <td class="text-center">
        <button class="btn btn-sm btn-primary me-2" onclick="showOutboxJson(${index})">
          <i class="fa fa-eye"></i> JSON
        </button>
        <button class="btn btn-sm btn-success me-2" onclick="publishOutboxEvent(${index})">
          <i class="fa fa-upload"></i> Sign & Publish
        </button>
        <button class="btn btn-sm btn-danger" onclick="removeOutboxEvent(${index})">
          <i class="fa fa-trash"></i> Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/***************************************************
 * Show raw JSON in an alert or modal
 ***************************************************/
function showOutboxJson(index) {
  const ev = outbox[index];
  alert(JSON.stringify(ev, null, 2));
  // You could also open another modal for pretty display if desired.
}

/***************************************************
 * Sign & publish an outbox event
 *  - same flow as publishNote(), but using the draft
 ***************************************************/
async function publishOutboxEvent(index) {
  const ev = outbox[index];
  if (!pubkey) {
    alert("Please connect with Nostr first.");
    return;
  }
  if (ev.pubkey !== pubkey) {
    alert("This draft belongs to a different pubkey. Cannot sign.");
    return;
  }

  // Sign
  let signedEvent;
  try {
    signedEvent = await window.nostr.signEvent(ev);
  } catch (err) {
    console.error("Failed to sign outbox event:", err);
    alert("Could not sign the event. Check console logs.");
    return;
  }

  // Broadcast
  let publishedCount = 0;
  Object.entries(relayConnections).forEach(([url, conn]) => {
    if (conn.isOpen && conn.policy.write) {
      conn.ws.send(JSON.stringify(["EVENT", signedEvent]));
      publishedCount++;
    }
  });

  if (publishedCount > 0) {
    alert(`Event published to ${publishedCount} relays!\n\nEvent ID: ${signedEvent.id}`);
  } else {
    alert("No open relays with write permission found. Event not sent.");
  }
}

/***************************************************
 * Remove a draft from outbox
 ***************************************************/
function removeOutboxEvent(index) {
  if (!confirm("Are you sure you want to delete this draft?")) return;
  outbox.splice(index, 1);
  saveOutbox();
  renderOutbox();
}
