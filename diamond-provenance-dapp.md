# Diamond Provenance and Anti-Fraud Registry (DApp)

A decentralized application on Ethereum that records who certified a diamond, what origin they asserted, and who has held it since. A buyer verifies a stone against the chain instead of trusting a paper certificate. Labs can register stones either directly or by **signing an EIP-712 attestation** that anyone can submit on their behalf.

**Stack:** Solidity 0.8.x, OpenZeppelin (AccessControl, EIP712, ECDSA), Remix IDE, Ganache / Sepolia, MetaMask, HTML + JavaScript + ethers.js v6

---

## 1. Problem Statement

Diamond certificates are paper or PDF reports issued by grading labs such as GIA. They can be forged, and a forged report is enough to sell a natural diamond as lab-grown (CVD/HPHT), or the reverse, at a very different price. Recent fraud cases of exactly this kind show that a certificate on its own is not proof of origin.

Three weaknesses in the current system:

1. **Forgeable documents:** a PDF or printed report can be copied or edited.
2. **No shared source of truth:** each party in the chain keeps its own records.
3. **Weak traceability:** custody history is hard to reconstruct and easy to dispute.

## 2. Proposed Solution

Keep a tamper-evident record of every diamond on the Ethereum blockchain.

- Only an **authorised grading lab** can register a diamond, and the lab fixes its **origin** (Natural, Lab-grown CVD, Lab-grown HPHT). Origin, report hash, and the lab never change afterwards.
- A lab can register **directly** (it sends the transaction) or by **EIP-712 signature** (it signs a readable claim off-chain, and any wallet submits and pays gas). Both paths create identical records.
- A **laser inscription ID** on the stone's girdle links the physical diamond to its record.
- The issuing lab is the **first custodian**. Every later handover is a two-step transfer (sender proposes, recipient accepts), so nobody is assigned a stone without consent.
- A suspect record can be **quarantined**, then released or permanently revoked by the admin.
- Anyone can **verify** a stone for free, without a wallet.

A forged PDF fails because no matching record exists under a registered lab's address.

## 3. Scope

### In scope
- One smart contract with role-based access (`DiamondRegistry.sol`)
- Direct registration **and EIP-712 signed registration**
- Two-step custody transfer and a quarantine lifecycle
- Public verification page, plus lab, custody, and admin panels
- MetaMask integration with ethers.js
- Compile, deploy, and test in Remix against Ganache, then Sepolia

### Deliberately out of scope (and why)
| Left out | Reason |
|---|---|
| Role epochs, nonce-per-record, pause epochs | Edge-case hardening; recheck-at-acceptance covers the main transfer attack |
| Proposal deadlines, permissionless cleanup | A sender can always cancel a stuck proposal |
| Foundry, Anvil, PostgreSQL, event worker, read API | Assignment requires Remix + Ganache/testnet; history is read from events |
| Safe multisig, admin delay | Governance hardening for production; described under future work |
| Packed storage, custom error catalogue | Readability over gas optimisation; `require` messages are used |
| ERC-1271 smart-contract-wallet labs | Signed registration supports EOA labs only |
| Payments, marketplace, ERC-721, upgrades | Not needed to demonstrate provenance |

Manufacturing, cutting, exporting, and retailing are **display labels** on custodians, not separate permission systems. Recutting, splitting stones, re-inscription, and lost-key recovery need a separate protocol decision.

## 4. Actors and Roles

| Role | Who | Permissions |
|------|-----|-------------|
| `DEFAULT_ADMIN_ROLE` | Platform administrator | Grant/revoke roles, quarantine any record, release or revoke quarantined records |
| `LAB_ROLE` | Grading laboratory | Register diamonds (directly or by signature), quarantine its own records, invalidate its own signing nonces |
| `CUSTODIAN_ROLE` | Lab, manufacturer, cutter, exporter, retailer | Hold stones, propose and accept transfers |
| Relayer (any wallet) | Anyone | Submit a lab's signed attestation and pay gas; receives **no** authority |
| Public | Any buyer | Read-only verification |

A lab must hold **both** `LAB_ROLE` and `CUSTODIAN_ROLE`, because it starts as custodian. A role means "permitted to act now", not proof the organisation is honest. The admin can admit a dishonest lab; state this openly in the report.

## 5. Architecture

