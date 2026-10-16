# Diamond Provenance Registry

This repository contains the tested `DiamondRegistry` smart contract, repeatable deployment tooling, a public verification page, direct MetaMask registration, signed EIP-712 registration through a relayer, consent-based custody transfers, and registry administration. The public Sepolia deployment is still to be completed.

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

Public verification remains read-only and does not request a wallet. Enter the lab address and inscription to see the current record, committed certificate details, and event-based custody timeline.

The lab workspace supports direct registration through MetaMask. Add the local network with RPC URL `http://127.0.0.1:8545` and chain ID `31337`, then import the private key for the local account granted `LAB_ROLE`. The report is hashed inside the browser; the file itself is never uploaded.

The same lab can choose **Sign attestation** to download a JSON approval that expires after seven days. A different wallet can connect, load that file under **Submit an attestation**, and pay the registration gas. The page checks the signature, target chain and contract, deadline, nonce, and current lab roles before enabling submission.

The custody workspace loads a diamond by its numeric record ID. The current custodian can propose or cancel a transfer, while the proposed recipient can accept or reject it. Custody changes only after acceptance, and both wallets must have `CUSTODIAN_ROLE` when the transfer is completed.

The admin workspace is enabled only for a wallet with `DEFAULT_ADMIN_ROLE`. It grants or revokes laboratory and custodian roles, quarantines active records, restores quarantined records, and permanently revokes quarantined records. Every record status change requires a reason, which is preserved in the on-chain event history.

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
