import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  ZeroAddress,
  ZeroHash,
  getAddress,
  hexlify,
  id,
  isAddress,
  keccak256,
  randomBytes,
  verifyTypedData,
} from "ethers";
import "./styles.css";

const ORIGINS = ["Natural", "Lab-grown CVD", "Lab-grown HPHT"];
const STATUSES = ["Active", "Quarantined", "Revoked"];
const LAB_ROLE = id("LAB_ROLE");
const CUSTODIAN_ROLE = id("CUSTODIAN_ROLE");
const REGISTRATION_TYPES = {
  Registration: [
    { name: "lab", type: "address" },
    { name: "claim", type: "DiamondClaim" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  DiamondClaim: [
    { name: "inscriptionId", type: "string" },
    { name: "reportHash", type: "bytes32" },
    { name: "origin", type: "uint8" },
    { name: "caratMilli", type: "uint32" },
    { name: "details", type: "Details" },
  ],
  Details: [
    { name: "color", type: "string" },
    { name: "clarity", type: "string" },
    { name: "cut", type: "string" },
    { name: "treatment", type: "string" },
  ],
};
const DETAILS_TYPES = {
  Details: REGISTRATION_TYPES.Details,
};

const elements = Object.fromEntries([
  "network-status", "network-label", "verify-form", "verify-button", "lab-address",
  "inscription-id", "form-message", "result", "result-inscription", "record-status",
  "record-origin", "record-carat", "record-date", "record-id", "certificate-details",
  "metadata-check", "record-lab", "record-custodian", "record-report", "freshness",
  "timeline", "configuration-error", "configuration-message", "connect-wallet",
  "wallet-summary", "direct-registration-form", "registration-fields", "report-file",
  "report-hash", "registration-inscription", "registration-origin", "registration-carat",
  "registration-color", "registration-clarity", "registration-cut",
  "registration-treatment", "registration-message", "register-button",
  "sign-attestation-button", "relayer-form", "relayer-fields", "attestation-file",
  "attestation-summary", "attestation-lab", "attestation-inscription",
  "attestation-deadline", "relayer-message", "relay-button",
  "custody-load-form", "custody-fields", "custody-record-id", "load-custody-button",
  "custody-record", "custody-status", "custody-current", "custody-pending",
  "proposal-form", "custody-recipient", "propose-transfer-button",
  "cancel-transfer-button", "reject-transfer-button", "accept-transfer-button",
  "custody-message",
  "admin-fields", "admin-message", "role-form", "role-address", "role-type",
  "grant-role-button", "revoke-role-button", "role-message", "admin-record-form",
  "admin-record-id", "load-admin-record-button", "admin-record-summary",
  "admin-record-status", "admin-record-lab", "admin-reason", "quarantine-button",
  "resolve-button", "revoke-record-button", "admin-record-message",
].map((id) => [id, document.getElementById(id)]));

let config;
let provider;
let registry;
let walletRegistry;
let walletAddress;
let walletSigner;
let loadedAttestation;
let loadedCustodyId;
let walletIsCustodian = false;
let walletIsAdmin = false;
let loadedAdminRecordId;

function shortenAddress(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function normalizeInscription(value) {
  return value.trim().toUpperCase();
}

function setMessage(message, tone = "") {
  elements["form-message"].textContent = message;
  elements["form-message"].dataset.tone = tone;
}

function setRegistrationMessage(message, tone = "") {
  elements["registration-message"].textContent = message;
  elements["registration-message"].dataset.tone = tone;
}

function setRelayerMessage(message, tone = "") {
  elements["relayer-message"].textContent = message;
  elements["relayer-message"].dataset.tone = tone;
}

function setCustodyMessage(message, tone = "") {
  elements["custody-message"].textContent = message;
  elements["custody-message"].dataset.tone = tone;
}

function setAdminMessage(message, tone = "") {
  elements["admin-message"].textContent = message;
  elements["admin-message"].dataset.tone = tone;
}

function setRoleMessage(message, tone = "") {
  elements["role-message"].textContent = message;
  elements["role-message"].dataset.tone = tone;
}

function setAdminRecordMessage(message, tone = "") {
  elements["admin-record-message"].textContent = message;
  elements["admin-record-message"].dataset.tone = tone;
}

function readableError(error) {
  return error.shortMessage ?? error.reason ?? error.info?.error?.message ?? error.message;
}

async function hashReport(file) {
  return keccak256(new Uint8Array(await file.arrayBuffer()));
}

function registrationValue(lab, input, nonce, deadline) {
  return {
    lab,
    claim: {
      inscriptionId: input.inscriptionId,
      reportHash: input.reportHash,
      origin: input.origin,
      caratMilli: input.caratMilli,
      details: {
        color: input.color,
        clarity: input.clarity,
        cut: input.cut,
        treatment: input.treatment,
      },
    },
    nonce,
    deadline,
  };
}

async function eip712Domain(contract) {
  const domain = await contract.eip712Domain();
  return {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
}

async function registrationInputFromForm() {
  const inscriptionId = normalizeInscription(elements["registration-inscription"].value);
  const caratText = elements["registration-carat"].value.trim();
  const [reportFile] = elements["report-file"].files;
  elements["registration-inscription"].value = inscriptionId;

  if (!/^[A-Z0-9-]{1,64}$/.test(inscriptionId)) {
    throw new Error("The inscription may contain only A–Z, 0–9, and hyphens.");
  }
  if (!/^\d+(\.\d{1,3})?$/.test(caratText)) {
    throw new Error("Carat weight must use at most three decimal places.");
  }
  const caratMilli = Math.round(Number(caratText) * 1000);
  if (caratMilli < 1 || caratMilli > 1_000_000) {
    throw new Error("Carat weight must be between 0.001 and 1000.");
  }
  if (!reportFile) throw new Error("Choose the grading report file.");

  const details = {
    color: elements["registration-color"].value.trim(),
    clarity: elements["registration-clarity"].value.trim(),
    cut: elements["registration-cut"].value.trim(),
    treatment: elements["registration-treatment"].value.trim(),
  };
  for (const [field, value] of Object.entries(details)) {
    if (!value) throw new Error(`Enter the diamond ${field}.`);
  }

  return {
    inscriptionId,
    reportHash: await hashReport(reportFile),
    origin: Number(elements["registration-origin"].value),
    caratMilli,
    ...details,
  };
}

function downloadAttestation(attestation) {
  const blob = new Blob([JSON.stringify(attestation, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `attestation-${attestation.input.inscriptionId}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("MetaMask or another injected Ethereum wallet was not found.");
  }

  const walletProvider = new BrowserProvider(window.ethereum);
  await walletProvider.send("eth_requestAccounts", []);
  const walletNetwork = await walletProvider.getNetwork();
  if (walletNetwork.chainId.toString() !== config.chainId.toString()) {
    throw new Error(
      `Your wallet is on chain ${walletNetwork.chainId}. Switch it to chain ${config.chainId}.`,
    );
  }

  walletSigner = await walletProvider.getSigner();
  walletAddress = await walletSigner.getAddress();
  walletRegistry = new Contract(config.contractAddress, config.abi, walletSigner);
  const [isLab, isCustodian, isAdmin] = await Promise.all([
    walletRegistry.hasRole(LAB_ROLE, walletAddress),
    walletRegistry.hasRole(CUSTODIAN_ROLE, walletAddress),
    walletRegistry.hasRole(ZeroHash, walletAddress),
  ]);
  walletIsCustodian = isCustodian;
  walletIsAdmin = isAdmin;

  elements["connect-wallet"].textContent = shortenAddress(walletAddress);
  elements["wallet-summary"].textContent = isLab && isCustodian
    ? `${shortenAddress(walletAddress)} is authorized as a lab and custodian.`
    : `${shortenAddress(walletAddress)} needs both LAB_ROLE and CUSTODIAN_ROLE.`;
  elements["registration-fields"].disabled = !(isLab && isCustodian);
  elements["relayer-fields"].disabled = false;
  elements["custody-fields"].disabled = false;
  elements["admin-fields"].disabled = !isAdmin;
  setRelayerMessage("Wallet ready. Load a signed attestation to validate it locally.", "success");
  setCustodyMessage(
    isCustodian
      ? "Wallet is authorized for custody. Load a record to see available actions."
      : "This wallet can inspect custody but cannot send or receive transfers.",
    isCustodian ? "success" : "error",
  );
  setAdminMessage(
    isAdmin
      ? "Administrator access confirmed."
      : "This wallet does not have the registry administrator role.",
    isAdmin ? "success" : "error",
  );
  setRegistrationMessage(
    isLab && isCustodian
      ? "Wallet ready. The registration transaction will require gas."
      : "This wallet is not authorized to register diamonds.",
    isLab && isCustodian ? "success" : "error",
  );
}

async function validateAttestation(attestation) {
  if (!attestation || typeof attestation !== "object" || !attestation.input) {
    throw new Error("This is not a Facet Ledger attestation file.");
  }
  if (String(attestation.chainId) !== String(config.chainId)) {
    throw new Error(`This attestation is for chain ${attestation.chainId}, not chain ${config.chainId}.`);
  }
  if (!isAddress(attestation.registry)
      || getAddress(attestation.registry) !== getAddress(config.contractAddress)) {
    throw new Error("This attestation was signed for a different registry contract.");
  }
  if (!isAddress(attestation.lab)) throw new Error("The attestation has an invalid laboratory address.");

  const input = attestation.input;
  if (!/^[A-Z0-9-]{1,64}$/.test(input.inscriptionId ?? "")) {
    throw new Error("The attestation has an invalid inscription.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.reportHash ?? "")) {
    throw new Error("The attestation has an invalid report hash.");
  }
  if (!Number.isInteger(input.origin) || input.origin < 0 || input.origin > 2) {
    throw new Error("The attestation has an invalid origin.");
  }
  if (!Number.isInteger(input.caratMilli)
      || input.caratMilli < 1 || input.caratMilli > 1_000_000) {
    throw new Error("The attestation has an invalid carat weight.");
  }
  for (const field of ["color", "clarity", "cut", "treatment"]) {
    if (typeof input[field] !== "string") {
      throw new Error(`The attestation has an invalid ${field} field.`);
    }
  }

  let nonce;
  let deadline;
  try {
    nonce = BigInt(attestation.nonce);
    deadline = BigInt(attestation.deadline);
  } catch {
    throw new Error("The attestation nonce or deadline is invalid.");
  }
  if (nonce < 0n || deadline < 0n || deadline > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The attestation nonce or deadline is out of range.");
  }
  if (typeof attestation.signature !== "string") {
    throw new Error("The attestation does not contain a signature.");
  }

  const lab = getAddress(attestation.lab);
  const domain = await eip712Domain(registry);
  const recovered = verifyTypedData(
    domain,
    REGISTRATION_TYPES,
    registrationValue(lab, input, nonce, deadline),
    attestation.signature,
  );
  if (getAddress(recovered) !== lab) {
    throw new Error("The signature does not match the laboratory address.");
  }

  const latestBlock = await provider.getBlock("latest");
  if (deadline <= BigInt(latestBlock.timestamp)) throw new Error("This attestation has expired.");
  const [used, isLab, isCustodian] = await Promise.all([
    registry.nonceUsed(lab, nonce),
    registry.hasRole(LAB_ROLE, lab),
    registry.hasRole(CUSTODIAN_ROLE, lab),
  ]);
  if (used) throw new Error("This attestation nonce has already been used or cancelled.");
  if (!isLab || !isCustodian) {
    throw new Error("The signer is no longer authorized as both a lab and custodian.");
  }

  return {
    ...attestation,
    lab,
    input,
    nonce,
    deadline,
  };
}

function addDefinition(list, term, value) {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = value || "Not stated";
  row.append(dt, dd);
  list.append(row);
}

function eventDescription(event) {
  switch (event.fragment.name) {
    case "DiamondRegistered":
      return {
        title: "Registered by laboratory",
        detail: `${event.args.inscriptionId} entered the registry`,
      };
    case "RegistrationRelayed":
      return {
        title: "Registration relayed",
        detail: `Submitted by ${shortenAddress(event.args.relayer)}`,
      };
    case "TransferAccepted":
      return {
        title: "Custody transferred",
        detail: `${shortenAddress(event.args.from)} → ${shortenAddress(event.args.to)}`,
      };
    case "StatusChanged":
      return {
        title: `Status changed to ${STATUSES[Number(event.args.status)]}`,
        detail: `${event.args.reason} · by ${shortenAddress(event.args.by)}`,
      };
    default:
      return { title: event.fragment.name, detail: "" };
  }
}

async function renderTimeline(events) {
  elements.timeline.replaceChildren();
  const blockNumbers = [...new Set(events.map((event) => event.blockNumber))];
  const blocks = new Map(await Promise.all(blockNumbers.map(async (blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    return [blockNumber, block];
  })));

  for (const event of events) {
    const item = document.createElement("li");
    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("p");
    const meta = document.createElement("time");
    const description = eventDescription(event);
    const block = blocks.get(event.blockNumber);

    title.textContent = description.title;
    detail.textContent = description.detail;
    meta.textContent = `${new Date(Number(block.timestamp) * 1000).toLocaleString()} · block ${event.blockNumber}`;
    content.append(title, detail, meta);
    item.append(marker, content);
    elements.timeline.append(item);
  }
}

async function verifyDiamond(lab, inscription) {
  const latestBlock = await provider.getBlockNumber();
  const id = await registry.findByInscription(lab, inscription);
  if (id === 0n) throw new Error("No record was found for this laboratory and inscription.");

  const diamond = await registry.getDiamond(id);
  const filters = [
    registry.filters.DiamondRegistered(id),
    registry.filters.DiamondDetails(id),
    registry.filters.RegistrationRelayed(id),
    registry.filters.TransferAccepted(id),
    registry.filters.StatusChanged(id),
  ];
  const eventGroups = await Promise.all(filters.map((filter) =>
    registry.queryFilter(filter, config.deploymentBlock, latestBlock)));
  const events = eventGroups.flat().sort((left, right) =>
    left.blockNumber - right.blockNumber || left.index - right.index);
  const registeredEvent = events.find((event) => event.fragment.name === "DiamondRegistered");
  const detailsEvent = events.find((event) => event.fragment.name === "DiamondDetails");

  elements["result-inscription"].textContent = registeredEvent?.args.inscriptionId ?? inscription;
  elements["record-status"].textContent = STATUSES[Number(diamond.status)];
  elements["record-status"].dataset.status = STATUSES[Number(diamond.status)].toLowerCase();
  elements["record-origin"].textContent = ORIGINS[Number(diamond.origin)];
  elements["record-carat"].textContent = `${(Number(diamond.caratMilli) / 1000).toFixed(3)} ct`;
  elements["record-date"].textContent = new Date(Number(diamond.registeredAt) * 1000).toLocaleDateString();
  elements["record-id"].textContent = `#${id}`;
  elements["record-lab"].textContent = diamond.lab;
  elements["record-custodian"].textContent = diamond.custodian;
  elements["record-report"].textContent = diamond.reportHash;
  elements.freshness.textContent = `Read through block ${latestBlock}`;

  elements["certificate-details"].replaceChildren();
  if (detailsEvent) {
    const details = {
      color: detailsEvent.args.color,
      clarity: detailsEvent.args.clarity,
      cut: detailsEvent.args.cut,
      treatment: detailsEvent.args.treatment,
    };
    addDefinition(elements["certificate-details"], "Color", details.color);
    addDefinition(elements["certificate-details"], "Clarity", details.clarity);
    addDefinition(elements["certificate-details"], "Cut", details.cut);
    addDefinition(elements["certificate-details"], "Treatment", details.treatment);
    const computedHash = TypedDataEncoder.hashStruct("Details", DETAILS_TYPES, details);
    const matches = computedHash === diamond.metadataHash;
    elements["metadata-check"].textContent = matches
      ? "✓ Details match the on-chain commitment"
      : "⚠ Details do not match the on-chain commitment";
    elements["metadata-check"].dataset.matches = String(matches);
  } else {
    elements["metadata-check"].textContent = "Certificate detail event was not found.";
    elements["metadata-check"].dataset.matches = "false";
  }

  await renderTimeline(events.filter((event) => event.fragment.name !== "DiamondDetails"));
  elements.result.hidden = false;
  elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function initialize() {
  try {
    const response = await fetch("/registry.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Run the frontend preparation command first.");
    config = await response.json();
    provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId));
    const connectedNetwork = await provider.getNetwork();
    if (connectedNetwork.chainId.toString() !== config.chainId.toString()) {
      throw new Error(`RPC returned chain ${connectedNetwork.chainId}; expected ${config.chainId}.`);
    }
    registry = new Contract(config.contractAddress, config.abi, provider);
    const latestBlock = await provider.getBlockNumber();
    elements["network-label"].textContent = `${config.network} · block ${latestBlock}`;
    elements["network-status"].dataset.connected = "true";
    elements["connect-wallet"].disabled = false;

    const parameters = new URLSearchParams(window.location.search);
    if (parameters.has("lab")) elements["lab-address"].value = parameters.get("lab");
    if (parameters.has("inscription")) {
      elements["inscription-id"].value = normalizeInscription(parameters.get("inscription"));
    }
  } catch (error) {
    elements["network-label"].textContent = "Registry unavailable";
    elements["configuration-error"].hidden = false;
    elements["configuration-message"].textContent = error.message;
    elements["verify-button"].disabled = true;
    elements["connect-wallet"].disabled = true;
  }
}

elements["connect-wallet"].addEventListener("click", async () => {
  elements["connect-wallet"].disabled = true;
  setRegistrationMessage("Waiting for wallet connection…");
  try {
    await connectWallet();
  } catch (error) {
    const message = readableError(error);
    setRegistrationMessage(message, "error");
    setRelayerMessage(message, "error");
    setCustodyMessage(message, "error");
    setAdminMessage(message, "error");
  } finally {
    elements["connect-wallet"].disabled = false;
  }
});

elements["report-file"].addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    elements["report-hash"].textContent = "The file is hashed locally and is not uploaded.";
    return;
  }

  try {
    elements["report-hash"].textContent = "Calculating report fingerprint…";
    const reportHash = await hashReport(file);
    elements["report-hash"].textContent = `Report hash: ${reportHash}`;
  } catch (error) {
    elements["report-hash"].textContent = readableError(error);
  }
});

elements["registration-inscription"].addEventListener("blur", (event) => {
  event.target.value = normalizeInscription(event.target.value);
});

elements["sign-attestation-button"].addEventListener("click", async () => {
  if (!walletRegistry || !walletSigner || !walletAddress) {
    setRegistrationMessage("Connect an authorized laboratory wallet first.", "error");
    return;
  }

  elements["sign-attestation-button"].disabled = true;
  elements["register-button"].disabled = true;
  try {
    setRegistrationMessage("Hashing the report and preparing the typed claim…");
    const input = await registrationInputFromForm();
    const domain = await eip712Domain(walletRegistry);
    const nonce = BigInt(hexlify(randomBytes(16)));
    const latestBlock = await provider.getBlock("latest");
    const deadline = BigInt(latestBlock.timestamp + 7 * 24 * 60 * 60);
    const value = registrationValue(walletAddress, input, nonce, deadline);

    setRegistrationMessage("Review and sign the structured claim in your wallet. This costs no gas.");
    const signature = await walletSigner.signTypedData(domain, REGISTRATION_TYPES, value);
    const attestation = {
      schemaVersion: 1,
      chainId: domain.chainId.toString(),
      registry: domain.verifyingContract,
      lab: walletAddress,
      input,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      signature,
    };
    downloadAttestation(attestation);
    setRegistrationMessage(
      "Signed attestation downloaded. It expires in seven days and can be given to a relayer.",
      "success",
    );
  } catch (error) {
    setRegistrationMessage(readableError(error), "error");
  } finally {
    elements["sign-attestation-button"].disabled = false;
    elements["register-button"].disabled = false;
  }
});

elements["direct-registration-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!walletRegistry || !walletAddress) {
    setRegistrationMessage("Connect an authorized laboratory wallet first.", "error");
    return;
  }

  elements["register-button"].disabled = true;
  elements["sign-attestation-button"].disabled = true;
  try {
    setRegistrationMessage("Hashing the report locally…");
    const claim = await registrationInputFromForm();

    setRegistrationMessage("Confirm the registration transaction in your wallet…");
    const transaction = await walletRegistry.registerDiamond(claim);
    setRegistrationMessage(`Transaction ${shortenAddress(transaction.hash)} submitted. Waiting for confirmation…`);
    await transaction.wait();

    elements["lab-address"].value = walletAddress;
    elements["inscription-id"].value = claim.inscriptionId;
    await verifyDiamond(walletAddress, claim.inscriptionId);
    setRegistrationMessage("Diamond registered and verified from the blockchain.", "success");
  } catch (error) {
    setRegistrationMessage(readableError(error), "error");
  } finally {
    elements["register-button"].disabled = false;
    elements["sign-attestation-button"].disabled = false;
  }
});

elements["attestation-file"].addEventListener("change", async (event) => {
  loadedAttestation = undefined;
  elements["relay-button"].disabled = true;
  elements["attestation-summary"].hidden = true;
  const [file] = event.target.files;
  if (!file) {
    setRelayerMessage("Choose an attestation JSON file.");
    return;
  }

  try {
    setRelayerMessage("Checking the signature, deadline, nonce, and laboratory roles…");
    const parsed = JSON.parse(await file.text());
    loadedAttestation = await validateAttestation(parsed);
    elements["attestation-lab"].textContent = loadedAttestation.lab;
    elements["attestation-inscription"].textContent = loadedAttestation.input.inscriptionId;
    elements["attestation-deadline"].textContent = new Date(
      Number(loadedAttestation.deadline) * 1000,
    ).toLocaleString();
    elements["attestation-summary"].hidden = false;
    elements["relay-button"].disabled = false;
    setRelayerMessage("Signature is valid and the attestation is ready to submit.", "success");
  } catch (error) {
    setRelayerMessage(readableError(error), "error");
  }
});

elements["relayer-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!walletRegistry || !walletAddress || !loadedAttestation) {
    setRelayerMessage("Connect a wallet and load a valid attestation first.", "error");
    return;
  }

  elements["relay-button"].disabled = true;
  try {
    setRelayerMessage("Rechecking the attestation before submission…");
    loadedAttestation = await validateAttestation(loadedAttestation);
    setRelayerMessage("Confirm the relayer transaction in your wallet…");
    const transaction = await walletRegistry.registerWithSignature(
      loadedAttestation.lab,
      loadedAttestation.input,
      loadedAttestation.nonce,
      loadedAttestation.deadline,
      loadedAttestation.signature,
    );
    setRelayerMessage(`Transaction ${shortenAddress(transaction.hash)} submitted. Waiting for confirmation…`);
    await transaction.wait();

    elements["lab-address"].value = loadedAttestation.lab;
    elements["inscription-id"].value = loadedAttestation.input.inscriptionId;
    await verifyDiamond(loadedAttestation.lab, loadedAttestation.input.inscriptionId);
    loadedAttestation = undefined;
    setRelayerMessage("Attestation submitted and verified from the blockchain.", "success");
  } catch (error) {
    setRelayerMessage(readableError(error), "error");
    elements["relay-button"].disabled = false;
  }
});