```
 Lab wallet ──signs typed data (no gas)──▶ attestation.json
                                                │
                                   any wallet submits + pays gas
                                                ▼
┌──────────────────────────────────────────────┐
│  Frontend (HTML/JS + ethers.js)              │
│  Lab | Submit | Custody | Verify | Admin     │
└───────────────┬──────────────────────────────┘
                │  MetaMask signs transactions
┌───────────────▼──────────────────────────────┐
│  DiamondRegistry.sol (Ganache / Sepolia)     │
│  - Current state: record, status, custodian  │
│  - Roles via OpenZeppelin AccessControl      │
│  - EIP-712 signature verification            │
│  - Events: full history and audit trail      │
└───────────────┬──────────────────────────────┘
                │  hash only (optional)
┌───────────────▼──────────────────────────────┐
│  IPFS or local file: full lab report         │
└──────────────────────────────────────────────┘
```

**State vs history:** the contract stores only current state. Every change emits an event, and the frontend rebuilds history with `queryFilter`. No database is required.

**Trust boundaries:** the chain is the authority for roles, signatures, and custody. The browser only hashes files, builds typed data, and submits transactions. The public verify page can use a read-only RPC connection with no wallet.

## 6. Identity and Data Model

### Canonical inscription rule
An inscription ID is 1 to 64 characters from `A-Z`, `0-9`, and `-`. The UI trims and uppercases input before confirmation (and **before the lab signs**). The **contract enforces the rule itself** and rejects anything else (lowercase, spaces, lookalike Unicode).

Inscriptions are **scoped per lab**:

```solidity
inscriptionKey = keccak256(abi.encode(lab, inscriptionId));
```

The same ID from two labs creates two separate claims. The inscription key and the report hash are both reserved per lab forever, even after revocation.

### Record structure
```solidity
enum Origin { Natural, LabGrownCVD, LabGrownHPHT }
enum Status { Active, Quarantined, Revoked }

struct Diamond {
    bytes32 inscriptionKey;
    bytes32 reportHash;      // keccak256 of the lab report file
    bytes32 metadataHash;    // EIP-712 hash of colour, clarity, cut, treatment
    address lab;             // immutable issuer
    address custodian;       // current holder
    uint64  registeredAt;
    uint32  caratMilli;      // 1.250 ct = 1250, allowed 1..1,000,000
    Origin  origin;          // immutable
    Status  status;
    bool    exists;
}
```

Colour, clarity, cut, and treatment are emitted in an event and committed by `metadataHash`, not stored as strings. Origin (growth method) and treatment are separate assertions.

## 7. Smart Contract (reference implementation)

