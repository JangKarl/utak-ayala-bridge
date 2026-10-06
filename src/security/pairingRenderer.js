const message = document.getElementById("message");
const invite = document.getElementById("invite");
const countdown = document.getElementById("countdown");
let timer;

function say(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function hideInvite() {
  clearInterval(timer);
  invite.hidden = true;
}

async function refresh() {
  const devices = await window.pairing.list();
  const list = document.getElementById("devices");
  list.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No POS paired yet.";
    list.append(empty);
  }
  for (const device of devices) {
    const item = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "device";
    name.textContent = device.deviceName;
    const store = document.createElement("div");
    store.className = "store";
    store.textContent = device.ccode;
    info.append(name, store);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "btn-danger";
    revoke.textContent = "Revoke";
    revoke.onclick = async () => {
      if (!confirm("Revoke " + device.deviceName + "? It must be paired again to reach the bridge.")) return;
      try { await window.pairing.revoke(device.id); await refresh(); say(device.deviceName + " revoked."); }
      catch (error) { say(error.message, true); }
    };
    item.append(info, revoke);
    list.append(item);
  }
}

document.getElementById("form").onsubmit = async event => {
  event.preventDefault();
  hideInvite();
  say("");
  try {
    const result = await window.pairing.invite(document.getElementById("ccode").value.trim());
    document.getElementById("qr").src = result.qr;
    document.getElementById("code").textContent = result.code;
    invite.hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
      countdown.textContent = "Expires in " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      if (!left) { hideInvite(); say("Pairing code expired. Create a new code.", true); }
    };
    tick();
    timer = setInterval(tick, 1000);
  } catch (error) { say(error.message, true); }
};
document.getElementById("refresh").onclick = () => refresh().catch(error => say(error.message, true));
refresh().catch(error => say(error.message, true));