async function loadCustodyRecord(recordId = elements["custody-record-id"].value.trim()) {
  if (!/^\d+$/.test(String(recordId)) || BigInt(recordId) < 1n) {
    throw new Error("Enter a positive diamond record ID.");
  }

  const id = BigInt(recordId);
  const [diamond, pendingRecipient] = await Promise.all([
    registry.getDiamond(id),
    registry.pendingTo(id),
  ]);
  loadedCustodyId = id;
  elements["custody-record-id"].value = id.toString();
  elements["custody-status"].textContent = STATUSES[Number(diamond.status)];
  elements["custody-current"].textContent = diamond.custodian;
  elements["custody-pending"].textContent = pendingRecipient === ZeroAddress
    ? "No pending proposal"
    : pendingRecipient;
  elements["custody-record"].hidden = false;

  const active = Number(diamond.status) === 0;
  const hasProposal = pendingRecipient !== ZeroAddress;
  const isCurrentCustodian = diamond.custodian.toLowerCase() === walletAddress.toLowerCase();
  const isPendingRecipient = hasProposal
    && pendingRecipient.toLowerCase() === walletAddress.toLowerCase();

  elements["proposal-form"].hidden = !(
    active && isCurrentCustodian && walletIsCustodian && !hasProposal
  );
  elements["cancel-transfer-button"].hidden = !(isCurrentCustodian && hasProposal);
  elements["accept-transfer-button"].hidden = !(
    active && isPendingRecipient && walletIsCustodian
  );
  elements["reject-transfer-button"].hidden = !isPendingRecipient;

  if (!active) {
    setCustodyMessage(`Record #${id} is ${STATUSES[Number(diamond.status)].toLowerCase()}, so transfers are frozen.`);
  } else if (isPendingRecipient) {
    setCustodyMessage("This wallet is the proposed recipient. Accept to take custody or reject to decline.");
  } else if (isCurrentCustodian && hasProposal) {
    setCustodyMessage("A transfer is awaiting the recipient. You may cancel it before acceptance.");
  } else if (isCurrentCustodian && walletIsCustodian) {
    setCustodyMessage("This wallet holds the diamond and may propose a transfer.", "success");
  } else {
    setCustodyMessage("This wallet has no action for the current custody state.");
  }
}

