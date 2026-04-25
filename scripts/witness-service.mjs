import { createSettlementWitnessHttpServer } from "../src/index.js";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || "7420");
const statePath =
  process.env.X402_SETTLEMENT_STATE_PATH?.trim() ||
  new URL("../data/settlement-state.json", import.meta.url).pathname;

const server = createSettlementWitnessHttpServer({ statePath });

server.listen(port, host, () => {
  console.log(
    JSON.stringify(
      {
        ok: true,
        host,
        port,
        statePath,
        healthUrl: `http://${host}:${port}/health`,
        rootUrl: `http://${host}:${port}/root`
      },
      null,
      2
    )
  );
});
