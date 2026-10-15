import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const deploymentArgument = process.argv[2] ?? process.env.DEPLOYMENT_FILE;
if (!deploymentArgument) {
  throw new Error(
    "Provide a deployment manifest: npm run frontend:prepare -- deployments/localhost-31337.json",
  );
}

const deploymentPath = path.resolve(deploymentArgument);
const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
for (const field of ["network", "chainId", "address", "deploymentBlock", "abi"]) {
  if (deployment[field] === undefined) {
    throw new Error(`Deployment manifest is missing ${field}`);
  }
}

const rpcUrl = process.env.FRONTEND_RPC_URL
  ?? (deployment.network === "localhost" ? "http://127.0.0.1:8545" : undefined);
if (!rpcUrl) throw new Error("Set FRONTEND_RPC_URL for this network");

const browserConfig = {
  network: deployment.network,
  chainId: deployment.chainId,
  rpcUrl,
  contractAddress: deployment.address,
  deploymentBlock: deployment.deploymentBlock,
  abi: deployment.abi,
};
const outputPath = path.resolve("frontend/public/registry.json");
await writeFile(outputPath, `${JSON.stringify(browserConfig, null, 2)}\n`);

console.log(`Frontend configuration written to ${path.relative(process.cwd(), outputPath)}`);