async function runCustodyTransaction(pendingMessage, transactionFactory) {
  const actionButtons = [
    "load-custody-button", "propose-transfer-button", "cancel-transfer-button",
    "reject-transfer-button", "accept-transfer-button",
  ].map((id) => elements[id]);
  actionButtons.forEach((button) => { button.disabled = true; });
  try {
    setCustodyMessage(`${pendingMessage} Confirm it in your wallet…`);
    const transaction = await transactionFactory();
    setCustodyMessage(`Transaction ${shortenAddress(transaction.hash)} submitted. Waiting for confirmation…`);
    await transaction.wait();
    await loadCustodyRecord(loadedCustodyId);
    setCustodyMessage("Custody state updated from the blockchain.", "success");
  } catch (error) {
    setCustodyMessage(readableError(error), "error");
  } finally {
    actionButtons.forEach((button) => { button.disabled = false; });
  }
}

elements["custody-load-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!walletRegistry || !walletAddress) {
    setCustodyMessage("Connect a wallet first.", "error");
    return;
  }

  elements["load-custody-button"].disabled = true;
  elements["custody-record"].hidden = true;
  try {
    setCustodyMessage("Reading the current custody state…");
    await loadCustodyRecord();
  } catch (error) {
    loadedCustodyId = undefined;
    setCustodyMessage(readableError(error), "error");
  } finally {
    elements["load-custody-button"].disabled = false;
  }
});

