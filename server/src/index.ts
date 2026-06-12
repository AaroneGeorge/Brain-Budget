import "./env.js";
import express from "express";
import { SERVER_PORT, getActors } from "./config.js";
import { makeGateway, paymentLog } from "./gateway.js";

const app = express();

const actors = await getActors();
app.use(makeGateway(actors.gatewayEoa.address));

app.get("/health", (_req, res) => {
  res.json({ ok: true, payments: paymentLog.length });
});

app.listen(SERVER_PORT, () => {
  console.log(`[server] gateway listening on http://localhost:${SERVER_PORT}`);
  console.log(`[server] paywalled route: POST /paid/inference`);
});
