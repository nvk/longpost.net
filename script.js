/***************************************************************
 * Global Variables & Fallback Relays
 ***************************************************************/
let pubkey = null; // User's pubkey from NIP-07
let currentSlug = null; // For re-publishing
let userRelays = {}; // Relay definitions from extension (URL -> {read: bool, write: bool})
let relayConnections = {}; // WebSocket connections: {url: {ws, policy: {read, write}, isOpen: boolean}}
let outbox = []; // Local outbox array (loaded from localStorage)

const FALLBACK_RELAYS = {
  "wss://relay.damus.io": { read: true, write: true },
  "wss://relay.snort.social": { read: true, write: true }
};

/***************************************************************
 * On Page Load: Load outbox from localStorage
 ***************************************************************/
document.addEventListener("DOMContentLoaded", () => {
  loadOutbox();
});

/***************************************************************
 * Utility: Generate Random Slug
 ***************************************************************/
function generateRandomSlug() {
  return "post-" + Math.random().toString(36).substring(2, 10);
}

/***************************************************************
 * Connect with NIP-07: Get Public Key & Relays
 ***************************************************************/
document.getElementById("connect-nostr-btn").onclick = async function () {
  if (!window.nostr) {
    alert("NIP-07 extension not found. Please install Alby or another wallet extension.");
    return;
  }
  try {
    pubkey = await window.nostr.getPublicKey();
    document.getElementById("pubkey-label").innerText = "Connected: " + pubkey;
    
    if (typeof window.nostr.getRelays === "function") {
      userRelays = await window.nostr.getRelays();
      console.log("User's published relays:", userRelays);
      connectToUserRelays();
    } else {
      alert("This extension does not support getRelays(). No custom relays fetched.");
      // Optionally, set userRelays to an empty object and rely on fallback:
      userRelays = {};
      connectToUserRelays();
    }
  } catch (err) {
    console.error(err);
    alert("Failed to retrieve pubkey or relays. Check console logs.");
  }
};

/***************************************************************
 * Connect to Each User Relay (or Fallback)
 ***************************************************************/
function connectToUserRelays() {
  let finalRelays = {};
  if (Object.keys(userRelays).length === 0) {
    finalRelays = FALLBACK_RELAYS;
  } else {
    finalRelays = userRelays;
  }

  Object.entries(finalRelays).forEach(([url, policy]) => {
    if (!policy.read && !policy.write) return;

    const ws = new WebSocket(url);
    ws.onopen = () => {
      console.log("Connected to relay:", url);
      relayConnections[url].isOpen = true;
    };
    ws.onerror = (err) => {
      console.error("Relay error:", url, err);
    };
    ws.onclose = () => {
      console.log("Relay closed:", url);
      relayConnections[url].isOpen = false;
    };

    relayConnections[url] = {
      ws,
      policy,
      isOpen: false
    };
  });
}

/***************************************************************
 * Preview Markdown using marked.js
 ***************************************************************/
function previewMarkdown() {
  const mdText = document.getElementById("markdown-input").value;
  if (typeof marked !== "undefined") {
    document.getElementById("preview-area").innerHTML = marked.parse(mdText);
  } else {
    document.getElementById("preview-area").textContent = mdText;
  }
}

/***************************************************************
 * Prepare Note: Build Unsigned Event, Show JSON Modal
 ***************************************************************/
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
  let slugInput = document.getElementById("slug-input").value.trim();
  if (isEdit && currentSlug) {
    slugInput = currentSlug;
  }
  if (!slugInput) {
    slugInput = generateRandomSlug();
  }
  currentSlug = slugInput;
  const now = Math.floor(Date.now() / 1000);
  preparedEvent = {
    kind: 30023,
    pubkey,
    created_at: now,
    tags: [["d", slugInput]],
    content: markdownContent
  };
  document.getElementById("jsonPreview").textContent = JSON.stringify(preparedEvent, null, 2);
  
  const modalEl = document.getElementById('jsonModal');
  const bsModal = new bootstrap.Modal(modalEl, { keyboard: false });
  bsModal.show();
  
  const confirmBtn = document.getElementById('confirmPublishBtn');
  confirmBtn.replaceWith(confirmBtn.cloneNode(true));
  const newConfirmBtn = document.getElementById('confirmPublishBtn');
  newConfirmBtn.addEventListener('click', () => {
    bsModal.hide();
    publishNote();
  });
}

/***************************************************************
 * Publish Note: Sign & Broadcast Event via Raw WebSockets
 ***************************************************************/
async function publishNote() {
  if (!preparedEvent) {
    alert("No prepared event found. Please try again.");
    return;
  }
  let signedEvent;
  try {
    signedEvent = await window.nostr.signEvent(preparedEvent);
    preparedEvent.id = signedEvent.id;
    preparedEvent.sig = signedEvent.sig;
  } catch (err) {
    console.error("Failed to sign event:", err);
    alert("Could not sign the event. Check console logs.");
    return;
  }
  let publishedCount = 0;
  Object.entries(relayConnections).forEach(([url, conn]) => {
    if (conn.isOpen && conn.policy.write) {
      conn.ws.send(JSON.stringify(["EVENT", signedEvent]));
      publishedCount++;
    }
  });
  if (publishedCount > 0) {
    document.getElementById("info-area").innerHTML = `
      <div class="alert alert-success">
        <strong>Event published to ${publishedCount} relay(s)!</strong><br/>
        Event ID: <code>${signedEvent.id}</code><br/>
        Slug (d-tag): <code>${getSlugFromEvent(signedEvent)}</code>
      </div>
    `;
    document.getElementById("edit-btn").classList.remove("hidden");
  } else {
    document.getElementById("info-area").innerHTML = `
      <div class="alert alert-danger">
        No open relays with write permission found. Event not sent.
      </div>
    `;
  }
}

