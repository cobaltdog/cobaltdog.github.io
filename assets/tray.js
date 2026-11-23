(function () {
  "use strict";

  var C = window.TRAY_CONFIG || {};
  var MAX_ITEMS = C.MAX_ITEMS || 5;
  var MAX_BYTES = C.MAX_BYTES || 100 * 1024 * 1024;

  var $ = function (id) { return document.getElementById(id); };
  var slotsEl = $("slots"), drop = $("drop"), input = $("file"), dropLabel = $("drop-label");
  var toastEl = $("toast"), toastTimer;

  $("lock-btn").addEventListener("click", function () {
    try { sessionStorage.removeItem("tray-unlocked"); } catch (_) {}
    location.href = "/";
  });

  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = "toast mono show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = "toast mono"; }, 4200);
  }

  function fmt(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function ago(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  // Stored as "<timestamp>__<original name>" so names can repeat and order is stable.
  function displayName(path) {
    var i = path.indexOf("__");
    return i === -1 ? path : path.slice(i + 2);
  }

  function safeName(name) {
    return name.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";
  }

  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) {
    slotsEl.innerHTML = '<li class="slot empty"><span class="mono">—</span><span class="name">Storage isn’t connected yet. Fill in assets/config.js (see SETUP.md).</span></li>';
    drop.style.opacity = "0.4";
    drop.style.pointerEvents = "none";
    return;
  }

  var store = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY).storage.from(C.BUCKET || "tray");
  var items = []; // oldest first

  async function load() {
    var res = await store.list("", { limit: 100, sortBy: { column: "created_at", order: "asc" } });
    if (res.error) { toast("Couldn’t load the tray: " + res.error.message, true); return; }
    items = (res.data || [])
      .filter(function (o) { return o.id && o.name !== ".emptyFolderPlaceholder"; })
      .map(function (o) { return { path: o.name, size: (o.metadata && o.metadata.size) || 0, created: o.created_at }; });
    render();
  }

  function render() {
    var used = items.reduce(function (a, b) { return a + b.size; }, 0);
    var pct = Math.min(100, (used / MAX_BYTES) * 100);
    $("used").textContent = fmt(used) + " / " + fmt(MAX_BYTES);
    $("count").textContent = items.length + " / " + MAX_ITEMS;
    var bar = $("bar");
    bar.querySelector("i").style.width = pct + "%";
    bar.setAttribute("aria-valuenow", Math.round(pct));
    bar.classList.toggle("hot", pct > 85 || items.length >= MAX_ITEMS);

    slotsEl.innerHTML = "";
    // Newest on top; the oldest (next out) is flagged when the tray is full.
    var view = items.slice().reverse();
    for (var n = 0; n < MAX_ITEMS; n++) {
      var li = document.createElement("li");
      var it = view[n];
      var idx = String(n + 1).padStart(2, "0");
      if (!it) {
        li.className = "slot empty";
        li.innerHTML = '<span class="mono">' + idx + '</span><span class="name">Empty</span>';
      } else {
        li.className = "slot";
        var isNext = items.length >= MAX_ITEMS && it === items[0];
        var num = document.createElement("span"); num.className = "mono"; num.textContent = idx;
        var name = document.createElement("span"); name.className = "name"; name.textContent = displayName(it.path); name.title = displayName(it.path);
        var meta = document.createElement("span"); meta.className = "mono muted size";
        meta.textContent = fmt(it.size) + " · " + ago(it.created);
        if (isNext) { var nx = document.createElement("span"); nx.className = "next"; nx.textContent = " · next out"; meta.appendChild(nx); }
        var btn = document.createElement("button"); btn.className = "dl"; btn.type = "button"; btn.textContent = "Download";
        btn.setAttribute("aria-label", "Download " + displayName(it.path));
        btn.addEventListener("click", download.bind(null, it, btn));
        li.append(num, name, meta, btn);
      }
      slotsEl.appendChild(li);
    }
  }

  async function download(it, btn) {
    btn.disabled = true; btn.textContent = "…";
    var res = await store.download(it.path);
    btn.disabled = false; btn.textContent = "Download";
    if (res.error) { toast("Download failed: " + res.error.message, true); load(); return; }
    var url = URL.createObjectURL(res.data);
    var a = document.createElement("a");
    a.href = url; a.download = displayName(it.path);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  async function upload(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { toast("That file is over 100 MB.", true); return; }

    drop.classList.add("busy"); dropLabel.textContent = "Uploading";
    await load(); // work from the freshest list

    // Queue: drop the oldest until the new file fits on both count and size.
    var evict = [], keep = items.slice();
    var used = keep.reduce(function (a, b) { return a + b.size; }, 0);
    while (keep.length && (keep.length >= MAX_ITEMS || used + file.size > MAX_BYTES)) {
      var out = keep.shift(); used -= out.size; evict.push(out);
    }

    var path = Date.now() + "__" + safeName(file.name);
    var up = await store.upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (up.error) {
      drop.classList.remove("busy"); dropLabel.textContent = "Drop a file";
      toast("Upload failed: " + up.error.message, true);
      return;
    }

    if (evict.length) {
      var rm = await store.remove(evict.map(function (e) { return e.path; }));
      if (rm.error) toast("Uploaded, but couldn’t remove the oldest item: " + rm.error.message, true);
      else toast("Added " + file.name + ". Removed " + evict.map(function (e) { return displayName(e.path); }).join(", ") + ".");
    } else {
      toast("Added " + file.name + ".");
    }

    drop.classList.remove("busy"); dropLabel.textContent = "Drop a file";
    load();
  }

  input.addEventListener("change", function () { upload(input.files[0]); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) upload(f);
  });

  load();
  setInterval(load, 30000);
})();
