"use strict";
const { randomUUID } = require("node:crypto");
const { transaction } = require("./db");
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
function nextOccurrence(value, frequency, anchorDay) {
  const day = dateOnly(value);
  const date = new Date(day + "T12:00:00Z");
  if (!Number.isFinite(date.getTime())) throw new Error("Date récurrente invalide.");
  if (frequency === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  else {
    const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
    if (!months) throw new Error("Fréquence invalide.");
    const anchor = anchorDay || date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor, last));
  }
  return date.toISOString().slice(0, 10);
}
function swissMorning(day) {
  const utc = new Date(day + "T08:00:00Z");
  const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hourCycle: "h23" }).format(utc));
  return new Date(utc.getTime() - (localHour - 8) * 3600000);
}
async function runDueRecurringJobs(db) {
  return transaction(db, async (c) => {
    const jobs = (await c.query(`SELECT * FROM recurring_jobs WHERE active=true AND next_run <= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Zurich')::date ORDER BY next_run LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
    let count = 0;
    for (const job of jobs) {
      const day = dateOnly(job.next_run);
      const inserted = await c.query(`INSERT INTO work_orders(id,company,maintenance_id,title,status,priority,scheduled_at,created_by,recurring_job_id,occurrence_date) VALUES($1,$2,$3,$4,'planned','normal',$5,$6,$7,$8) ON CONFLICT(recurring_job_id,occurrence_date) DO NOTHING RETURNING id`, [randomUUID(), job.company, job.maintenance_id, job.title, swissMorning(day), job.created_by, job.id, day]);
      const anchor = job.anchor_day || Number(day.slice(8));
      await c.query("UPDATE recurring_jobs SET next_run=$1,anchor_day=$2,updated_at=NOW() WHERE id=$3", [nextOccurrence(day, job.frequency, anchor), anchor, job.id]);
      count += inserted.rows.length;
    }
    return count;
  });
}
module.exports = { runDueRecurringJobs, nextOccurrence, swissMorning };
