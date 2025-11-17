"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const RESET_TIMEZONE = "Europe/Istanbul";
const RESET_CONTROL_REF = db.doc("systemSettings/dailyRosterReset");

function currentResetDateKey() {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: RESET_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(new Date());
  } catch (e) {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${today.getFullYear()}-${month}-${day}`;
  }
}

async function resetRosterForGroup(groupId) {
  if (!groupId) return;
  const rosterRef = db.collection("groups").doc(groupId).collection("busRoster");
  const snapshot = await rosterRef.get();

  let batch = db.batch();
  let writes = 0;

  async function commitBatch() {
    if (!writes) return;
    await batch.commit();
    batch = db.batch();
    writes = 0;
  }

  for (const docSnap of snapshot.docs) {
    batch.set(
      docSnap.ref,
      {
        isOnBus: false,
        joinedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    writes += 1;
    if (writes >= 400) {
      await commitBatch();
    }
  }

  await commitBatch();
  await db.collection("groups").doc(groupId).set(
    {
      lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function ensureGlobalDailyReset() {
  const todayKey = currentResetDateKey();

  let needsReset = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(RESET_CONTROL_REF);
    const lastResetDate = snapshot.exists ? snapshot.data().lastResetDate : null;
    if (lastResetDate === todayKey) {
      needsReset = false;
      return;
    }
    needsReset = true;
    transaction.set(
      RESET_CONTROL_REF,
      {
        lastResetDate: todayKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  if (!needsReset) return;

  const groupsSnapshot = await db.collection("groups").get();
  for (const groupSnap of groupsSnapshot.docs) {
    await resetRosterForGroup(groupSnap.id);
  }
}

exports.scheduledDailyRosterReset = functions.pubsub
  .schedule("0 0 * * *")
  .timeZone(RESET_TIMEZONE)
  .onRun(async () => {
    await ensureGlobalDailyReset();
  });

