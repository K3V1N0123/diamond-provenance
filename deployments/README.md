# Deployment manifests

Running a deployment creates a JSON manifest in this directory. Its filename contains the Hardhat network name and chain ID, for example `localhost-31337.json` or `sepolia-11155111.json`.

Each manifest records the contract address, deployment block, transaction hash, deployer, bootstrapped roles, and ABI. The future frontend can use the address and deployment block to connect to the correct contract and limit event-history queries.

Generated manifest files are ignored by Git because local addresses are temporary and public deployments should be reviewed before their details are committed.
