"use strict";
const { EventEmitter } = require("node:events");

const hub = new EventEmitter();
hub.setMaxListeners(5000);

function publish(event = {}) {
  hub.emit("event", {
    id: event.id || null,
    type: event.eventType || event.type || "update",
    company: event.company || null,
    projectId: event.projectId || null,
    entityType: event.entityType || null,
    entityId: event.entityId || null,
    userIds: Array.isArray(event.userIds) ? event.userIds.map(Number) : null,
    createdAt: event.createdAt || new Date().toISOString(),
    payload:
      event.payload && typeof event.payload === "object" ? event.payload : {},
  });
}

function subscribe(handler) {
  hub.on("event", handler);
  return () => hub.off("event", handler);
}

module.exports = { publish, subscribe };