File: `DiamondRegistry.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract DiamondRegistry is AccessControl, EIP712 {
    bytes32 public constant LAB_ROLE       = keccak256("LAB_ROLE");
    bytes32 public constant CUSTODIAN_ROLE = keccak256("CUSTODIAN_ROLE");

    // ---- EIP-712 type hashes (must match the frontend types exactly) ----
    bytes32 private constant DETAILS_TYPEHASH = keccak256(
        "Details(string color,string clarity,string cut,string treatment)"
    );
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "DiamondClaim(string inscriptionId,bytes32 reportHash,uint8 origin,uint32 caratMilli,Details details)"
        "Details(string color,string clarity,string cut,string treatment)"
    );
    bytes32 private constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address lab,DiamondClaim claim,uint256 nonce,uint64 deadline)"
        "Details(string color,string clarity,string cut,string treatment)"
        "DiamondClaim(string inscriptionId,bytes32 reportHash,uint8 origin,uint32 caratMilli,Details details)"
    );

    enum Origin { Natural, LabGrownCVD, LabGrownHPHT }
    enum Status { Active, Quarantined, Revoked }

    struct Diamond {
        bytes32 inscriptionKey;
        bytes32 reportHash;
        bytes32 metadataHash;
        address lab;
        address custodian;
        uint64  registeredAt;
        uint32  caratMilli;
        Origin  origin;
        Status  status;
        bool    exists;
    }

    struct RegistrationInput {
        string  inscriptionId;
        bytes32 reportHash;
        Origin  origin;
        uint32  caratMilli;
        string  color;
        string  clarity;
        string  cut;
        string  treatment;
    }

    uint256 public nextId = 1;

    mapping(uint256 => Diamond)  private diamonds;
    mapping(uint256 => address)  public  pendingTo;       // one proposal per stone
    mapping(bytes32 => uint256)  public  idByKey;         // inscriptionKey => id (0 = none)
    mapping(address => mapping(bytes32 => bool)) public reportUsed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed; // lab => nonce => used

    event DiamondRegistered(
        uint256 indexed id,
        address indexed lab,
        string inscriptionId,
        Origin origin,
        uint32 caratMilli
    );
    event DiamondDetails(
        uint256 indexed id,
        string color,
        string clarity,
        string cut,
        string treatment
    );
    event RegistrationRelayed(uint256 indexed id, address indexed lab, address indexed relayer);
    event NonceInvalidated(address indexed lab, uint256 nonce);
    event TransferProposed(uint256 indexed id, address indexed from, address indexed to);
    event TransferAccepted(uint256 indexed id, address indexed from, address indexed to);
    event TransferCancelled(uint256 indexed id, address indexed by);
    event TransferRejected(uint256 indexed id, address indexed by);
    event StatusChanged(uint256 indexed id, Status status, address indexed by, string reason);

    constructor() EIP712("DiamondProvenance", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ---------- Registration: direct path ----------

    function registerDiamond(RegistrationInput calldata r) external returns (uint256 id) {
        id = _register(msg.sender, r);
    }

    // ---------- Registration: EIP-712 signed path ----------

    function registerWithSignature(
        address lab,
        RegistrationInput calldata r,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external returns (uint256 id) {
        require(block.timestamp <= deadline, "Signature expired");
        require(!nonceUsed[lab][nonce], "Nonce used");

        bytes32 digest = _hashTypedDataV4(_registrationHash(lab, r, nonce, deadline));
        require(ECDSA.recover(digest, signature) == lab, "Bad signature");

        nonceUsed[lab][nonce] = true;
        id = _register(lab, r);   // lab stays issuer AND first custodian; relayer gets nothing
        emit RegistrationRelayed(id, lab, msg.sender);
    }

    /// Lab cancels a signed attestation it has not yet submitted.
    function invalidateNonce(uint256 nonce) external {
        require(!nonceUsed[msg.sender][nonce], "Nonce used");
        nonceUsed[msg.sender][nonce] = true;
        emit NonceInvalidated(msg.sender, nonce);
    }

    /// Debug helper: compare with ethers' TypedDataEncoder.hash(domain, types, value).
    function registrationDigest(
        address lab,
        RegistrationInput calldata r,
        uint256 nonce,
        uint64 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_registrationHash(lab, r, nonce, deadline));
    }

    // ---------- Custody (two-step transfer) ----------

    function proposeTransfer(uint256 id, address to) external {
        Diamond storage d = _active(id);
        require(d.custodian == msg.sender, "Not custodian");
        require(hasRole(CUSTODIAN_ROLE, msg.sender), "Sender not authorised");
        require(to != address(0) && to != msg.sender, "Invalid recipient");
        require(hasRole(CUSTODIAN_ROLE, to), "Recipient not authorised");
        require(pendingTo[id] == address(0), "Proposal already exists");

        pendingTo[id] = to;
        emit TransferProposed(id, msg.sender, to);
    }

    function acceptTransfer(uint256 id) external {
        Diamond storage d = _active(id);
        require(pendingTo[id] == msg.sender, "No proposal for you");
        // Recheck BOTH parties at acceptance, not only at proposal
        require(hasRole(CUSTODIAN_ROLE, msg.sender), "Recipient not authorised");
        require(hasRole(CUSTODIAN_ROLE, d.custodian), "Sender not authorised");

        address from = d.custodian;
        d.custodian = msg.sender;
        delete pendingTo[id];
        emit TransferAccepted(id, from, msg.sender);
    }

    function cancelTransfer(uint256 id) external {
        Diamond storage d = _known(id);
        require(d.custodian == msg.sender, "Not custodian");
        require(pendingTo[id] != address(0), "No proposal");
        delete pendingTo[id];
        emit TransferCancelled(id, msg.sender);
    }

    function rejectTransfer(uint256 id) external {
        _known(id);
        require(pendingTo[id] == msg.sender, "No proposal for you");
        delete pendingTo[id];
        emit TransferRejected(id, msg.sender);
    }

    // ---------- Quarantine lifecycle ----------

    function quarantine(uint256 id, string calldata reason) external {
        Diamond storage d = _known(id);
        require(d.status == Status.Active, "Not active");
        require(bytes(reason).length > 0, "Reason required");

        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        bool isLiveIssuer = msg.sender == d.lab && hasRole(LAB_ROLE, msg.sender);
        require(isAdmin || isLiveIssuer, "Not allowed");

        d.status = Status.Quarantined;
        delete pendingTo[id];               // frozen stones carry no open proposal
        emit StatusChanged(id, Status.Quarantined, msg.sender, reason);
    }

    function resolveQuarantine(uint256 id, string calldata reason)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Diamond storage d = _known(id);
        require(d.status == Status.Quarantined, "Not quarantined");
        require(bytes(reason).length > 0, "Reason required");
        d.status = Status.Active;
        emit StatusChanged(id, Status.Active, msg.sender, reason);
    }

    function revokeRecord(uint256 id, string calldata reason)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Diamond storage d = _known(id);
        require(d.status == Status.Quarantined, "Quarantine first");
        require(bytes(reason).length > 0, "Reason required");
        d.status = Status.Revoked;          // terminal; record and reservations stay
        emit StatusChanged(id, Status.Revoked, msg.sender, reason);
    }

    // ---------- Public reads ----------

    function getDiamond(uint256 id) external view returns (Diamond memory) {
        return _known(id);
    }

    function findByInscription(address lab, string calldata inscriptionId)
        external
        view
        returns (uint256)
    {
        require(_validInscription(inscriptionId), "Bad inscription");
        return idByKey[keccak256(abi.encode(lab, inscriptionId))]; // 0 = not found
    }

    // ---------- Internal: shared registration logic ----------

    function _register(address lab, RegistrationInput calldata r) internal returns (uint256 id) {
        require(hasRole(LAB_ROLE, lab), "Not a lab");
        require(hasRole(CUSTODIAN_ROLE, lab), "Lab must be custodian");
        require(_validInscription(r.inscriptionId), "Bad inscription");
        require(r.reportHash != bytes32(0), "Empty report hash");
        require(r.caratMilli >= 1 && r.caratMilli <= 1_000_000, "Carat out of range");

        bytes32 key = keccak256(abi.encode(lab, r.inscriptionId));
        require(idByKey[key] == 0, "Duplicate inscription");
        require(!reportUsed[lab][r.reportHash], "Duplicate report");

        id = nextId++;
        idByKey[key] = id;
        reportUsed[lab][r.reportHash] = true;

        Diamond storage d = diamonds[id];
        d.inscriptionKey = key;
        d.reportHash     = r.reportHash;
        d.metadataHash   = _detailsHash(r);
        d.lab            = lab;
        d.custodian      = lab;             // issuing lab is the first custodian
        d.registeredAt   = uint64(block.timestamp);
        d.caratMilli     = r.caratMilli;
        d.origin         = r.origin;
        d.status         = Status.Active;
        d.exists         = true;

        emit DiamondRegistered(id, lab, r.inscriptionId, r.origin, r.caratMilli);
        emit DiamondDetails(id, r.color, r.clarity, r.cut, r.treatment);
    }

    // ---------- Internal: EIP-712 hashing (nested structs keep it readable in MetaMask) ----------

    function _detailsHash(RegistrationInput calldata r) private pure returns (bytes32) {
        return keccak256(abi.encode(
            DETAILS_TYPEHASH,
            keccak256(bytes(r.color)),
            keccak256(bytes(r.clarity)),
            keccak256(bytes(r.cut)),
            keccak256(bytes(r.treatment))
        ));
    }

    function _registrationHash(
        address lab,
        RegistrationInput calldata r,
        uint256 nonce,
        uint64 deadline
    ) private pure returns (bytes32) {
        bytes32 claimHash = keccak256(abi.encode(
            CLAIM_TYPEHASH,
            keccak256(bytes(r.inscriptionId)),
            r.reportHash,
            uint8(r.origin),
            r.caratMilli,
            _detailsHash(r)
        ));
        return keccak256(abi.encode(REGISTRATION_TYPEHASH, lab, claimHash, nonce, deadline));
    }

    // ---------- Internal: helpers ----------

    function _known(uint256 id) private view returns (Diamond storage d) {
        d = diamonds[id];
        require(d.exists, "Unknown diamond");
    }

    function _active(uint256 id) private view returns (Diamond storage d) {
        d = _known(id);
        require(d.status == Status.Active, "Record not active");
    }

    function _validInscription(string calldata s) private pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > 64) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39)   // 0-9
                   || (c >= 0x41 && c <= 0x5A)   // A-Z
                   || c == 0x2D;                 // hyphen
            if (!ok) return false;
        }
        return true;
    }
}
```