/***************************************************************
 * Helper: Get 'd' Tag from Event
 ***************************************************************/
function getSlugFromEvent(ev) {
  const dTag = ev.tags.find(tag => tag[0] === 'd');
  return dTag ? dTag[1] : '';
}

/***************************************************************
 * Outbox Functions: Load, Save, Save Draft, Render Outbox
 ***************************************************************/
function loadOutbox() {
  try {
    const raw = localStorage.getItem("nostrOutbox");
    outbox = raw ? JSON.parse(raw) : [];
  } catch(e) {
    console.error("Error parsing outbox from localStorage:", e);
    outbox = [];
  }
}
function saveOutbox() {
  localStorage.setItem("nostrOutbox", JSON.stringify(outbox));
}
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
    pubkey,
    created_at: now,
    tags: [["d", slugInput]],
    content: markdownContent
  };
  outbox.push(draftEvent);
  saveOutbox();
  document.getElementById("info-area").innerHTML = `
    <div class="alert alert-info">
      Draft saved to outbox with slug: <code>${slugInput}</code>
    </div>
  `;
}
document.getElementById("viewOutboxBtn").addEventListener("click", () => {
  renderOutbox();
  const modalEl = document.getElementById('outboxModal');
  const bsModal = new bootstrap.Modal(modalEl, { keyboard: false });
  bsModal.show();
});
function renderOutbox() {
  const tbody = document.getElementById("outboxTableBody");
  tbody.innerHTML = "";
  outbox.forEach((ev, index) => {
    const slug = getSlugFromEvent(ev);
    const snippet = ev.content.slice(0, 40).replace(/\n/g, " ") + (ev.content.length > 40 ? "..." : "");
    const created = new Date(ev.created_at * 1000).toLocaleString();
    let tr = document.createElement("tr");
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
function showOutboxJson(index) {
  const ev = outbox[index];
  alert(JSON.stringify(ev, null, 2));
}
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
  let signedEvent;
  try {
    signedEvent = await window.nostr.signEvent(ev);
  } catch (err) {
    console.error("Failed to sign outbox event:", err);
    alert("Could not sign the event. Check console logs.");
    return;
  }
  let publishedCount = 0;
  Object.entries(relayConnections).forEach(([url, conn]) => {
    if (conn.isOpen && conn.policy.write) {
      conn.ws.send(JSON.stringify(["EVENT", signedEvent]));
      publishedCount++;
    }
  });
  if (publishedCount > 0) {
    alert(`Event published to ${publishedCount} relay(s)!\n\nEvent ID: ${signedEvent.id}`);
  } else {
    alert("No open relays with write permission found. Event not sent.");
  }
}
function removeOutboxEvent(index) {
  if (!confirm("Are you sure you want to delete this draft?")) return;
  outbox.splice(index, 1);
  saveOutbox();
  renderOutbox();
}

/***************************************************************
 * Check Existing by d-tag using raw REQ subscription
 ***************************************************************/
function checkExistingSlug() {
  if (!pubkey) {
    alert("Please connect with Nostr first.");
    return;
  }
  let slug = document.getElementById("slug-input").value.trim();
  if (!slug) {
    alert("Please enter a slug to check.");
    return;
  }
  let readRelays = Object.entries(relayConnections).filter(
    ([url, conn]) => conn.isOpen && conn.policy.read
  );
  if (readRelays.length === 0) {
    alert("No open relays with read permission. Cannot check existing slug.");
    return;
  }
  let foundEvent = null;
  let bestCreated = 0;
  let subId = "checkslug-" + Math.random().toString(36).slice(2);
  let eoseCount = 0;
  let eoseTarget = readRelays.length;

  function handleMessage(e) {
    try {
      let data = JSON.parse(e.data);
      if (!Array.isArray(data)) return;
      let [type, thisSubId, payload] = data;
      if (thisSubId !== subId) return;
      if (type === "EVENT") {
        let ev = payload;
        if (ev.created_at && ev.created_at > bestCreated) {
          bestCreated = ev.created_at;
          foundEvent = ev;
        }
      } else if (type === "EOSE") {
        eoseCount++;
        if (eoseCount >= eoseTarget) {
          finalizeCheck();
        }
      }
    } catch (err) {
      console.error("Error in checkExistingSlug:", err);
    }
  }

  function finalizeCheck() {
    readRelays.forEach(([url, conn]) => {
      conn.ws.removeEventListener("message", handleMessage);
      conn.ws.send(JSON.stringify(["CLOSE", subId]));
    });
    if (foundEvent) {
      document.getElementById("info-area").innerHTML = `
        <div class="alert alert-info">
          Found event for slug <strong>${slug}</strong> from pubkey <strong>${foundEvent.pubkey}</strong>.<br/>
          Pre-filling with its content.
        </div>
      `;
      document.getElementById("markdown-input").value = foundEvent.content;
    } else {
      document.getElementById("info-area").innerHTML = `
        <div class="alert alert-warning">
          No event found for slug <strong>${slug}</strong>.
        </div>
      `;
    }
  }

  readRelays.forEach(([url, conn]) => {
    conn.ws.addEventListener("message", handleMessage);
    let filter = {
      kinds: [30023],
      "#d": [slug],
      limit: 1
    };
    conn.ws.send(JSON.stringify(["REQ", subId, filter]));
  });
}
