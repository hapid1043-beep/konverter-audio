const express = require("express");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new DatabaseSync("app.db");
db.exec(`CREATE TABLE IF NOT EXISTS devices(
  device_id TEXT PRIMARY KEY,
  used INTEGER DEFAULT 0,
  paid_until INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders(
  order_id TEXT PRIMARY KEY,
  device_id TEXT,
  status TEXT
);`);

const FREE_LIMIT = 3;
const PREMIUM_DAYS = 30;
const PRICE = 20000;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const XENDIT_KEY = process.env.XENDIT_SECRET_KEY;
const CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN;

function getDevice(id) {
  db.prepare("INSERT OR IGNORE INTO devices(device_id) VALUES(?)").run(id);
  return db.prepare("SELECT * FROM devices WHERE device_id=?").get(id);
}
const isPaid = d => d.paid_until > Date.now();

app.get("/api/quota", (req, res) => {
  const d = getDevice(req.query.deviceId);
  res.json({ used: d.used, paid: isPaid(d) });
});

app.post("/api/use", (req, res) => {
  const d = getDevice(req.body.deviceId);
  if (!isPaid(d)) {
    if (d.used >= FREE_LIMIT) return res.status(403).json({ used: d.used, paid: false });
    db.prepare("UPDATE devices SET used=used+1 WHERE device_id=?").run(d.device_id);
  }
  const u = getDevice(d.device_id);
  res.json({ used: u.used, paid: isPaid(u) });
});

app.post("/api/create-payment", async (req, res) => {
  try {
    const orderId = "ORD-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    db.prepare("INSERT INTO orders VALUES(?,?,?)").run(orderId, req.body.deviceId, "pending");

    const r = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(XENDIT_KEY + ":").toString("base64")
      },
      body: JSON.stringify({
        external_id: orderId,
        amount: PRICE,
        currency: "IDR",
        description: "Premium 30 hari",
        success_redirect_url: BASE_URL + "/?paid=1",
        failure_redirect_url: BASE_URL + "/",
        invoice_duration: 86400
      })
    });
    const inv = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(inv));
    res.json({ invoice_url: inv.invoice_url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal membuat transaksi" });
  }
});

app.post("/api/webhook", (req, res) => {
  if (!CALLBACK_TOKEN || req.headers["x-callback-token"] !== CALLBACK_TOKEN) {
    return res.sendStatus(401);
  }
  const inv = req.body;
  const order = db.prepare("SELECT * FROM orders WHERE order_id=?").get(inv.external_id);
  const paid = inv.status === "PAID" || inv.status === "SETTLED";
  if (order && paid && order.status !== "paid") {
    db.prepare("UPDATE orders SET status='paid' WHERE order_id=?").run(inv.external_id);
    const until = Date.now() + PREMIUM_DAYS * 86400000;
    db.prepare("UPDATE devices SET paid_until=? WHERE device_id=?").run(until, order.device_id);
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log("Server jalan"));