### Design decisions
- **No `initialOwner` parameter:** the issuing lab is always the first custodian, so nobody receives a stone without consenting. This holds on **both** registration paths.
- **One internal `_register`:** direct and signed registration share the same code, so the records are identical by construction.
- **Both parties rechecked at acceptance:** a custodian whose role was revoked mid-proposal cannot complete or receive a transfer. Revoked holders also cannot propose.
- **One proposal per stone:** a new proposal cannot overwrite an existing one. The holder must cancel or the recipient must reject first.
- **Original lab must be live to quarantine its own record:** a revoked lab cannot flag. The admin remains the recovery path.
- **Quarantine is not a dead end:** Active, Quarantined, and Revoked are separate states with a reason recorded for every change. Revocation is terminal and keeps the original record.
- **History in events, not storage:** the contract keeps current state only, which keeps gas low and avoids returning unbounded arrays.
- **No upgrade proxy:** the contract cannot be silently changed. A defect means redeploying and migrating.
- **No force-transfer function:** nobody, including the admin, can reassign custody.
- **Strings in `require`:** readable revert messages instead of custom errors.

## 8. Signed Laboratory Registrations (EIP-712)

### Why
Without signatures the lab must send every registration transaction itself and pay gas. With EIP-712 a lab can approve a whole batch of stones in one sitting without sending a transaction, and a staff wallet or platform account can submit them later. The lab still controls exactly what is registered, because the signature covers every field.