elements["proposal-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const recipientInput = elements["custody-recipient"].value.trim();
  if (!isAddress(recipientInput)) {
    setCustodyMessage("Enter a valid recipient address.", "error");
    return;
  }
  const recipient = getAddress(recipientInput);
  if (recipient === walletAddress) {
    setCustodyMessage("The recipient must be a different wallet.", "error");
    return;
  }
  if (!await registry.hasRole(CUSTODIAN_ROLE, recipient)) {
    setCustodyMessage("The recipient does not have CUSTODIAN_ROLE.", "error");
    return;
  }
  await runCustodyTransaction(
    "Proposing the transfer.",
    () => walletRegistry.proposeTransfer(loadedCustodyId, recipient),
  );
});

elements["cancel-transfer-button"].addEventListener("click", () => runCustodyTransaction(
  "Cancelling the transfer proposal.",
  () => walletRegistry.cancelTransfer(loadedCustodyId),
));

elements["reject-transfer-button"].addEventListener("click", () => runCustodyTransaction(
  "Rejecting the transfer proposal.",
  () => walletRegistry.rejectTransfer(loadedCustodyId),
));

elements["accept-transfer-button"].addEventListener("click", () => runCustodyTransaction(
  "Accepting custody.",
  () => walletRegistry.acceptTransfer(loadedCustodyId),
));

