// the drop: several photos and short videos at once. opened from the black below the hero, from the
// fallback guestbook, or by the camera's "from my phone" when more than one file is picked. one name and
// one note for all of them (any one can carry its own caption instead); each is shrunk, stripped and
// stamped here by uploads.js, then they go together through guestbook-api.js and wait for approval.
// open it from anywhere: window.dispatchEvent(new CustomEvent("kimaya:drop", { detail: { files } }))

(() => {
  const MAX = 12;
  const $ = (id) => document.getElementById(id);
  const drop = $("drop");
  if (!drop || !window.KimayaUploads || !window.KimayaGuestbook) return;

  const items = [];
  let lastFocus = null;
  let busy = false;

  const state = (s) => { drop.dataset.state = s; };
  const say = (t) => { $("d-status").textContent = t; };

  function count() {
    $("d-count").textContent = `[ ${items.length} ]`;
    $("d-send").disabled = !items.length;
    $("d-form").hidden = !items.length;
  }

  function addItem(result, file) {
    const it = { result, file };
    const row = document.createElement("div");
    row.className = "drop-item";
    const thumb = document.createElement("div");
    thumb.className = "drop-thumb";
    KimayaUploads.preview(thumb, result);
    const cap = document.createElement("input");
    cap.maxLength = 140;
    cap.placeholder = "its own caption (optional)";
    cap.autocomplete = "off";
    cap.setAttribute("aria-label", `caption for ${file.name}`);
    const meta = document.createElement("small");
    meta.textContent = `${result.kind === "video" ? "● 8s clip" : "■ photo"}${result.takenOn ? ` · ${KimayaUploads.stamp(result.takenOn)}` : ""}`;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "hud-btn drop-x";
    x.textContent = "×";
    x.setAttribute("aria-label", `remove ${file.name}`);
    x.addEventListener("click", () => {
      items.splice(items.indexOf(it), 1);
      KimayaUploads.preview(thumb, null);
      row.remove();
      count();
    });
    const fields = document.createElement("div");
    fields.className = "drop-fields";
    fields.append(cap, meta);
    row.append(thumb, fields, x);
    Object.assign(it, { row, cap, thumb });
    items.push(it);
    $("d-list").append(row);
    count();
  }

  // files -> prepared items, one after another (a video plays through once to make its clip)
  async function ingest(files) {
    const list = [...files];
    if (!list.length || busy) return;
    busy = true;
    $("d-choose").disabled = true;
    $("d-err").textContent = "";
    let err = "";
    for (const [i, file] of list.entries()) {
      if (items.length >= MAX) { err = `${MAX} at once is the most`; break; }
      const video = (file.type || "").startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(file.name || "");
      say(`${video ? "MAKING CLIP" : "READING"} ${i + 1}/${list.length}…`);
      try {
        addItem(await KimayaUploads.prepare(file), file);
      } catch (e) {
        err = `${file.name}: ${e.message}`;
      }
    }
    say(err ? `${err}.` : "");
    $("d-choose").disabled = false;
    busy = false;
  }

  function clear() {
    items.splice(0).forEach((it) => { KimayaUploads.preview(it.thumb, null); it.row.remove(); });
    count();
    say("");
  }

  async function send(e) {
    e.preventDefault();
    const name = $("d-name").value.trim();
    const message = $("d-msg").value.trim();
    if (!items.length || !name || !message || busy) return;
    busy = true;
    $("d-send").disabled = true;
    $("d-err").textContent = "";
    state("sending");
    say(`SENDING ${items.length}…`);
    try {
      const data = await KimayaGuestbook.postMany({
        name,
        message,
        items: items.map((it) => ({ photo: it.result.photo, clip: it.result.clip, takenOn: it.result.takenOn, message: it.cap.value.trim() })),
        onProgress: (n, total) => say(`SENDING ${n + 1}/${total}…`),
      });
      const n = data.count || items.length;
      $("d-sent-note").textContent = `${n === 1 ? "one memory" : `${n} memories`} saved. they'll show up once kimaya says yes.`;
      clear();
      $("d-name").value = "";
      $("d-msg").value = "";
      $("d-left").textContent = "140";
      state("sent");
      $("d-done").focus();
    } catch (err) {
      $("d-err").textContent = `${err.message}.`;
      say("");
      state("pick");
    } finally {
      busy = false;
      $("d-send").disabled = !items.length;
    }
  }

  function open(files) {
    if (drop.hidden) {
      lastFocus = document.activeElement;
      drop.hidden = false;
      document.body.classList.add("drop-open");
    }
    if (drop.dataset.state === "sent") state("pick");
    KimayaGuestbook.loadTurnstile?.().catch(() => {}); // warm up the check while they pick
    if (files && files.length) ingest(files);
    else $("d-choose").focus({ preventScroll: true });
  }

  function close() {
    if (drop.hidden) return;
    drop.hidden = true;
    document.body.classList.remove("drop-open");
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  // ---------- wire up ----------

  $("d-choose").addEventListener("click", () => $("d-file").click());
  $("d-file").addEventListener("change", () => { const f = [...$("d-file").files]; $("d-file").value = ""; ingest(f); });
  $("d-form").addEventListener("submit", send);
  $("d-msg").addEventListener("input", (e) => { $("d-left").textContent = 140 - e.target.value.length; });
  $("d-close").addEventListener("click", close);
  $("d-done").addEventListener("click", close);
  $("d-more").addEventListener("click", () => { state("pick"); $("d-choose").focus(); });
  drop.addEventListener("click", (e) => { if (e.target === drop && !busy) close(); });
  // keys stay here: the journey underneath listens on window
  document.addEventListener("keydown", (e) => {
    if (drop.hidden) return;
    e.stopPropagation();
    if (e.key === "Escape" && !busy) close();
  });
  window.addEventListener("kimaya:drop", (e) => open(e.detail && e.detail.files));
  document.querySelectorAll("[data-drop]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); open(); }));
  count();
  state("pick");
})();
