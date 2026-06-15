import type { NextRequest } from "next/server";

/*
 * Streaming proxy for the agent's Server-Sent-Events tape.
 *
 * The catch-all `rewrites()` in next.config.ts buffers `text/event-stream`
 * responses, so the whole tape arrived in one burst at the end of a run.
 * This route handler takes precedence over that rewrite for the events path
 * and pipes the upstream stream straight through — each event reaches the
 * browser the instant the agent emits it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4021";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  let upstream: Response;
  try {
    upstream = await fetch(`${SERVER_URL}/research/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      // forward client disconnects so the backend can detach its emitter
      signal: request.signal,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `upstream unreachable: ${(error as Error).message}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: `upstream responded ${upstream.status}` }), {
      status: upstream.status || 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // disable proxy buffering (nginx & friends) so events flush immediately
      "X-Accel-Buffering": "no",
    },
  });
}