function selectedRole() {
  return elements["role-type"].value === "lab" ? LAB_ROLE : CUSTODIAN_ROLE;
}

function selectedRoleLabel() {
  return elements["role-type"].value === "lab" ? "Laboratory" : "Custodian";
}

async function runRoleTransaction(grant) {
  if (!walletRegistry || !walletIsAdmin) {
    setRoleMessage("Connect an administrator wallet first.", "error");
    return;
  }
  const addressInput = elements["role-address"].value.trim();
  if (!isAddress(addressInput)) {
    setRoleMessage("Enter a valid wallet address.", "error");
    return;
  }

  const account = getAddress(addressInput);
  const role = selectedRole();
  const label = selectedRoleLabel();
  elements["grant-role-button"].disabled = true;
  elements["revoke-role-button"].disabled = true;
  try {
    const alreadyHasRole = await registry.hasRole(role, account);
    if (grant && alreadyHasRole) throw new Error(`This wallet already has the ${label} role.`);
    if (!grant && !alreadyHasRole) throw new Error(`This wallet does not have the ${label} role.`);

    setRoleMessage(`${grant ? "Granting" : "Revoking"} the ${label} role. Confirm in your wallet…`);
    const transaction = grant
      ? await walletRegistry.grantRole(role, account)
      : await walletRegistry.revokeRole(role, account);
    setRoleMessage(`Transaction ${shortenAddress(transaction.hash)} submitted. Waiting for confirmation…`);
    await transaction.wait();
    const suffix = grant && role === LAB_ROLE
      ? " A lab also needs the Custodian role before it can register diamonds."
      : "";
    setRoleMessage(`${label} role ${grant ? "granted" : "revoked"}.${suffix}`, "success");
  } catch (error) {
    setRoleMessage(readableError(error), "error");
  } finally {
    elements["grant-role-button"].disabled = false;
    elements["revoke-role-button"].disabled = false;
  }
}

