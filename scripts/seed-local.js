import { readFile } from "node:fs/promises";
import path from "node:path";
import { network } from "hardhat";

const { ethers } = await network.getOrCreate();
const manifestPath = path.resolve(
  process.env.DEPLOYMENT_FILE ?? "deployments/localhost-31337.json",
);
const deployment = JSON.parse(await readFile(manifestPath, "utf8"));
const [labAddress] = deployment.roles.labs;
const recipientAddress = deployment.roles.custodians.find((address) => address !== labAddress);

if (!labAddress) throw new Error("The deployment manifest has no configured lab");

const signers = await ethers.getSigners();
const signerByAddress = new Map(signers.map((signer) => [signer.address.toLowerCase(), signer]));
const labSigner = signerByAddress.get(labAddress.toLowerCase());
if (!labSigner) throw new Error(`No local signer is available for lab ${labAddress}`);

const registry = new ethers.Contract(deployment.address, deployment.abi, labSigner);
const inscriptionId = process.env.SAMPLE_INSCRIPTION ?? "GIA-2467891";
let id = await registry.findByInscription(labAddress, inscriptionId);

if (id === 0n) {
  const claim = {
    inscriptionId,
    reportHash: ethers.keccak256(ethers.toUtf8Bytes("facet-ledger-sample-report-v1")),
    origin: 1,
    caratMilli: 1250,
    color: "F",
    clarity: "VS1",
    cut: "Excellent",
    treatment: "None",
  };
  const registration = await registry.registerDiamond(claim);
  await registration.wait();
  id = await registry.findByInscription(labAddress, inscriptionId);
  console.log(`Registered sample diamond #${id}`);
} else {
  console.log(`Sample diamond #${id} already exists`);
}

if (recipientAddress) {
  const diamond = await registry.getDiamond(id);
  if (diamond.custodian.toLowerCase() === labAddress.toLowerCase()) {
    const recipientSigner = signerByAddress.get(recipientAddress.toLowerCase());
    if (!recipientSigner) throw new Error(`No local signer is available for ${recipientAddress}`);
    await (await registry.proposeTransfer(id, recipientAddress)).wait();
    await (await registry.connect(recipientSigner).acceptTransfer(id)).wait();
    console.log(`Transferred sample custody to ${recipientAddress}`);
  }
}

console.log(`Verify with lab ${labAddress} and inscription ${inscriptionId}`);
