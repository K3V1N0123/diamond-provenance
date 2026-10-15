import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifacts, network } from "hardhat";

const { ethers, networkName } = await network.getOrCreate();

function addressesFromEnvironment(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return [];

  return [...new Set(raw.split(",").map((value) => {
    const address = value.trim();
    if (!ethers.isAddress(address)) {
      throw new Error(`${name} contains an invalid address: ${address}`);
    }
    return ethers.getAddress(address);
  }))];
}

async function grantRole(registry, role, address, label) {
  if (await registry.hasRole(role, address)) return;
  const transaction = await registry.grantRole(role, address);
  await transaction.wait();
  console.log(`Granted ${label} to ${address}`);
}

const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("The selected network has no deployment account");

const labs = addressesFromEnvironment("LAB_ADDRESSES");
const explicitCustodians = addressesFromEnvironment("CUSTODIAN_ADDRESSES");
const custodians = [...new Set([...labs, ...explicitCustodians])];

console.log(`Deploying DiamondRegistry to ${networkName} from ${deployer.address}`);
const registry = await ethers.deployContract("DiamondRegistry");
await registry.waitForDeployment();

const deploymentTransaction = registry.deploymentTransaction();
if (deploymentTransaction === null) {
  throw new Error("Deployment transaction is unavailable");
}
const deploymentReceipt = await deploymentTransaction.wait();
if (deploymentReceipt === null) {
  throw new Error("Deployment receipt is unavailable");
}

const labRole = await registry.LAB_ROLE();
const custodianRole = await registry.CUSTODIAN_ROLE();
for (const address of labs) {
  await grantRole(registry, labRole, address, "LAB_ROLE");
}
for (const address of custodians) {
  await grantRole(registry, custodianRole, address, "CUSTODIAN_ROLE");
}

const chain = await ethers.provider.getNetwork();
const artifact = await artifacts.readArtifact("DiamondRegistry");
const deployment = {
  contractName: "DiamondRegistry",
  network: networkName,
  chainId: chain.chainId.toString(),
  address: await registry.getAddress(),
  deploymentBlock: deploymentReceipt.blockNumber,
  transactionHash: deploymentReceipt.hash,
  deployer: deployer.address,
  roles: {
    labs,
    custodians,
  },
  abi: artifact.abi,
};

const outputDirectory = path.resolve("deployments");
const outputPath = path.join(outputDirectory, `${networkName}-${chain.chainId}.json`);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(deployment, null, 2)}\n`);

console.log(`DiamondRegistry deployed at ${deployment.address}`);
console.log(`Deployment block: ${deployment.deploymentBlock}`);
console.log(`Manifest written to ${path.relative(process.cwd(), outputPath)}`);