elements["role-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  await runRoleTransaction(true);
});

elements["revoke-role-button"].addEventListener("click", () => runRoleTransaction(false));

async function loadAdminRecord(recordId = elements["admin-record-id"].value.trim()) {
  if (!/^\d+$/.test(String(recordId)) || BigInt(recordId) < 1n) {
    throw new Error("Enter a positive diamond record ID.");
  }
  const id = BigInt(recordId);
  const diamond = await registry.getDiamond(id);
  const status = Number(diamond.status);
  loadedAdminRecordId = id;
  elements["admin-record-id"].value = id.toString();
  elements["admin-record-status"].textContent = STATUSES[status];
  elements["admin-record-lab"].textContent = diamond.lab;
  elements["admin-record-summary"].hidden = false;
  elements["quarantine-button"].hidden = status !== 0;
  elements["resolve-button"].hidden = status !== 1;
  elements["revoke-record-button"].hidden = status !== 1;

  if (status === 0) {
    setAdminRecordMessage("The record is active. An admin may quarantine it with a reason.");
  } else if (status === 1) {
    setAdminRecordMessage("The record is quarantined. Resolve it or revoke it permanently.");
  } else {
    setAdminRecordMessage("This record is permanently revoked. No further status change is allowed.");
  }
}

elements["admin-record-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!walletRegistry || !walletIsAdmin) {
    setAdminRecordMessage("Connect an administrator wallet first.", "error");
    return;
  }
  elements["load-admin-record-button"].disabled = true;
  elements["admin-record-summary"].hidden = true;
  try {
    setAdminRecordMessage("Reading the record status…");
    await loadAdminRecord();
  } catch (error) {
    loadedAdminRecordId = undefined;
    setAdminRecordMessage(readableError(error), "error");
  } finally {
    elements["load-admin-record-button"].disabled = false;
  }
});

