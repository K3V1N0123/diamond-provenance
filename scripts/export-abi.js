import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifacts } from "hardhat";

const artifact = await artifacts.readArtifact("DiamondRegistry");
const outputDirectory = path.resolve("generated");
const outputPath = path.join(outputDirectory, "DiamondRegistry.abi.json");

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact.abi, null, 2)}\n`);

console.log(`ABI written to ${path.relative(process.cwd(), outputPath)}`);