### Flow
1. The lab fills in the stone details in the UI. The UI trims, uppercases, and validates the inscription ID.
2. MetaMask shows a **structured, human-readable prompt** (lab, inscription ID, origin, carat, colour, clarity, and so on) and the lab signs it. No gas, no transaction.
3. The UI saves an **attestation JSON** file (claim, nonce, deadline, signature).
4. Any wallet opens the Submit page, loads the file, and calls `registerWithSignature(...)`, paying gas.
5. The contract rebuilds the digest from the submitted fields, recovers the signer, and requires it to equal `lab`. It then runs the same `_register` logic as the direct path.

The submitter receives no custody and no role. The `RegistrationRelayed` event records who relayed it, so the verify page can show "registered by lab" or "registered by lab, relayed by 0x...".

### Exact typed data
Domain: `name = "DiamondProvenance"`, `version = "1"`, `chainId` = the target chain, `verifyingContract` = the deployed registry. The frontend can read these from the contract with `registry.eip712Domain()` instead of hard-coding them.

```text
Registration(address lab,DiamondClaim claim,uint256 nonce,uint64 deadline)
DiamondClaim(string inscriptionId,bytes32 reportHash,uint8 origin,uint32 caratMilli,Details details)
Details(string color,string clarity,string cut,string treatment)
```

Nested structs keep the wallet prompt readable and keep each hash computation small enough to avoid Solidity's "stack too deep" error. The type strings in Solidity and the `types` object in TypeScript must match field for field and in the same order.

### What the contract enforces
| Protection | How |
|---|---|
| Wrong chain or contract | Domain separator binds chainId and verifying contract; a signature for Ganache fails on Sepolia |
| Tampered fields | Digest covers every field; changing carat, origin, colour, or report hash changes the digest and recovery fails |
| Replay | Per-lab `nonce`, marked used on submission; the same attestation cannot be submitted twice |
| Stale approval | `deadline` checked on submission; the lab can also call `invalidateNonce` to cancel an unsubmitted attestation |
| Signer no longer authorised | `_register` rechecks `LAB_ROLE` and `CUSTODIAN_ROLE` for the lab at submission time |
| Relayer abuse | Relayer gets no rights; the lab is issuer and first custodian |

Nonces are **unordered**: the lab picks any unused number (a random 128-bit value works), so a batch of attestations can be submitted in any order.

### Known limitations
- **Revoke then regrant:** because role epochs were cut, a lab that is revoked and later regranted could have an old, unexpired attestation become valid again. The deadline limits the window and `invalidateNonce` closes it; state this in the report.
- **EOA labs only:** `ECDSA.recover` does not support smart-contract wallets (ERC-1271).
- **Signing garbage:** the signature proves the lab approved the claim, not that the claim is true. The trust assumption in the lab is unchanged.

### Debugging "Bad signature"
The most common causes are a domain mismatch (name, version, chainId, verifyingContract), a type-string mismatch, or changed whitespace in a field. Call `registrationDigest(...)` on the contract and compare it with `TypedDataEncoder.hash(domain, types, value)` from ethers; the two must be identical. Also note that Ganache's chain ID (commonly 1337) can differ from its network ID (5777); use the chain ID MetaMask reports.

## 9. Custody State Machine

