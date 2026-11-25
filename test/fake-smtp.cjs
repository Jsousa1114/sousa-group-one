"use strict";
const net = require("node:net");
// A minimal SMTP server: AUTH PLAIN with one password, then records each message.
function fakeSmtp(password, messages) {
  return net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "",
      inData = false,
      current = null;
    const send = (line) => socket.write(line + "\r\n");
    send("220 fake.smtp ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            send("250 2.0.0 queued");
          } else current.raw += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (command.startsWith("AUTH PLAIN")) {
          const parts = Buffer.from(line.split(" ")[2] || "", "base64").toString().split("\0");
          send(parts[2] === password() ? "235 2.7.0 accepted" : "535 5.7.8 bad credentials");
        } else if (command.startsWith("MAIL FROM")) {
          current = { from: line, to: [], raw: "" };
          send("250 ok");
        } else if (command.startsWith("RCPT TO")) {
          current.to.push(line);
          send("250 ok");
        } else if (command === "DATA") {
          inData = true;
          send("354 go ahead");
        } else if (command === "QUIT") {
          send("221 bye");
          socket.end();
        } else send("250 ok");
      }
    });
    socket.on("error", () => {});
  });
}

module.exports = { fakeSmtp };
