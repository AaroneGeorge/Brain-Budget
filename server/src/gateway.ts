import express, { type Request, type Response, type Router } from "express";
import cors from "cors";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { x402ExactEvmErc7710ServerScheme } from "@metamask/x402";
import { facilitatorUrl, networkId, INFERENCE_PRICE } from "./config.js";
import { runInference, type InferenceRequest } from "./venice.js";

export interface PaymentLogEntry {
  at: string;
  route: string;
  payer?: string;
  settlement?: unknown;
}

export const paymentLog: PaymentLogEntry[] = [];

/**
 * The x402-paywalled inference gateway. Every POST /paid/inference costs
 * INFERENCE_PRICE, payable ONLY by redeeming an ERC-7710 delegation chain
 * (assetTransferMethod: erc7710) through the MetaMask facilitator.
 */
export function makeGateway(payTo: `0x${string}`): Router {
  const router = express.Router();
  router.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
  router.use(express.json({ limit: "1mb" }));

  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    networkId,
    new x402ExactEvmErc7710ServerScheme(),
  );

  router.use(
    paymentMiddleware(
      {
        "POST /paid/inference": {
          accepts: [
            {
              scheme: "exact",
              price: INFERENCE_PRICE,
              network: networkId,
              payTo,
              extra: { assetTransferMethod: "erc7710" },
            },
          ],
          description: "One Venice AI inference request, paid via delegated USDC",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  router.post("/paid/inference", async (req: Request, res: Response) => {
    try {
      const settlementHeader = res.getHeader("PAYMENT-RESPONSE");
      paymentLog.push({
        at: new Date().toISOString(),
        route: "POST /paid/inference",
        settlement: typeof settlementHeader === "string" ? settlementHeader : undefined,
      });
      const result = await runInference(req.body as InferenceRequest);
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  return router;
}