```text
Active, no proposal
  -- custodian proposes --> Active, proposal pending
Active, proposal pending
  -- recipient accepts --> Active, new custodian
  -- custodian cancels / recipient rejects --> Active, no proposal
Active (any proposal state)
  -- lab or admin quarantines --> Quarantined (proposal cleared)
Quarantined
  -- admin resolves --> Active
  -- admin revokes --> Revoked (terminal)
```

A transfer means the recipient's wallet acknowledges the reported handover. It does **not** prove physical delivery or legal title; that still needs a real-world inspection and handover process.

An erroneous origin is never silently edited. Quarantine and revoke the record, show the reason, and keep the evidence. Do not work around the uniqueness rule by adding punctuation to an inscription.

## 10. Frontend Implementation

### Pages
1. **Connect wallet:** shows address and role (checks `hasRole` for each role).
2. **Lab panel:** two actions: **Register directly** (sends a transaction) and **Sign attestation** (EIP-712, downloads JSON). The report file is hashed in the browser, and the inscription ID is normalised and shown for confirmation.
3. **Submit page:** load an attestation JSON, verify the signature locally, then submit it on-chain.
4. **Custody panel:** shows stones held by the wallet, with Propose, Accept, Cancel, and Reject buttons.
5. **Verify page (public):** enter lab address and inscription ID, or scan a QR code. Shows origin, carat, lab, status, current custodian, whether it was relayed, and the timeline. Works with a read-only RPC provider and needs no wallet.
6. **Admin panel:** grant and revoke roles, quarantine, resolve, revoke.
7. **Audit log:** live feed of contract events.

Every screen shows the chain, contract address, and latest block it read from, so users can see how fresh the data is.

### Direct registration and verification (ethers v6)
```javascript
import {
  BrowserProvider, JsonRpcProvider, Contract,
  keccak256, randomBytes, hexlify, verifyTypedData, TypedDataEncoder,
} from "ethers";

const provider = new BrowserProvider(window.ethereum);
await provider.send("eth_requestAccounts", []);
const signer = await provider.getSigner();
const registry = new Contract(REGISTRY_ADDRESS, ABI, signer);

async function hashFile(file) {
  return keccak256(new Uint8Array(await file.arrayBuffer()));
}

const input = {
  inscriptionId: "GIA-2467891",          // already trimmed + uppercased
  reportHash: await hashFile(pdfFile),
  origin: 1,                             // 0 Natural, 1 CVD, 2 HPHT
  caratMilli: 1250,
  color: "F", clarity: "VS1", cut: "Excellent", treatment: "None",
};

// Direct path
await (await registry.registerDiamond(input)).wait();
```

### Signed registration: lab signs
```javascript
const f = await registry.eip712Domain();            // avoids hard-coding the domain
const domain = {
  name: f.name, version: f.version,
  chainId: f.chainId, verifyingContract: f.verifyingContract,
};

const types = {
  Registration: [
    { name: "lab",      type: "address" },
    { name: "claim",    type: "DiamondClaim" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  DiamondClaim: [
    { name: "inscriptionId", type: "string" },
    { name: "reportHash",    type: "bytes32" },
    { name: "origin",        type: "uint8" },
    { name: "caratMilli",    type: "uint32" },
    { name: "details",       type: "Details" },
  ],
  Details: [
    { name: "color",     type: "string" },
    { name: "clarity",   type: "string" },
    { name: "cut",       type: "string" },
    { name: "treatment", type: "string" },
  ],
};

const lab = await signer.getAddress();
const nonce = BigInt(hexlify(randomBytes(16)));                 // unordered, random
const deadline = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days

const value = {
  lab,
  claim: {
    inscriptionId: input.inscriptionId,
    reportHash: input.reportHash,
    origin: input.origin,
    caratMilli: input.caratMilli,
    details: {
      color: input.color, clarity: input.clarity,
      cut: input.cut, treatment: input.treatment,
    },
  },
  nonce,
  deadline,
};

const signature = await signer.signTypedData(domain, types, value);

// Save as attestation.json (BigInts become strings)
const attestation = {
  chainId: domain.chainId.toString(),
  registry: REGISTRY_ADDRESS,
  lab,
  input,
  nonce: nonce.toString(),
  deadline,
  signature,
};
download("attestation.json", JSON.stringify(attestation, null, 2));
```

