"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const webPush = require("web-push");
const { database } = require("./database");
const { migrate } = require("../db");
const { notifyUsers } = require("../messaging-routes");

test("push: stale-key subscriptions are removed, configuration errors are logged, not deleted", async () => {
  const db = await database();
  const keys = webPush.generateVAPIDKeys();
  const before = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  const originalSend = webPush.sendNotification;
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "https://example.test";
  try {
    await migrate(db);
    const user = (
      await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES('push@test.invalid','x','admin','Push','','group') RETURNING id")
    ).rows[0].id;
    const answers = {
      "https://fcm.googleapis.com/ok": null,
      "https://fcm.googleapis.com/stale": { statusCode: 403, body: "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions." },
      "https://web.push.apple.com/stale": { statusCode: 403, body: '{"reason":"VapidPkHashMismatch"}' },
      "https://fcm.googleapis.com/gone": { statusCode: 410, body: "push subscription has unsubscribed or expired." },
      "https://web.push.apple.com/config": { statusCode: 403, body: '{"reason":"BadJwtToken"}' },
    };
    for (const endpoint of Object.keys(answers))
      await db.query("INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES($1,$2,'p','a')", [user, endpoint]);
    webPush.sendNotification = async (subscription) => {
      const failure = answers[subscription.endpoint];
      if (failure) throw Object.assign(new Error("push failed"), failure);
      return { statusCode: 201 };
    };

    const out = await notifyUsers(db, [user], { title: "Test", body: "Bonjour", category: "system" });
    assert.equal(out.sent, 1);

    const remaining = (await db.query("SELECT endpoint FROM push_subscriptions ORDER BY endpoint")).rows.map((r) => r.endpoint);
    assert.deepEqual(remaining, ["https://fcm.googleapis.com/ok", "https://web.push.apple.com/config"]);

    const logged = (await db.query("SELECT method,path,status,message,metadata FROM application_errors WHERE method='PUSH'")).rows;
    assert.equal(logged.length, 1);
    assert.equal(logged[0].path, "web.push.apple.com");
    assert.equal(logged[0].status, 0, "push failures must not count in the HTTP error rate");
    assert.match(logged[0].message, /BadJwtToken/);
    assert.equal(logged[0].metadata.pushStatus, 403);
  } finally {
    webPush.sendNotification = originalSend;
    for (const [k, v] of [["VAPID_PUBLIC_KEY", before.pub], ["VAPID_PRIVATE_KEY", before.priv], ["VAPID_SUBJECT", before.subject]])
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    await db.end();
  }
});
