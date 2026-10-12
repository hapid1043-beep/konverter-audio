const express = require("express");
const cors = require("cors");
const midtrans = require("midtrans-client");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new Database("app.db");
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

const snap = new midtrans.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY
});

function getDevice(id){
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
    const orderId = "ORD-" + Date.now() + "-" + Math.random().toString(36).slice(2,7);
    db.prepare("INSERT INTO orders VALUES(?,?,?)").run(orderId, req.body.deviceId, "pending");
    const trx = await snap.createTransaction({
      transaction_details: { order_id: orderId, gross_amount: PRICE },
      item_details: [{ id: "PREMIUM30", price: PRICE, quantity: 1, name: "Premium 30 hari" }],
      callbacks: { finish: BASE_URL + "/?paid=1" }
    });
    res.json({ token: trx.token, orderId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal membuat transaksi" });
  }
});

app.post("/api/webhook", async (req, res) => {
  try {
    const core = new midtrans.CoreApi({
      isProduction: false, serverKey: process.env.MIDTRANS_SERVER_KEY
    });
    const s = await core.transaction.notification(req.body);
    const order = db.prepare("SELECT * FROM orders WHERE order_id=?").get(s.order_id);
    const ok = ["capture","settlement"].includes(s.transaction_status) && s.fraud_status !== "deny";
    if (order && ok && order.status !== "paid") {
      db.prepare("UPDATE orders SET status='paid' WHERE order_id=?").run(s.order_id);
      const until = Date.now() + PREMIUM_DAYS * 86400000;
      db.prepare("UPDATE devices SET paid_until=? WHERE device_id=?").run(until, order.device_id);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server jalan"));
