"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadPasskeys() {
  const window = {};
  const context = vm.createContext({ window, navigator: {}, document: { addEventListener() {} }, sessionStorage: {}, location: {} });
  vm.runInContext(fs.readFileSync("passkeys.js", "utf8"), context, { filename: "passkeys.js" });
  return window.SGOPasskeys;
}

test("passkey browser errors are explained in French", () => {
  const { passkeyErrorMessage } = loadPasskeys();
  const err = (name, message = "The object is in an invalid state.") => Object.assign(new Error(message), { name });
  // Safari on iPhone when a passkey already exists for this account on the device.
  assert.match(passkeyErrorMessage(err("InvalidStateError"), "register"), /existe déjà.*Se connecter avec une passkey/);
  assert.match(passkeyErrorMessage(err("NotAllowedError"), "login"), /Connexion Passkey annulée/);
  assert.match(passkeyErrorMessage(err("NotAllowedError"), "register"), /Opération annulée/);
  assert.match(passkeyErrorMessage(err("SecurityError"), "login"), /HTTPS/);
  assert.match(passkeyErrorMessage(err("NotSupportedError"), "register"), /ne prend pas en charge/);
  assert.equal(passkeyErrorMessage(new Error("Message serveur"), "login"), "Message serveur");
  for (const name of ["InvalidStateError", "NotAllowedError", "SecurityError", "NotSupportedError", "AbortError"])
    assert.doesNotMatch(passkeyErrorMessage(err(name), "register"), /invalid state/i);
});