### Signed registration: any wallet submits
```javascript
const a = JSON.parse(await file.text());

// Local sanity check before paying gas
const f = await registry.eip712Domain();
const recovered = verifyTypedData(
  { name: f.name, version: f.version, chainId: f.chainId, verifyingContract: f.verifyingContract },
  types,
  {
    lab: a.lab,
    claim: {
      inscriptionId: a.input.inscriptionId, reportHash: a.input.reportHash,
      origin: a.input.origin, caratMilli: a.input.caratMilli,
      details: {
        color: a.input.color, clarity: a.input.clarity,
        cut: a.input.cut, treatment: a.input.treatment,
      },
    },
    nonce: BigInt(a.nonce),
    deadline: a.deadline,
  },
  a.signature
);
if (recovered.toLowerCase() !== a.lab.toLowerCase()) throw new Error("Signature does not match lab");

await (await registry.registerWithSignature(
  a.lab, a.input, BigInt(a.nonce), a.deadline, a.signature
)).wait();
```

### Public verification without a wallet
```javascript
const readProvider = new JsonRpcProvider(RPC_URL);
const reader = new Contract(REGISTRY_ADDRESS, ABI, readProvider);

const id = await reader.findByInscription(labAddress, "GIA-2467891");
if (id > 0n) {
  const d = await reader.getDiamond(id);

  // History comes from events, not storage
  const registered = await reader.queryFilter(reader.filters.DiamondRegistered(id));
  const relayed    = await reader.queryFilter(reader.filters.RegistrationRelayed(id));
  const moves      = await reader.queryFilter(reader.filters.TransferAccepted(id));
  const decisions  = await reader.queryFilter(reader.filters.StatusChanged(id));
}
```

**QR code:** encode `https://yourapp/verify?lab=0x...&inscription=GIA-2467891`; the verify page reads these parameters on load.

**Revert messages:** show the `require` text from failed transactions in the UI so users see why an action was rejected.

## 11. Build and Deployment Steps

1. **Compile:** in Remix, create `DiamondRegistry.sol`, paste the contract, and compile with 0.8.20 or later (optimizer on). OpenZeppelin imports resolve automatically. If the compiler reports "stack too deep", enable *Via IR* under Advanced Compiler Configuration.
2. **Local network:** start Ganache and add it to MetaMask (RPC `http://127.0.0.1:7545`). Import several Ganache accounts: Admin, Lab, Manufacturer, Retailer, and an extra Relayer.
3. **Deploy:** in Remix choose *Injected Provider - MetaMask* and deploy from the admin account.
4. **Assign roles** from the admin account:
   - `grantRole(LAB_ROLE, lab)` and `grantRole(CUSTODIAN_ROLE, lab)`
   - `grantRole(CUSTODIAN_ROLE, manufacturer)` and the same for the retailer
5. **Run the full flow:** direct registration, signed registration via the relayer account, propose, accept, verify, quarantine, resolve, revoke.
6. **Testnet:** switch MetaMask to Sepolia, fund with a faucet, redeploy, and verify the source on Etherscan. Sign attestations again on Sepolia, since signatures from Ganache will not validate there.
7. **Frontend:** paste the address and ABI into the config and host on Vercel or GitHub Pages.

## 12. Test Plan

