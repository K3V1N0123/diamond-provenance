# Diamond Provenance Registry

This repository contains the tested `DiamondRegistry` smart contract, repeatable deployment tooling, and a read-only public verification page. Wallet-based lab, custody, and admin panels and the public Sepolia deployment are still to be implemented.

## Install and test

```bash
npm install
npm test
```

The test suite runs against Hardhat's temporary in-memory blockchain. It does not spend real cryptocurrency.

## Deploy to a persistent local blockchain

Open two terminals. Start the local blockchain in the first:

```bash
npm run node
```

The node prints funded development accounts and their private keys. These keys are public test credentials and must never be used on a real network.

In the second terminal, optionally choose which local accounts receive roles and deploy:

```bash
export LAB_ADDRESSES=0xLAB_ADDRESS
export CUSTODIAN_ADDRESSES=0xMANUFACTURER_ADDRESS,0xRETAILER_ADDRESS
npm run deploy:local
```

Every address in `LAB_ADDRESSES` automatically receives both `LAB_ROLE` and `CUSTODIAN_ROLE`. The generated manifest under `deployments/` contains the address and starting block needed by the frontend.

## Export the ABI

```bash
npm run export:abi
```

This writes `generated/DiamondRegistry.abi.json`. The ABI describes the contract functions and events in a format ethers.js can use.

## Run the public verification page

Keep the local blockchain running and deploy the contract as described above. Convert its manifest into browser configuration, then start the frontend:

```bash
npm run frontend:prepare -- deployments/localhost-31337.json
npm run frontend:dev
```

The preparation step copies only public connection information and the ABI into `frontend/public/registry.json`. For a hosted testnet frontend, set `FRONTEND_RPC_URL` to a browser-accessible RPC endpoint before running it.

The first frontend slice is read-only and does not request a wallet. Enter the lab address and inscription to see the current record, committed certificate details, and event-based custody timeline.

To create a sample diamond and one accepted custody transfer on the running local chain, use:

```bash
npm run seed:local
```

The command prints the laboratory address and inscription to enter in the verification page.

## Sepolia preparation

Copy `.env.example` to `.env` as a reference, but export the real values in the terminal or store them with Hardhat's keystore. The required configuration variables are `SEPOLIA_RPC_URL` and `SEPOLIA_PRIVATE_KEY`.

After testing locally, deploy with:

```bash
npm run deploy:sepolia
```

This sends a real transaction and requires Sepolia ETH. Review the selected deployer and role addresses before running it.

The complete product design and security assumptions are documented in `diamond-provenance-dapp.md`.
