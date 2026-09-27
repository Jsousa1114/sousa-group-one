"use strict";
(() => {
  const supported =
    !!window.PublicKeyCredential &&
    !!navigator.credentials?.create &&
    !!navigator.credentials?.get;
  let loading = false;

  const core = () => window.SGOChatCore;
  const esc = (v) => core()?.esc?.(v) ?? String(v ?? "");

  function decodeBase64url(value) {
    const s = String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  function encodeBase64url(value) {
    const bytes = new Uint8Array(value);
    let raw = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function creationOptionsFromJSON(options) {
    if (PublicKeyCredential.parseCreationOptionsFromJSON)
      return PublicKeyCredential.parseCreationOptionsFromJSON(options);
    return {
      ...options,
      challenge: decodeBase64url(options.challenge),
      user: {
        ...options.user,
        id: decodeBase64url(options.user.id),
      },
      excludeCredentials: (options.excludeCredentials || []).map((x) => ({
        ...x,
        id: decodeBase64url(x.id),
      })),
    };
  }

  function requestOptionsFromJSON(options) {
    if (PublicKeyCredential.parseRequestOptionsFromJSON)
      return PublicKeyCredential.parseRequestOptionsFromJSON(options);
    return {
      ...options,
      challenge: decodeBase64url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((x) => ({
        ...x,
        id: decodeBase64url(x.id),
      })),
    };
  }

  function credentialJSON(credential) {
    if (credential?.toJSON) return credential.toJSON();
    const response = credential.response;
    const out = {
      id: credential.id,
      rawId: encodeBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults?.() || {},
      response: {
        clientDataJSON: encodeBase64url(response.clientDataJSON),
      },
    };
    if ("attestationObject" in response) {
      out.response.attestationObject = encodeBase64url(response.attestationObject);
      out.response.transports = response.getTransports?.() || [];
    } else {
      out.response.authenticatorData = encodeBase64url(response.authenticatorData);
      out.response.signature = encodeBase64url(response.signature);
      out.response.userHandle = response.userHandle
        ? encodeBase64url(response.userHandle)
        : null;
    }
    return out;
  }

  async function request(path, body) {
    const r = await fetch("/api/passkeys/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Opération Passkey impossible.");
    return data;
  }

  function fmt(value) {
    return value
      ? new Intl.DateTimeFormat("fr-CH", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "Jamais";
  }

  async function render() {
    const root = document.getElementById("passkeyPanel");
    if (!root || loading) return;
    if (!supported) {
      root.innerHTML =
        '<h4>Passkeys</h4><p class="muted">Ce navigateur ne prend pas en charge les passkeys.</p>';
      return;
    }
    loading = true;
    try {
      const data = await request("", undefined);
      root.innerHTML = `
        <div class="account-section-head">
          <div><span class="account-icon">🔑</span><h4>Passkeys</h4></div>
          <button class="btn primary" type="button" data-passkey-action="add">Ajouter une passkey</button>
        </div>
        <p class="muted">Utilisez Face ID, Touch ID, Windows Hello ou une clé de sécurité pour vous connecter sans saisir votre mot de passe.</p>
        <div class="account-sessions">
          ${data.passkeys?.length
            ? data.passkeys
                .map(
                  (p) => `
                    <div class="account-session">
                      <div>
                        <b>${esc(p.name || "Passkey")}${p.backedUp ? ' <span class="status ok">Synchronisée</span>' : ""}</b>
                        <span>Ajoutée ${esc(fmt(p.createdAt))} · Dernière utilisation ${esc(fmt(p.lastUsedAt))}</span>
                      </div>
                      <button class="btn danger" type="button" data-passkey-action="delete" data-passkey-id="${esc(p.id)}">Supprimer</button>
                    </div>`,
                )
                .join("")
            : '<p class="muted">Aucune passkey enregistrée.</p>'}
        </div>
      `;
    } catch (error) {
      root.innerHTML =
        '<h4>Passkeys</h4><p class="error">' + esc(error.message) + "</p>";
    } finally {
      loading = false;
    }
  }

  function openRegister() {
    core().modal(
      "Ajouter une passkey",
      `<form id="passkeyRegisterForm">
        <p>La passkey sera liée à ce compte. Confirmez votre mot de passe avant de continuer.</p>
        <label>Nom de la passkey<input name="name" maxlength="120" value="Mon appareil" required></label>
        <label>Mot de passe actuel<input type="password" name="currentPassword" autocomplete="current-password" required></label>
        <p id="formError" class="error"></p>
        <button class="btn primary" type="submit">Créer la passkey</button>
      </form>`,
    );
  }

  function openDelete(id) {
    core().modal(
      "Supprimer la passkey",
      `<form id="passkeyDeleteForm" data-passkey-id="${esc(id)}">
        <p>Cette passkey ne pourra plus être utilisée pour se connecter.</p>
        <label>Mot de passe actuel<input type="password" name="currentPassword" autocomplete="current-password" required></label>
        <p id="formError" class="error"></p>
        <button class="btn danger" type="submit">Supprimer définitivement</button>
      </form>`,
    );
  }

  async function register(form) {
    const data = new FormData(form);
    const start = await request("register/options", {
      currentPassword: data.get("currentPassword"),
    });
    const credential = await navigator.credentials.create({
      publicKey: creationOptionsFromJSON(start.options),
    });
    if (!credential) throw new Error("Création de la passkey annulée.");
    await request("register/verify", {
      challengeId: start.challengeId,
      name: String(data.get("name") || "Passkey"),
      response: credentialJSON(credential),
    });
    core().closeModal(true);
    core().toast("Passkey ajoutée.");
    await render();
  }

  async function remove(form) {
    const data = new FormData(form);
    await request("delete", {
      id: form.dataset.passkeyId,
      currentPassword: data.get("currentPassword"),
    });
    core().closeModal(true);
    core().toast("Passkey supprimée.");
    await render();
  }

  async function passkeyLogin(button) {
    const error = document.getElementById("loginError");
    const email = String(document.getElementById("email")?.value || "").trim();
    if (!email) {
      if (error) error.textContent = "Saisissez d’abord votre adresse e-mail.";
      document.getElementById("email")?.focus();
      return;
    }
    button.disabled = true;
    if (error) error.textContent = "";
    try {
      const start = await request("login/options", { email });
      const credential = await navigator.credentials.get({
        publicKey: requestOptionsFromJSON(start.options),
      });
      if (!credential) throw new Error("Connexion Passkey annulée.");
      await request("login/verify", {
        challengeId: start.challengeId,
        response: credentialJSON(credential),
      });
      sessionStorage.setItem("sgo_session", "1");
      location.reload();
    } catch (e) {
      if (error)
        error.textContent =
          e?.name === "NotAllowedError"
            ? "Connexion Passkey annulée ou non autorisée sur cet appareil."
            : e.message;
    } finally {
      button.disabled = false;
    }
  }

  function installLoginButton() {
    if (!supported) return;
    const form = document.getElementById("loginForm");
    if (!form || document.getElementById("passkeyLoginButton")) return;
    const primary = form.querySelector('button[type="submit"]');
    if (!primary) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "passkeyLoginButton";
    button.className = "btn wide";
    button.textContent = "Se connecter avec une passkey";
    button.style.marginTop = "10px";
    primary.insertAdjacentElement("afterend", button);
    button.addEventListener("click", () => passkeyLogin(button));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-passkey-action]");
    if (!button) return;
    if (button.dataset.passkeyAction === "add") openRegister();
    else if (button.dataset.passkeyAction === "delete")
      openDelete(button.dataset.passkeyId);
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!["passkeyRegisterForm", "passkeyDeleteForm"].includes(form.id)) return;
    event.preventDefault();
    const err = form.querySelector("#formError");
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (form.id === "passkeyRegisterForm") await register(form);
      else await remove(form);
    } catch (e) {
      if (err)
        err.textContent =
          e?.name === "NotAllowedError"
            ? "Opération annulée ou non autorisée sur cet appareil."
            : e.message;
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  installLoginButton();
  window.SGOPasskeys = { render, supported };
})();