| # | Test | Expected result |
|---|------|-----------------|
| 1 | Lab with both roles registers a valid stone directly | Success; lab is custodian; `DiamondRegistered` emitted |
| 2 | Account without `LAB_ROLE` registers | Reverts "Not a lab" |
| 3 | Lab missing `CUSTODIAN_ROLE` registers | Reverts "Lab must be custodian" |
| 4 | Lowercase, spaced, or 65-character inscription | Reverts "Bad inscription" |
| 5 | Carat 0 or above 1,000,000 | Reverts "Carat out of range" |
| 6 | Same lab, duplicate inscription | Reverts "Duplicate inscription" |
| 7 | Same lab, duplicate report hash | Reverts "Duplicate report" |
| 8 | Different lab, same inscription ID | Succeeds as a separate claim |
| 9 | Custodian proposes to a trader | Pending set, `TransferProposed` emitted |
| 10 | Non-custodian proposes | Reverts "Not custodian" |
| 11 | Propose to account without role | Reverts "Recipient not authorised" |
| 12 | Second proposal while one is pending | Reverts "Proposal already exists" |
| 13 | Wrong account accepts | Reverts "No proposal for you" |
| 14 | Recipient accepts | Custodian changes, pending cleared |
| 15 | Recipient's role revoked, then accept | Reverts "Recipient not authorised" |
| 16 | Sender's role revoked, then propose or accept | Reverts |
| 17 | Custodian cancels; recipient rejects | Pending cleared, event emitted |
| 18 | Lab quarantines its own stone | Status Quarantined, pending cleared |
| 19 | Lab's role revoked, then it quarantines | Reverts "Not allowed"; admin still can |
| 20 | Transfer attempted on quarantined stone | Reverts "Record not active" |
| 21 | Non-admin resolves or revokes | Reverts |
| 22 | Admin resolves quarantine | Status Active |
| 23 | Admin revokes without quarantining first | Reverts "Quarantine first" |
| 24 | Admin revokes quarantined stone | Status Revoked; terminal |
| 25 | Origin and report hash after many transfers | Unchanged |
| 26 | Lookup of unknown inscription | Returns 0 |
| 27 | Lab signs; a different wallet relays it | Success; lab is issuer and custodian; relayer holds nothing; `RegistrationRelayed` emitted |
| 28 | Submit the same attestation twice | Reverts "Nonce used" |
| 29 | Submit after the deadline | Reverts "Signature expired" |
| 30 | Relayer changes carat, origin, colour, or report hash | Reverts "Bad signature" |
| 31 | Signature made for a different chain or contract | Reverts "Bad signature" |
| 32 | Signer without `LAB_ROLE` signs a valid claim | Reverts "Not a lab" |
| 33 | Lab's role revoked after signing, before submission | Reverts "Not a lab" |
| 34 | Lab calls `invalidateNonce`, then attestation is submitted | Reverts "Nonce used" |
| 35 | Register the same claim directly and by signature (two labs) | Records match in every field except lab and inscription key |
| 36 | `registrationDigest` vs ethers `TypedDataEncoder.hash` | Identical |

These behaviors are now covered by the Hardhat suite in `test/DiamondRegistry.test.js` (41 passing tests). A gas report and Slither scan remain future verification work.

## 13. Security Notes and Limitations

- **Access control:** every sensitive function checks a role or custody.
- **No ETH handling:** the contract holds no funds and makes no external calls, so reentrancy risk is minimal.
- **Signature safety:** the digest is domain-separated, covers every field, and uses an unordered per-lab nonce plus a deadline. Use OpenZeppelin's `ECDSA` and `EIP712` rather than custom assembly.
- **Duplicate detection is limited:** it catches exact-byte-identical reports and repeated inscriptions per lab only. It does **not** stop physical clones, rewritten reports, or the same stone registered by two labs. Do not claim otherwise.
- **Oracle problem:** the chain cannot prove the physical stone matches its record. The laser inscription plus a trusted lab as sole registrar bridges that gap, but a dishonest lab remains possible.
- **Admin trust:** the admin can admit a dishonest lab, revoke roles, and revoke records, but cannot rewrite custody, origin, or report commitments. Publish these powers in the README.
- **Lost keys:** a lost custodian key strands the stone. A leaked lab key lets an attacker sign claims until the admin revokes the role.
- **Role revocation:** revoking a role does not move stones. The holder simply cannot transfer until re-authorised.
- **Privacy:** only non-sensitive attributes are public; colour, clarity, cut, and treatment appear in events, and report files stay off-chain.

## 14. Future Work

- ERC-1271 support so a lab can sign from a smart-contract wallet
- Role epochs so revoke-then-regrant cannot revive old transfers or old attestations
- Proposal expiry and permissionless cleanup
- Pausable emergency stop with a guardian role
- Safe multisig admin with a delayed admin transfer
- Batch registration of many attestations in one transaction
- ERC-721 representation of stones
- Indexer and database for fast search
- Foundry fuzz and invariant tests

## 15. Resume Summary

> Built and locally tested a role-based diamond provenance registry using Solidity, OpenZeppelin, Hardhat, and ethers.js. The 41-test suite covers lab-only registration, EIP-712 signed attestations, replay and expiry protection, immutable provenance, consent-based custody transfers, access control, and quarantine/revocation. Deployment manifests, ABI export, local demo seeding, and the read-only public verification page are implemented. Wallet-based lab, custody, and admin panels and the Sepolia deployment remain.

## 16. Suggested Repository Structure

```
diamond-provenance-dapp/
├── contracts/
│   └── DiamondRegistry.sol
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── typedData.js         # shared EIP-712 domain/types
│   └── abi.json
├── attestations/
│   └── sample-attestation.json
├── test/
│   └── DiamondRegistry.test.js
├── docs/
│   ├── architecture.png
│   └── screenshots/
└── README.md
```
