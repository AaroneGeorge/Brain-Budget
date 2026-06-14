import "./env.js";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { erc20Abi, formatUnits } from "viem";
import { createBudgetDelegation, ensure7702Upgraded } from "@brainbudget/shared";
import { SERVER_PORT, chainConfig, getActors, publicClient } from "./config.js";
import { makeGateway, paymentLog } from "./gateway.js";
import { handleRelayerWebhook, runs, startResearch } from "./agent/loop.js";
import { verifyRelayerWebhook } from "./relayer.js";
import { veniceBalance, veniceMocked } from "./venice.js";

const app = express();
const actors = await getActors();

app.use(makeGateway(actors.gatewayEoa.address));
app.use(cors());
app.use(express.json());

const usdcBalance = (address: `0x${string}`) =>
  publicClient.readContract({
    address: chainConfig.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });

app.get("/state", async (_req, res) => {
  // Tolerate a transient public-RPC blip on the balance read so the live UI
  // ticker never breaks mid-demo; the UI just shows "—" for one poll cycle.
  const [userUsdc, venice] = await Promise.all([
    usdcBalance(actors.userSmartAccount.address).catch(() => null),
    veniceBalance().catch(() => null),
  ]);
  res.json({
    chain: { name: chainConfig.chain.name, id: chainConfig.chain.id },
    user: {
      address: actors.userSmartAccount.address,
      usdc: userUsdc !== null ? formatUnits(userUsdc, 6) : "—",
    },
    agent: { address: actors.agentSmartAccount.address },
    critic: actors.criticSmartAccount ? { address: actors.criticSmartAccount.address } : null,
    gateway: { address: actors.gatewayEoa.address, venice, veniceMocked: veniceMocked() },
    payments: paymentLog.length,
  });
});

app.post("/research", async (req: Request, res: Response) => {
  try {
    const { question, budgetUsd = 0.05, maxCalls = 10 } = req.body as {
      question?: string;
      budgetUsd?: number;
      maxCalls?: number;
    };
    if (!question?.trim()) {
      res.status(400).json({ error: "question is required" });
      return;
    }

    // one-time: every delegator EOA must be a 7702 smart account
    const delegatorImpl =
      actors.userSmartAccount.environment.implementations.EIP7702StatelessDeleGatorImpl;
    const owners = [actors.userEoa, actors.agentEoa, actors.criticEoa].filter(
      (a): a is NonNullable<typeof a> => Boolean(a),
    );
    for (const owner of owners) {
      await ensure7702Upgraded({
        publicClient,
        owner,
        submitter: actors.agentWallet,
        chain: chainConfig.chain,
        delegatorImpl,
      });
    }

    // the user grants the agent its scoped budget
    const userDelegation = await createBudgetDelegation({
      to: actors.agentSmartAccount.address,
      delegator: actors.userSmartAccount,
      usdc: chainConfig.usdc,
      maxUsdc: budgetUsd.toFixed(6),
      maxCalls,
      validForSeconds: 24 * 3600,
    });

    const run = startResearch({
      question: question.trim(),
      budgetUsd,
      inferenceUrl: `http://localhost:${SERVER_PORT}/paid/inference`,
      agentSmartAccount: actors.agentSmartAccount,
      userDelegation,
      userSmartAccount: actors.userSmartAccount,
      criticSmartAccount: actors.criticSmartAccount,
    });

    res.json({
      runId: run.id,
      delegation: JSON.parse(
        JSON.stringify(userDelegation, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      ),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/research/:id/events", (req: Request, res: Response) => {
  const run = runs.get(String(req.params.id));
  if (!run) {
    res.status(404).json({ error: "unknown run" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  run.events.forEach(send);
  if (run.done) {
    res.write("event: done\ndata: {}\n\n");
    res.end();
    return;
  }
  const onEvent = (event: unknown) => send(event);
  const onDone = () => {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  };
  run.emitter.on("event", onEvent);
  run.emitter.once("done", onDone);
  req.on("close", () => {
    run.emitter.off("event", onEvent);
    run.emitter.off("done", onDone);
  });
});

// 1Shot status webhooks (set RELAYER_WEBHOOK_URL to a public tunnel of this route)
app.post("/relayer/webhook", async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!(await verifyRelayerWebhook(body))) {
      res.status(401).json({ error: "Ed25519 signature verification failed" });
      return;
    }
    const matched = handleRelayerWebhook(
      body as unknown as Parameters<typeof handleRelayerWebhook>[0],
    );
    res.json({ ok: true, matched });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, payments: paymentLog.length });
});

app.listen(SERVER_PORT, () => {
  console.log(`[server] listening on http://localhost:${SERVER_PORT}`);
  console.log(`[server] paywalled route: POST /paid/inference (${veniceMocked() ? "MOCK Venice" : "real Venice"})`);
});