async function runAdminRecordTransaction(action) {
  if (!walletRegistry || !walletIsAdmin || !loadedAdminRecordId) {
    setAdminRecordMessage("Load a record with an administrator wallet first.", "error");
    return;
  }
  const reason = elements["admin-reason"].value.trim();
  if (!reason) {
    setAdminRecordMessage("Enter a reason for the status change.", "error");
    return;
  }

  const actions = {
    quarantine: {
      pending: "Quarantining the record.",
      send: () => walletRegistry.quarantine(loadedAdminRecordId, reason),
    },
    resolve: {
      pending: "Resolving the quarantine.",
      send: () => walletRegistry.resolveQuarantine(loadedAdminRecordId, reason),
    },
    revoke: {
      pending: "Permanently revoking the record.",
      send: () => walletRegistry.revokeRecord(loadedAdminRecordId, reason),
    },
  };
  const selected = actions[action];
  const buttons = ["load-admin-record-button", "quarantine-button", "resolve-button", "revoke-record-button"]
    .map((id) => elements[id]);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    setAdminRecordMessage(`${selected.pending} Confirm in your wallet…`);
    const transaction = await selected.send();
    setAdminRecordMessage(`Transaction ${shortenAddress(transaction.hash)} submitted. Waiting for confirmation…`);
    await transaction.wait();
    elements["admin-reason"].value = "";
    await loadAdminRecord(loadedAdminRecordId);
    setAdminRecordMessage("Record status updated from the blockchain.", "success");
  } catch (error) {
    setAdminRecordMessage(readableError(error), "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

elements["quarantine-button"].addEventListener("click", () => runAdminRecordTransaction("quarantine"));
elements["resolve-button"].addEventListener("click", () => runAdminRecordTransaction("resolve"));
elements["revoke-record-button"].addEventListener("click", () => runAdminRecordTransaction("revoke"));

elements["inscription-id"].addEventListener("blur", (event) => {
  event.target.value = normalizeInscription(event.target.value);
});

elements["verify-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const labInput = elements["lab-address"].value.trim();
  const inscription = normalizeInscription(elements["inscription-id"].value);
  elements["inscription-id"].value = inscription;
  elements.result.hidden = true;

  if (!isAddress(labInput)) {
    setMessage("Enter a valid Ethereum laboratory address.", "error");
    return;
  }
  if (!/^[A-Z0-9-]{1,64}$/.test(inscription)) {
    setMessage("The inscription may contain only A–Z, 0–9, and hyphens.", "error");
    return;
  }

  elements["verify-button"].disabled = true;
  setMessage("Reading the registry and reconstructing its history…");
  try {
    const lab = getAddress(labInput);
    await verifyDiamond(lab, inscription);
    const url = new URL(window.location.href);
    url.searchParams.set("lab", lab);
    url.searchParams.set("inscription", inscription);
    window.history.replaceState({}, "", url);
    setMessage("Record verified from the blockchain.", "success");
  } catch (error) {
    setMessage(readableError(error), "error");
  } finally {
    elements["verify-button"].disabled = false;
  }
});

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

initialize();
