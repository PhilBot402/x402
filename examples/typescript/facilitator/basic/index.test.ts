import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const evmPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// createKeyPairSignerFromBytes rejects a random 64-byte string. This keypair has no funds.
const svmPrivateKey =
  "3jXc2QFDxye1PZqUtCRLTMEHYCA8YwsY1AY6SjLppbMQ5XPw6jWWT8drn4A11rnLK4Bwm9fczecLLUdf74qakDXV";

const baseRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

type Requirements = typeof baseRequirements;

type Case = {
  name: string;
  path: "/verify" | "/settle";
  payload: unknown;
  requirements: Requirements;
  status?: number;
  reason?: string;
  notStatus?: number;
};

const listenPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const stopFacilitator = (child: ChildProcess) => {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
};

const startFacilitator = async () => {
  const port = await listenPort();
  const child = spawn("pnpm", ["exec", "tsx", "index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      EVM_PRIVATE_KEY: evmPrivateKey,
      SVM_PRIVATE_KEY: svmPrivateKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`facilitator did not listen\n${output}`));
    }, 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("Facilitator listening")) {
        return;
      }
      clearTimeout(timer);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`facilitator exited ${code}\n${output}`));
    });
  });
  await ready;
  return { port, child };
};

const post = async (port: number, item: Case) => {
  const response = await fetch(`http://127.0.0.1:${port}${item.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentPayload: {
        x402Version: 2,
        resource: { url: "http://127.0.0.1/x" },
        accepted: item.requirements,
        payload: item.payload,
      },
      paymentRequirements: item.requirements,
    }),
  });
  const text = await response.text();
  return { status: response.status, text };
};

const casesFor = (path: "/verify" | "/settle"): Case[] => [
  {
    name: `${path} empty object`,
    path,
    payload: {},
    requirements: baseRequirements,
    status: 400,
    reason:
      "paymentPayload.payload must include authorization or permit2Authorization",
  },
  {
    name: `${path} signature only`,
    path,
    payload: { signature: "0x" },
    requirements: baseRequirements,
    status: 400,
    reason:
      "paymentPayload.payload must include authorization or permit2Authorization",
  },
  {
    name: `${path} array`,
    path,
    payload: [1, 2],
    requirements: baseRequirements,
    status: 400,
    reason: "paymentPayload.payload must be an object",
  },
  {
    name: `${path} unregistered network`,
    path,
    payload: {},
    requirements: { ...baseRequirements, network: "eip155:8453" },
    status: 200,
    reason: "unsupported_scheme",
  },
  {
    name: `${path} upto`,
    path,
    payload: {},
    requirements: { ...baseRequirements, scheme: "upto" },
    status: 200,
    reason: "unsupported_payload_type",
  },
  {
    name: `${path} solana`,
    path,
    payload: {},
    requirements: {
      ...baseRequirements,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    },
    status: 200,
    reason: "invalid_exact_svm_payload_missing_fee_payer",
  },
  {
    name: `${path} empty authorization`,
    path,
    payload: { authorization: {} },
    requirements: baseRequirements,
    notStatus: 400,
  },
];

test("exact EVM payloads without an authorization field return 400", async () => {
  const facilitator = await startFacilitator();
  try {
    const cases = [...casesFor("/verify"), ...casesFor("/settle")];
    for (const item of cases) {
      const result = await post(facilitator.port, item);
      const label = `${item.name} ${result.text}`;
      if (item.notStatus !== undefined) {
        assert.notEqual(result.status, item.notStatus, label);
        continue;
      }
      assert.equal(result.status, item.status, label);
      const body = JSON.parse(result.text) as {
        error?: string;
        invalidReason?: string;
        errorReason?: string;
      };
      assert.equal(
        body.error ?? body.invalidReason ?? body.errorReason,
        item.reason,
        label,
      );
    }
  } finally {
    stopFacilitator(facilitator.child);
  }
});
